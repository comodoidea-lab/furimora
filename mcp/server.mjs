#!/usr/bin/env node
/**
 * フリモーラ MCP サーバー（stdio）
 *
 * UI と同じ内部処理を AI エージェントへ公開する。
 * 取得ロジックはここに書かない。すべて ../public/js/clone-service.js に着地する。
 *
 * 役割分担:
 *   人間の導線         = Chrome 拡張 / URL貼り付け / クリップボード / 共有シート
 *   エージェントの導線 = このサーバー（url を引数で受け取る）
 *
 * セキュリティ:
 *   - stdio トランスポートのみ。ネットワークを一切 listen しない
 *     （MCP クライアントが子プロセスとして起動し、stdin/stdout でだけ会話する）
 *   - 認証情報を扱わない。メルカリへのログインもしない
 *   - ログは stderr に出す。商品データや引数の中身は出さない
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { createCloneService, createInternalApi } from '../public/js/clone-service.js';
import { BrowserService, DEFAULT_PROFILE_DIR } from './src/browser-service.mjs';
import { MercariService, LISTING_TABS, SELECTORS, parseCategoryPath, normalizeCategoryPath, conditionFromLabel } from './src/mercari-service.mjs';
import { reconcileListings } from '../public/js/reconcile.js';
import { callApp, appIsRunning, readJsonArrayFromApp, SOCKET_PATH as APP_SOCKET } from './src/furimora-app-client.mjs';
import { FurimoraService, assertConditionLabel, CONDITION_LABELS } from './src/furimora-service.mjs';
import { selectDraft } from './src/draft-select.mjs';
import {
  parseMercariItemId, findExistingItem, findDraftForItem, planRegistration, planPending,
  findAdoptionCandidates, choosePending, estimateProfit, chooseShippingMethod, verifyRegisteredItem,
} from './src/inventory-register.mjs';
import { ElectronBrowserService } from './src/electron-browser-service.mjs';
import fs from 'node:fs';

const API_ORIGIN = process.env.FURIMORA_API_ORIGIN || 'https://furimora.vercel.app';
const FALLBACK_ORIGINS = ['https://furimora-assist.vercel.app'];
const ORIGINS = [API_ORIGIN, ...FALLBACK_ORIGINS.filter((o) => o !== API_ORIGIN)];

const service = createCloneService({ apiOrigins: ORIGINS });
const api = createInternalApi(service);

/** 内部 API の戻り値を MCP のレスポンスへ変換する。ここに業務ロジックは書かない。 */
function toToolResult(result) {
  if (!result || result.ok !== true) {
    const code = (result && result.code) || 'UNKNOWN';
    const message = (result && result.message) || '不明なエラー';
    return { isError: true, content: [{ type: 'text', text: `エラー [${code}] ${message}` }] };
  }
  const payload = result.completeness
    ? { data: result.data, completeness: result.completeness }
    : { data: result.data };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: 'furimora', version: '0.1.0' });

const URL_ARG = z
  .string()
  .describe('メルカリの商品URL（https://jp.mercari.com/item/m… または merc.li の短縮URL）。URLを含む共有文をそのまま渡してもよい');

server.registerTool(
  'mercari_get_item',
  {
    title: 'メルカリ商品情報を取得',
    description:
      'メルカリの商品URLから商品情報を取得する。タイトル・価格・説明文・カテゴリ・商品状態・送料負担・配送方法・発送元・発送日数・画像URL一覧を返す。閲覧のみで、出品やアカウント操作は行わない。',
    inputSchema: { url: URL_ARG },
  },
  async ({ url }) => toToolResult(await api.call('mercari.getItem', { url }))
);

server.registerTool(
  'mercari_create_clone_data',
  {
    title: 'クローン用データを作成',
    description:
      'メルカリの商品URLから、フリモーラのクローン出品に必要なデータ一式を組み立てる。mercari_get_item との違いは、欠損項目を補完したうえで充足度（何項目埋まったか）を返すこと。実際の出品は行わない。',
    inputSchema: { url: URL_ARG },
  },
  async ({ url }) => toToolResult(await api.call('mercari.createCloneData', { url }))
);

server.registerTool(
  'mercari_extract_url',
  {
    title: '共有文から商品URLを抽出',
    description:
      'クリップボードの中身や共有文などのテキストから、メルカリの商品URLだけを抜き出す。人からテキストを受け取ったときの前処理に使う。',
    inputSchema: {
      text: z.string().describe('メルカリの商品URLを含みうるテキスト（共有文やクリップボードの中身など）'),
    },
  },
  async ({ text }) => toToolResult(await api.call('mercari.extractUrl', { text }))
);

server.registerTool(
  'furimora_status',
  {
    title: 'フリモーラAPIの疎通確認',
    description:
      'フリモーラのバックエンド（/api/health）に到達できるかを確認する。商品取得が失敗するときの切り分けに使う。',
    inputSchema: {},
  },
  async () => {
    const checks = [];
    for (const origin of ORIGINS) {
      try {
        const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        checks.push({ origin, ok: res.ok && body?.ok === true, status: res.status });
      } catch (e) {
        checks.push({ origin, ok: false, error: String((e && e.message) || e) });
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(
          { server: 'furimora-mcp 0.1.0', transport: 'stdio', operations: api.list(), checks },
          null, 2
        ),
      }],
    };
  }
);

/**
 * 認証が要る操作は専用プロファイルの Chrome を都度起動して閉じる。
 * ログインセッションは userDataDir に永続するので、初回ログイン以降は再利用される。
 * 例外が出ても必ず閉じる（子プロセスを残さない）。
 */
server.registerTool(
  'furimora_app_status',
  {
    title: 'フリモーラ Desktop の状態',
    description:
      'フリモーラ Desktop（Electron）が起動しているかを返す（読み取りのみ）。' +
      '起動していれば backup_path なしで下書き・在庫を読める。作業の頭で呼ぶと切り分けが早い。',
    inputSchema: {},
  },
  async () => {
    try {
      const info = await callApp('ping', {}, { timeoutMs: 3000 });
      let auth = null;
      try { auth = await callApp('auth_state', {}, { timeoutMs: 5000 }); } catch { /* ウィンドウが閉じている */ }
      return { content: [{ type: 'text', text: JSON.stringify({ running: true, socket: APP_SOCKET, mercariBackend: await resolveBackend(), ...info, auth }, null, 2) }] };
    } catch (e) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            running: false, socket: APP_SOCKET,
            code: e?.code || 'APP_ERROR',
            message: String((e && e.message) || e),
            hint: 'cd electron && npm start で起動する。起動していなくても backup_path 経由なら動く',
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * メルカリ操作のブラウザ backend を決める。
 *
 * | FURIMORA_BROWSER | 挙動 |
 * |---|---|
 * | 未設定（既定） | Desktop が起動していれば electron、していなければ playwright |
 * | `electron`     | 常に Electron（起動していなければ失敗する） |
 * | `playwright`   | 常に外部 Chrome。**切り戻しはこれ** |
 *
 * **Desktop 未起動でも動く形にしてある。** Electron が無いと何もできない道具にすると、
 * 起動し忘れた日に全部止まる。起動していれば速くて静かなほう、していなければ従来どおり。
 *
 * 起動判定は 1 プロセス内で 1 回だけ行う（MCP サーバーはコマンドごとに使い捨てなので、
 * 1 コマンドの途中で backend が入れ替わることはない）。
 */
const BROWSER_PREF = process.env.FURIMORA_BROWSER || 'auto';
let cachedBackend = null;
async function resolveBackend() {
  if (BROWSER_PREF === 'electron' || BROWSER_PREF === 'playwright') return BROWSER_PREF;
  if (cachedBackend) return cachedBackend;
  cachedBackend = (await appIsRunning()) ? 'electron' : 'playwright';
  return cachedBackend;
}

async function withMercari(fn, { headless = true } = {}) {
  const backend = await resolveBackend();
  const browser = backend === 'electron'
    ? new ElectronBrowserService(callApp)
    : new BrowserService({ headless });
  try {
    await browser.startBrowser();
    // Electron backend では非表示ウィンドウが既定。ログイン等で見せる必要があるときだけ出す
    if (backend === 'electron' && !headless) await browser.showWindow(true);
    return await fn(new MercariService(browser), browser);
  } finally {
    await browser.stopBrowser();
  }
}

server.registerTool(
  'mercari_check_login',
  {
    title: 'メルカリのログイン状態を確認',
    description:
      'フリモーラ専用のブラウザプロファイルがメルカリにログイン済みかを確認する。読み取りのみ。未ログインなら mercari_login を案内する。',
    inputSchema: {},
  },
  async () => {
    try {
      const r = await withMercari((mercari) => mercari.checkLogin());
      const backend = await resolveBackend();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            loggedIn: r.loggedIn,
            backend,
            // Electron backend では Chrome のプロファイルを使わない。嘘の値を出さない
            profileDir: backend === 'electron' ? null : DEFAULT_PROFILE_DIR,
            sessionPartition: backend === 'electron' ? 'persist:furimora' : null,
            hint: r.loggedIn ? null : 'mercari_login を実行するとブラウザが開くので、そこで一度ログインしてください（2段階認証は人が通す必要があります）',
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'mercari_login',
  {
    title: 'メルカリへログインするウィンドウを開く',
    description:
      'フリモーラ専用プロファイルのブラウザを画面つきで起動し、メルカリのログインページを開く。認証情報の入力は人間が行う（このツールは入力しない）。ログイン後はセッションがプロファイルに保存され、以降の取得で再利用される。',
    inputSchema: {
      wait_seconds: z.number().int().min(30).max(600).default(180)
        .describe('ログイン完了を待つ秒数。既定 180 秒'),
    },
  },
  async ({ wait_seconds }) => {
    // Electron backend では非表示ウィンドウを一時的に見せる（別プロセスの Chrome は起動しない）
    const backend = await resolveBackend();
    const browser = backend === 'electron'
      ? new ElectronBrowserService(callApp)
      : new BrowserService({ headless: false });
    try {
      await browser.startBrowser();
      if (backend === 'electron') await browser.showWindow(true);
      const mercari = new MercariService(browser);
      await browser.openPage('https://jp.mercari.com/login');
      const deadline = Date.now() + wait_seconds * 1000;
      let loggedIn = false;
      // **待機中は遷移しない。** checkLogin() は先頭で openPage() するので、
      // ここから呼ぶと入力中のページを 3 秒おきに引きずって入力できなくなる（実際に踏んだ）
      // 認証ページを抜けた状態が続いたら「人間の操作が終わった」とみなす。
      // 遷移の一瞬だけ抜けて見えることがあるので、連続 3 回（約 6 秒）安定してから確定させる
      let offAuth = 0;
      while (Date.now() < deadline) {
        await browser.waitForTimeout(2000);
        let st = null;
        try { st = await mercari.probeLoginState(); } catch { /* 遷移中。次の周回で見る */ }
        if (!st) { offAuth = 0; continue; }
        if (st.hasSideMenu && !st.onAuthPage) { loggedIn = true; break; }
        offAuth = st.onAuthPage ? 0 : offAuth + 1;
        if (offAuth >= 3) { loggedIn = true; break; }
      }
      // 確定はここで 1 回だけ。人間の操作が終わってから遷移する
      if (loggedIn) {
        try { loggedIn = (await mercari.checkLogin()).loggedIn; } catch { /* 判定できず。下で false のまま返す */ }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            loggedIn,
            backend,
            // Electron backend では Chrome のプロファイルを使わない。嘘の値を出さない
            profileDir: backend === 'electron' ? null : DEFAULT_PROFILE_DIR,
            sessionPartition: backend === 'electron' ? 'persist:furimora' : null,
            note: loggedIn ? 'ログイン済み。セッションはプロファイルに保存されました。' : '時間内にログインが確認できませんでした。もう一度実行してください。',
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    } finally {
      await browser.stopBrowser();
    }
  }
);

server.registerTool(
  'mercari_get_my_listings',
  {
    title: '自分の出品一覧を取得',
    description:
      '自分がメルカリに出している商品の一覧を取得する（読み取りのみ。出品や価格変更は行わない）。' +
      'タブは active=出品中 / in_progress=取引中 / sold=売却済み / history=販売履歴。' +
      'フリモーラの在庫データと突き合わせて、売却済みの取りこぼしや価格のズレを検出するのに使う。',
    inputSchema: {
      tab: z.enum(['active', 'in_progress', 'sold', 'history']).default('active')
        .describe('取得するタブ。既定は active（出品中）'),
      max_items: z.number().int().min(1).max(2000).default(1000)
        .describe('取得の上限件数。既定 1000'),
    },
  },
  async ({ tab, max_items }) => {
    try {
      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.getMyListings({ tab, maxItems: max_items });
      });
      if (r.needsLogin) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            tab: r.tab, tabLabel: r.tabLabel, count: r.count,
            truncated: r.truncated, exitReason: r.exitReason, loadMoreClicks: r.loadMoreClicks, elapsedMs: r.elapsedMs,
            items: r.items,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

/**
 * フリモーラのバックアップ JSON から「フリモーラの下書き」を取り出す。
 *
 * 下書きは PWA の localStorage（キー `furimora_drafts`）にあり、
 * MCP サーバー（Node）からは直接読めない。バックアップ JSON 経由で受け渡す。
 * これは在庫データ（furimora_items）と同じ制約・同じ回避策。
 */
function draftsFromBackupFile(filePath) {
  const root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const raw = root?.data?.furimora_drafts;
  if (raw == null) throw new Error('バックアップに furimora_drafts が含まれていません');
  const drafts = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(drafts)) throw new Error('furimora_drafts が配列ではありません');
  return drafts;
}

/**
 * 下書きの取得元を決める。
 *
 * **フリモーラ Desktop（Electron）が起動していれば、そこから直接読む。**
 * 起動していなければ従来どおりバックアップ JSON を使う。
 * backup_path が明示されたときは、そちらを優先する（再現性のため）。
 */
async function resolveDrafts(backupPath) {
  if (backupPath) return { drafts: draftsFromBackupFile(backupPath), source: 'backup', backupPath };
  try {
    return { drafts: await readJsonArrayFromApp('furimora_drafts'), source: 'app' };
  } catch (e) {
    const hint = e?.code === 'APP_NOT_RUNNING'
      ? 'フリモーラ Desktop（electron/）を起動するか、backup_path を渡してください'
      : String((e && e.message) || e);
    throw new Error(`下書きを取得できません: ${hint}`);
  }
}

/** フリモーラのバックアップ JSON から在庫アイテム配列を取り出す */
function itemsFromBackupFile(filePath) {
  const root = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const raw = root?.data?.furimora_items;
  if (raw == null) throw new Error('バックアップに furimora_items が含まれていません');
  const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(items)) throw new Error('furimora_items が配列ではありません');
  return items;
}

server.registerTool(
  'furimora_reconcile_listings',
  {
    title: '在庫とメルカリの出品を突き合わせる',
    description:
      'フリモーラの在庫データとメルカリの実際の出品を突き合わせ、ズレを検出する（読み取りのみ。何も変更しない）。' +
      '主目的は「メルカリでは売れているのに手元では出品中のまま」の検出。' +
      'ほかに価格のズレ、メルカリから消えた商品、再出品したのに売却済みのままの商品、手元に無い出品も返す。' +
      '**フリモーラ Desktop（electron/）が起動していれば、どちらも渡さなくてよい**（localStorage から直接読む）。' +
      '起動していない場合は backup_path（設定画面の「バックアップをダウンロード」で保存した JSON）か app_items で渡す。',
    inputSchema: {
      backup_path: z.string().optional()
        .describe('フリモーラのバックアップ JSON のパス。app_items を渡す場合は不要'),
      app_items: z.array(z.record(z.string(), z.any())).optional()
        .describe('在庫アイテムの配列。backup_path を渡す場合は不要'),
      max_items: z.number().int().min(1).max(2000).default(1000)
        .describe('メルカリ側の取得上限。既定 1000'),
      price_tolerance: z.number().int().min(0).default(0)
        .describe('価格差をズレとみなさない許容額。既定 0'),
    },
  },
  async ({ backup_path, app_items, max_items, price_tolerance }) => {
    try {
      let local;
      let localSource;
      if (Array.isArray(app_items) && app_items.length) { local = app_items; localSource = 'app_items'; }
      else if (backup_path) { local = itemsFromBackupFile(backup_path); localSource = 'backup'; }
      else {
        // どちらも無ければ、起動中のフリモーラ Desktop から直接読む（下書きと同じ扱い）
        try { local = await readJsonArrayFromApp('furimora_items'); localSource = 'app'; }
        catch (e) {
          const hint = e?.code === 'APP_NOT_RUNNING'
            ? 'フリモーラ Desktop（electron/）を起動するか、backup_path か app_items を渡してください'
            : String((e && e.message) || e);
          return { isError: true, content: [{ type: 'text', text: `エラー [BAD_PARAMS] 在庫データを取得できません: ${hint}` }] };
        }
      }

      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        const active = await mercari.getMyListings({ tab: 'active', maxItems: max_items });
        const sold = await mercari.getMyListings({ tab: 'sold', maxItems: max_items });
        return { active, sold };
      });
      if (r.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }

      const report = reconcileListings({
        local,
        remoteActive: r.active.items,
        remoteSold: r.sold.items,
        remoteTruncated: r.active.truncated || r.sold.truncated,
        priceTolerance: price_tolerance,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            在庫データの取得元: localSource,
            summary: report.summary,
            取得時間ms: { 出品中: r.active.elapsedMs, 売却済み: r.sold.elapsedMs },
            売れているのに出品中のまま: report.soldButActive,
            価格がズレている: report.priceMismatch,
            メルカリから消えている: report.missingRemotely,
            再出品したのに売却済みのまま: report.relistedButSold,
            手元に無い出品: report.missingLocally,
            メルカリID未設定: report.unlinked,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [RECONCILE] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'mercari_update_price',
  {
    title: 'メルカリの出品価格を変更',
    description:
      '**単発の手動変更用。定期・一括の値下げは mercari-relist-batch の price_cut_one.mjs が正規の経路。** ' +
      'あちらは在庫カードのクリックで開いたタブしか使わない（route provenance）が、こちらは itemId から URL を組み立てて開くため経路の証明が無い。' +
      '自分の出品 1 件の価格を変更する。**既定は確認のみ（dry_run=true）で、実際には変更しない。** ' +
      '確認モードでは現在価格・新価格・差額・手数料と利益の見積りを返す。' +
      '実際に変更するには dry_run に false を明示的に指定する。' +
      '1 回の呼び出しで変更できるのは 1 商品だけ。削除や出品停止は行わない。' +
      '**書き込み時（dry_run:false）は expected_title が必須。** 開いた先が意図した商品かを確かめずに価格を書き換えない' +
      '（姉妹プロジェクトはこの検証を欠いた経路で 24 件を落としている）。',
    inputSchema: {
      item_id: z.string().regex(/^m\d{9,}$/, 'm から始まる商品IDを指定してください')
        .describe('メルカリの商品ID（例: m12345678901）'),
      new_price: z.number().int().min(300).max(9999999)
        .describe('新しい価格（円・整数）'),
      dry_run: z.boolean().default(true)
        .describe('true（既定）は確認のみで何も変更しない。実際に変更する場合だけ false を指定する'),
      expected_title: z.string().optional()
        .describe('期待する商品名。**dry_run:false のときは必須。** 編集ページの商品名と照合し、外れたら MISMATCH で停止する。まず dry_run で実際の商品名を確認し、それを渡す'),
      expected_current_price: z.number().int().positive().optional()
        .describe('期待する変更前の価格。渡すと価格欄の現在値と完全一致を要求し、外れたら MISMATCH で停止する'),
      min_price: z.number().int().min(0).optional()
        .describe('下回ってはいけない価格。指定するとこれを下回る変更を拒否する'),
    },
  },
  async ({ item_id, new_price, dry_run, min_price, expected_title, expected_current_price }) => {
    try {
      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.updatePrice({
          itemId: item_id, newPrice: new_price,
          dryRun: dry_run !== false, minPrice: min_price ?? null,
          expectedTitle: expected_title ?? null,
          expectedCurrentPrice: expected_current_price ?? null,
        });
      });
      if (r.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }
      if (!r.ok) {
        return { isError: true, content: [{ type: 'text', text: `エラー [${r.code}] ${r.message}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'furimora_list_drafts',
  {
    title: 'フリモーラの下書き一覧',
    description:
      'フリモーラ（PWA）のクローン機能で作った下書きの一覧を返す（読み取りのみ）。' +
      '**フリモーラ Desktop（electron/）が起動していれば backup_path は不要**で、localStorage から直接読む。' +
      '起動していない場合のみ、設定画面の「バックアップをダウンロード」で保存した JSON のパスを渡す。' +
      'ここで選んだ下書きを mercari_prepare_draft_from_furimora_draft に渡す。',
    inputSchema: {
      backup_path: z.string().optional()
        .describe('フリモーラのバックアップ JSON のパス。Desktop が起動していれば省略できる'),
    },
  },
  async ({ backup_path }) => {
    try {
      const { drafts, source } = await resolveDrafts(backup_path);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            source,
            count: drafts.length,
            drafts: drafts.map((d, index) => ({
              index, id: d.id ?? null, title: d.title ?? null, price: d.price ?? null,
              category: d.category ?? null, condition: d.condition ?? null,
              shippingMethod: d.shippingMethod ?? null,
              sourceUrl: d.url ?? null, createdAt: d.createdAt ?? null,
              imageCount: Array.isArray(d.images) ? d.images.length : 0,
            })),
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BACKUP] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'furimora_create_draft',
  {
    title: 'フリモーラの下書きを作る（①）',
    description:
      '商品URLからフリモーラの下書きを作る。**フリモーラ Desktop（electron/）の起動が必要。**' +
      'クローン作成画面をアプリ自身の保存経路（createClone）で駆動するので、統計・アクティビティ・同期も正しく更新される。' +
      '**dry_run の既定は true。** 確認モードではフォームを埋めるところまで行い、保存はしない。' +
      '価格・商品の状態は人間が確定させること（複製元の値をそのまま使わない。複製元自体が間違っていることがある）。',
    inputSchema: {
      url: z.string().describe('クローン元のメルカリ商品URL'),
      price: z.number().int().positive().describe('出品価格。**複製元の価格をそのまま使わない**'),
      condition: z.string().describe(`商品の状態。次のいずれか: ${CONDITION_LABELS.join(' / ')}`),
      shipping_method: z.string().optional()
        .describe('配送の方法。省略すると複製元の値のまま（実物のサイズと重さで判断し直すこと）'),
      dry_run: z.boolean().default(true).describe('true（既定）なら保存しない。実際に作るときだけ false'),
    },
  },
  async ({ url, price, condition, shipping_method, dry_run = true }) => {
    const fail = (code, message, extra) => ({
      isError: true,
      content: [{ type: 'text', text: `エラー [${code}] ${message}` + (extra ? '\n' + JSON.stringify(extra, null, 2) : '') }],
    });
    try {
      assertConditionLabel(condition);
    } catch (e) {
      return fail('BAD_CONDITION', String((e && e.message) || e));
    }
    try {
      const svc = new FurimoraService(callApp);

      const opened = await svc.openCloneScreen(url);
      if (!opened.ok) return fail(opened.code, opened.message);

      const got = await svc.fetchSource();
      if (!got.ok) return fail(got.code, got.message);

      const applied = await svc.applyDecisions({ price, condition, shippingMethod: shipping_method });
      if (!applied.ok) return fail(applied.code, applied.message);

      const needsHuman = [];
      if (!shipping_method) {
        needsHuman.push(`配送の方法は複製元のまま（${got.fetched.shippingMethod ?? '不明'}）。実物のサイズと重さで判断し直すこと`);
      }
      if (got.fetched.sourcePrice != null && Number(got.fetched.sourcePrice) !== price) {
        needsHuman.push(`複製元の価格は ¥${got.fetched.sourcePrice}。今回は ¥${price} で作る`);
      }
      needsHuman.push('発送元・発送日数は変更していない（複製元自体が誤っていることがある）');

      const plan = { source: got.fetched, decided: applied.current, needsHuman };

      if (dry_run) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true, saved: false, dryRun: true, plan,
              note: '確認のみです。フリモーラには何も保存していません（createClone を押していないので自動保存も起きません）。実際に作るには dry_run を false にしてください。',
            }, null, 2),
          }],
        };
      }

      const res = await svc.save();
      if (!res.ok) return fail(res.code, res.message, plan);

      const saved = res.saved || {};
      const bad = [];
      if (saved.price != null && String(saved.price) !== String(price)) bad.push(`価格（期待 ${price} / 実際 ${saved.price}）`);
      if (saved.condition && saved.condition !== condition) bad.push(`商品の状態（期待 ${condition} / 実際 ${saved.condition}）`);
      if (shipping_method && saved.shippingMethod !== shipping_method) bad.push(`配送の方法（期待 ${shipping_method} / 実際 ${saved.shippingMethod}）`);

      // 上限に張り付いていると件数が増えず、最古の1件が黙って消える
      const droppedOldest = res.after === res.before && res.before > 0;

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: bad.length === 0, saved: true, dryRun: false,
            verifyFailed: bad.length ? bad : undefined,
            counts: { before: res.before, after: res.after },
            droppedOldest: droppedOldest || undefined,
            droppedOldestNote: droppedOldest
              ? '下書きが上限に張り付いており、最古の1件が押し出された可能性があります（public/index.html の FURIMORA_DRAFTS_MAX）'
              : undefined,
            savedDraft: {
              id: saved.id ?? null, title: saved.title ?? null, price: saved.price ?? null,
              category: saved.category ?? null, condition: saved.condition ?? null,
              shippingMethod: saved.shippingMethod ?? null,
              imageCount: Array.isArray(saved.images) ? saved.images.length : 0,
              sourceUrl: saved.url ?? null,
            },
            plan,
            note: '**フリモーラの下書きです。メルカリにはまだ何も作っていません。** 次は mercari_prepare_draft_from_furimora_draft → mercari_create_draft。',
          }, null, 2),
        }],
      };
    } catch (e) {
      const code = e?.code === 'APP_NOT_RUNNING' ? 'APP_NOT_RUNNING' : 'FURIMORA_DRAFT_FAILED';
      const hint = e?.code === 'APP_NOT_RUNNING' ? '（cd electron && npm start で起動してください）' : '';
      return fail(code, String((e && e.message) || e) + hint);
    }
  }
);

server.registerTool(
  'mercari_prepare_draft_from_furimora_draft',
  {
    title: 'フリモーラの下書きから下ごしらえする',
    description:
      'フリモーラの下書きを 1 件選び、mercari_create_draft に渡せる引数を組み立てる（読み取りのみ。何も保存しない）。' +
      '**これがメルカリの下書きを作る正規の順序。** ' +
      'フリモーラ側で確認・修正を済ませてからメルカリへ流すことで、誤りをメルカリに触る前に直せる。' +
      'カテゴリーは出品ツリーで解決し、商品の状態はラベルを 1〜6 に対応づける。' +
      '解決できなかった項目と、人間が確定させるべき項目は needsHuman に列挙する。',
    inputSchema: {
      backup_path: z.string().optional()
        .describe('フリモーラのバックアップ JSON のパス。Desktop が起動していれば省略できる'),
      draft_id: z.union([z.number(), z.string()]).optional()
        .describe('下書きの id で指名する。**取り違えが起きないのでこちらを推奨。** 見つからなければ止まる（下書きの消失はここで気づける）'),
      index: z.number().int().min(0).optional()
        .describe('furimora_list_drafts が返した index。**配列の位置でしかない。** 一覧取得後に下書きが増減すると同じ番号が別の商品を指すため、expect_id か draft_id での裏取りを付けること'),
      expect_id: z.union([z.number(), z.string()]).optional()
        .describe('index の裏取り。その位置の下書きの id がこれと一致しなければ DRAFT_MISMATCH で止める'),
    },
  },
  async ({ backup_path, draft_id, index, expect_id }) => {
    try {
      const { drafts } = await resolveDrafts(backup_path);
      const picked = selectDraft({ drafts, draftId: draft_id, index, expectId: expect_id });
      if (!picked.ok) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `エラー [${picked.code}] ${picked.message}` +
              (picked.detail ? '\n' + JSON.stringify(picked.detail, null, 2) : ''),
          }],
        };
      }
      const d = picked.draft;

      const price = Number(String(d.price ?? '').replace(/[^\d]/g, '')) || null;
      const { path: categoryNames, fixes: categoryFixes } = normalizeCategoryPath(parseCategoryPath(d.category));
      const conditionNumber = conditionFromLabel(d.condition);

      const resolved = categoryNames.length
        ? await withMercari(async (mercari) => {
            const login = await mercari.checkLogin();
            if (!login.loggedIn) return { needsLogin: true };
            return mercari.resolveCategory(categoryNames);
          })
        : { ok: false, code: 'NO_CATEGORY', message: 'この下書きにカテゴリーがありません' };
      if (resolved.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }

      const needsHuman = [];
      // 位置指定を裏取りなしで解決した場合は、ここで必ず人に見せる。
      // 黙って通すと、別の商品がメルカリへ流れたことに誰も気づけない
      for (const w of picked.warnings) needsHuman.push(w.message);
      if (categoryFixes.length) {
        needsHuman.push(`カテゴリーの崩れを直した（${categoryFixes.join(' / ')}）。結果が正しいか確認すること`);
      }
      if (!resolved.ok) needsHuman.push(`カテゴリー（${resolved.message}）`);
      if (conditionNumber == null) needsHuman.push(`商品の状態の番号（「${d.condition ?? ''}」を 1〜6 に対応づけられませんでした）`);
      if (price == null) needsHuman.push('価格（下書きに価格が入っていません）');
      needsHuman.push('商品の状態（実物を見て決める。写真から判定しない）');
      needsHuman.push('画像（image_paths にローカルのファイルパスを渡す。下書きの画像URLは使えない）');
      needsHuman.push(`配送の方法（下書きは「${d.shippingMethod ?? '未設定'}」。実物のサイズと重さで判断し直すこと）`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            source: {
              furimoraDraftId: d.id ?? null, title: d.title ?? null,
              category: d.category ?? null, condition: d.condition ?? null,
              shippingMethod: d.shippingMethod ?? null, shippingDays: d.shippingDays ?? null,
              sourceUrl: d.url ?? null, createdAt: d.createdAt ?? null,
            },
            // どの下書きを、どうやって選んだか。裏取りの有無まで残す
            selection: {
              by: draft_id != null && draft_id !== '' ? 'draft_id' : 'index',
              index: picked.index,
              verified: picked.warnings.length === 0,
            },
            draftInput: {
              title: d.title ?? null,
              description: d.description ?? null,
              price,
              category_path: resolved.ok ? resolved.categoryPath : null,
              condition: conditionNumber,
              image_paths: [],
              shipping_method: d.shippingMethod ?? null,
            },
            categoryResolution: resolved,
            categoryFixes,
            conditionMapping: { label: d.condition ?? null, number: conditionNumber, labels: SELECTORS.sell.conditionLabels },
            needsHuman,
            note: 'これは下ごしらえです。**この時点ではメルカリ側に何も作られていません。** ' +
                  '発送日数はメルカリ側の既定（1~2日で発送）のままになる。下書きの値はコピーしない ' +
                  '（複製元自体が間違っていることがあるため）。',
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [PREPARE] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'mercari_resolve_category',
  {
    title: 'カテゴリーの経路を出品ツリーで解決',
    description:
      'カテゴリーの経路が、メルカリの出品フォームのカテゴリーツリーに実在するかを調べる（読み取りのみ。何も保存しない）。' +
      'mercari_create_clone_data が返す category（"A > B > C" 形式）をそのまま渡してよい。' +
      '末端まで届けば ok。届かない・見つからない場合は、その階層の候補を返す。' +
      '**末端を推測して勝手に選ぶことはしない。** 候補から選ぶのは人間の役割。',
    inputSchema: {
      category: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])
        .describe('"ゲーム・おもちゃ・グッズ > キャラクターグッズ > その他" のような文字列、または名前の配列'),
    },
  },
  async ({ category }) => {
    try {
      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.resolveCategory(category);
      });
      if (r.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }
      if (!r.ok) {
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'mercari_prepare_draft_from_item',
  {
    title: '商品URLから下書きの下ごしらえをする',
    description:
      '既存の商品URLから下書きの引数を組み立てる（読み取りのみ。何も保存しない）。' +
      '**正規の順序はフリモーラの下書きを経由する mercari_prepare_draft_from_furimora_draft。** ' +
      'こちらはフリモーラ側での確認を挟まないため、内容の確認をより慎重に行うこと。' +
      'クローン元の category を出品ツリーで解決し、condition のラベルを 1〜6 の番号へ対応づける。' +
      '**解決できなかった項目と、人間が確定させるべき項目を needsHuman に列挙して返す。** ' +
      '価格・商品の状態・画像は、返ってきた値をそのまま使わず必ず人間が確定させること。',
    inputSchema: {
      url: URL_ARG,
    },
  },
  async ({ url }) => {
    try {
      const got = await api.call('mercari.createCloneData', { url });
      if (!got || got.ok !== true) {
        return { isError: true, content: [{ type: 'text', text: `エラー [${got?.code || 'UNKNOWN'}] ${got?.message || '商品情報を取得できませんでした'}` }] };
      }
      const d = got.data || {};
      const { path: categoryNames, fixes: categoryFixes } = normalizeCategoryPath(parseCategoryPath(d.category));
      const conditionNumber = conditionFromLabel(d.condition);

      const resolved = categoryNames.length
        ? await withMercari(async (mercari) => {
            const login = await mercari.checkLogin();
            if (!login.loggedIn) return { needsLogin: true };
            return mercari.resolveCategory(categoryNames);
          })
        : { ok: false, code: 'NO_CATEGORY', message: '取得元にカテゴリーがありません' };

      if (resolved.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }

      const needsHuman = [
        '価格（クローン元の価格をそのまま使わない。最低価格と利益を見て決める）',
        '商品の状態（写真から判定しない。実物を見て決める。生成時は悪い側に寄せる）',
        '画像（image_paths にローカルのファイルパスを渡す。取得元の画像URLは使えない）',
        `配送の方法（複製元は「${d.shippingMethod ?? '不明'}」。実物のサイズと重さで判断し直すこと）`,
      ];
      if (!resolved.ok) needsHuman.unshift(`カテゴリー（${resolved.message}）`);
      if (categoryFixes.length) needsHuman.unshift(`カテゴリーの崩れを直した（${categoryFixes.join(' / ')}）。結果が正しいか確認すること`);
      if (conditionNumber == null) needsHuman.unshift(`商品の状態の番号（「${d.condition ?? ''}」を 1〜6 に対応づけられませんでした）`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            source: {
              url: d.url, itemId: d.itemId, title: d.title,
              currentPrice: d.currentPrice, category: d.category, condition: d.condition,
              shippingMethod: d.shippingMethod, imageCount: Array.isArray(d.images) ? d.images.length : 0,
            },
            draftInput: {
              title: d.title ?? null,
              description: d.description ?? null,
              price: null,
              category_path: resolved.ok ? resolved.categoryPath : null,
              condition: conditionNumber,
              image_paths: [],
              shipping_method: d.shippingMethod ?? null,
            },
            categoryResolution: resolved,
            categoryFixes,
            conditionMapping: { label: d.condition ?? null, number: conditionNumber, labels: SELECTORS.sell.conditionLabels },
            needsHuman,
            note: 'これは下ごしらえです。**この時点ではメルカリ側に何も作られていません。** ' +
                  'price と condition と image_paths と shipping_method を人間が確定させてから ' +
                  'mercari_create_draft を呼んでください。**複製元の値をそのまま使わないこと**' +
                  '（複製元自体が間違っていることがある。実測で発送日数が誤っていた例がある）。',
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [PREPARE] ${String((e && e.message) || e)}` }] };
    }
  }
);


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 今日の日付（日本時間）YYYY-MM-DD。出品日に使う */
const todayJst = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

/** アプリの配送方法・販路の設定を読む（読み取りのみ）。未保存なら空配列 */
async function readCommerceSettings(svc) {
  const stored = await svc.readStorage(['furimora_shipping_methods', 'furimora_marketplaces']);
  const parse = (s) => { try { const v = JSON.parse(s || 'null'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const methods = parse(stored.furimora_shipping_methods);
  const marketplaces = parse(stored.furimora_marketplaces);
  const feePercent = Number((marketplaces.find((m) => m.isDefault) || marketplaces[0] || { fee: 10 }).fee ?? 10);
  return { methods, feePercent };
}

/**
 * **仮登録**: メルカリに出す前の商品を、フリモーラの在庫へ先に入れる。
 * 「メルカリの下書きはあるのにフリモーラ側には何も無い」を無くすための処理。
 * メルカリの商品URL・IDはまだ無い。出品後に furimora_register_from_listing が紐づける。
 *
 * `save:false` は重複と入力欄の検査までを行い、何も保存しない（通し稽古）。
 * 呼び出し側（mercari_create_draft）は、メルカリへ書く**前**にこれを save:false で通す。
 */
async function registerPendingFlow(a, { save }) {
  const svc = new FurimoraService(callApp);
  const planned = planPending({ title: a.title, price: a.price, min: a.min, cost: a.cost, purchaseDate: a.purchaseDate });
  if (!planned.ok) return planned;
  const conditionLabel = SELECTORS.sell.conditionLabels[a.condition];
  if (!conditionLabel) return { ok: false, code: 'BAD_CONDITION', message: `商品の状態は 1〜6 で指定してください: ${JSON.stringify(a.condition)}` };

  let items;
  try { items = await readJsonArrayFromApp('furimora_items'); }
  catch (e) {
    const code = e?.code === 'APP_NOT_RUNNING' ? 'APP_NOT_RUNNING' : 'APP_READ_FAILED';
    const hint = e?.code === 'APP_NOT_RUNNING' ? '（cd electron && npm start で起動してください）' : '';
    return { ok: false, code, message: String((e && e.message) || e) + hint };
  }
  const dup = findAdoptionCandidates(items, { title: a.title });
  if (dup.length) {
    return { ok: false, code: 'ALREADY_PENDING', message: `同じタイトルの仮登録がすでにあります（在庫 id ${dup.map((d) => d.id).join(', ')}）。何も変更していません` };
  }

  const { methods, feePercent } = await readCommerceSettings(svc);
  let method = null;
  if (methods.length) {
    const chosen = chooseShippingMethod(methods, a.shippingMethodId);
    if (!chosen.ok) return chosen;
    method = chosen.method;
  } else if (a.shippingMethodId) {
    return { ok: false, code: 'UNKNOWN_SHIPPING_METHOD', message: 'アプリに配送方法の設定が保存されていないため、指定できません' };
  }
  const expectedShipping = a.shippingCost ?? (method ? Number(method.shippingCost || 0) + Number(method.packingCost || 0) : null);
  const profit = expectedShipping == null ? null : estimateProfit({
    startPrice: planned.plan.startPrice, minPrice: planned.plan.minPrice, costPrice: planned.plan.costPrice,
    feePercent, shippingCost: expectedShipping,
  });
  const plan = {
    ...planned.plan,
    category: (a.categoryPath || []).join(' > '), condition: conditionLabel,
    shippingMethod: method ? { id: method.id, name: method.name } : null, shippingCost: expectedShipping, feePercent,
    estimatedProfit: profit ? { 出品価格で売れたとき: profit.atStart, 最低価格で売れたとき: profit.atMin } : null,
  };
  const needsHuman = [...planned.warnings, 'メルカリの商品URL・画像はまだありません。出品後に furimora_register_from_listing で紐づけます'];
  if (expectedShipping == null) needsHuman.push('配送方法の設定が未保存のため、送料は入力画面の既定値のままです。登録後に確認してください');

  const args = {
    title: a.title, description: a.description, min: a.min, cost: a.cost, buffer: planned.plan.buffer,
    category: plan.category, condition: conditionLabel,
    shippingMethodId: method ? method.id : undefined, shippingCost: a.shippingCost,
    supplier: a.supplier, purchaseDate: a.purchaseDate,
  };
  const reh = await svc.registerPending(args, { save: false });
  if (!reh.ok) return { ok: false, code: reh.code, message: reh.message };
  if (!save) return { ok: true, saved: false, plan, needsHuman, form: reh.form };

  const reg = await svc.registerPending(args, { save: true });
  if (!reg.ok) return { ok: false, code: reg.code, message: reg.message };
  if (reg.after === reg.before) return { ok: false, code: 'SAVE_REJECTED', message: '在庫の件数が増えませんでした（入力画面のチェックで弾かれた可能性）。何も保存されていません', form: reg.form };
  const expected = {
    title: a.title, costPrice: planned.plan.costPrice, minPrice: planned.plan.minPrice, startPrice: planned.plan.startPrice,
    shippingCost: expectedShipping ?? Number(reg.form.shippingCost),
  };
  const verifyFailed = verifyRegisteredItem(reg.item, expected);
  await sleep(2000); // 保存を信用せず、少し待って読み直す
  const after = await readJsonArrayFromApp('furimora_items');
  const found = findAdoptionCandidates(after, { title: a.title });
  const persistFailed = found.length === 1 ? verifyRegisteredItem(found[0], expected) : [`読み直しで ${found.length} 件見つかりました（1 件のはず）`];
  const item = found[0] ?? null;
  return {
    ok: verifyFailed.length === 0 && persistFailed.length === 0,
    saved: true, plan, needsHuman,
    verifyFailed: verifyFailed.length ? verifyFailed : undefined,
    persistFailed: persistFailed.length ? persistFailed : undefined,
    counts: { 在庫: { before: reg.before, after: after.length } },
    registered: item ? { id: item.id, title: item.title, status: item.status, startPrice: item.startPrice, minPrice: item.minPrice, costPrice: item.costPrice, shippingCost: item.shippingCost, category: item.category, condition: item.condition } : null,
  };
}

server.registerTool(
  'furimora_register_pending',
  {
    title: '出品前の商品をフリモーラの在庫に仮登録する',
    description:
      'メルカリに出す前の商品を、フリモーラの在庫へ**先に**入れる（仮登録）。メルカリの下書きを作ったのにフリモーラ側が空、を防ぐ。' +
      'メルカリの商品URL・画像はまだ無い。出品後に furimora_register_from_listing がURL・実際の出品価格・画像を紐づける。' +
      '**フリモーラ Desktop（electron/）の起動が必要。** アプリ自身の保存経路（在庫の新規登録）を通す。' +
      '同じタイトルの仮登録がすでにあれば何も書かずに止まる。**dry_run の既定は true**（入力欄を埋めて内容を返すだけで、保存しない）。' +
      '保存後は読み直して値を確かめる。1 回の呼び出しで 1 件のみ。メルカリには何も書き込まない。',
    inputSchema: {
      title: z.string().min(1).describe('商品名（メルカリの出品タイトルと同じにする。出品後の紐づけに使う）'),
      description: z.string().min(1).describe('商品説明'),
      price: z.number().int().min(300).describe('出品価格（円）。開始価格になる'),
      min_price: z.number().int().min(300).describe('最低価格（円）。必ず指定する。出品価格との差がバッファ（既定 800 円）になる'),
      cost_price: z.number().int().min(0).describe('仕入れ値（円）。必ず指定する。0 は「仕入0円」の意味'),
      category_path: z.array(z.string().min(1)).min(2).describe('カテゴリーの経路（例: ["CD・DVD・ブルーレイ","DVD","洋画・外国映画"]）'),
      condition: z.number().int().min(1).max(6).describe('商品の状態 1〜6（1=新品、未使用 … 6=全体的に状態が悪い）'),
      shipping_method_id: z.string().max(60).optional().describe('配送方法の ID（例: sm_nekopos）。省略するとアプリの既定'),
      shipping_cost: z.number().int().min(0).max(5000).optional().describe('送料+梱包の経費（円）を直接指定する。厚みのある箱物など'),
      supplier: z.string().max(80).optional().describe('仕入れ先'),
      purchase_date: z.string().max(10).optional().describe('仕入日（YYYY-MM-DD）'),
      dry_run: z.boolean().default(true).describe('true（既定）なら何も保存しない。実際に登録するときだけ false'),
    },
  },
  async ({ title, description, price, min_price, cost_price, category_path, condition, shipping_method_id, shipping_cost, supplier, purchase_date, dry_run = true }) => {
    try {
      const r = await registerPendingFlow({
        title, description, price, min: min_price, cost: cost_price, categoryPath: category_path, condition,
        shippingMethodId: shipping_method_id, shippingCost: shipping_cost, supplier, purchaseDate: purchase_date,
      }, { save: dry_run === false });
      if (r.ok === false && !r.saved) return { isError: true, content: [{ type: 'text', text: `エラー [${r.code}] ${r.message}` }] };
      return { content: [{ type: 'text', text: JSON.stringify({ ...r, dryRun: dry_run !== false, note: r.saved ? (r.ok ? 'フリモーラの在庫に仮登録しました（メルカリには何も書いていません）。' : '**確認に失敗した項目があります。** 完了とは言えません。') : '確認のみです。フリモーラには何も保存していません。' }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [REGISTER_PENDING] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'mercari_create_draft',
  {
    title: 'メルカリの下書きを作る',
    description:
      'メルカリの出品フォームを埋めて「下書き」を 1 件作る。**出品はしない。** ' +
      '**既定は確認のみ（dry_run=true）で、メルカリ側には何も保存しない。** ' +
      '確認モードでもフォーム入力とカテゴリー選択は実際に行うため、カテゴリーの経路が実在するかまで検証できる' +
      '（メルカリに自動保存は無い）。実際に下書きを保存するには dry_run に false を明示する。' +
      '1 回の呼び出しで作る下書きは 1 件だけ。「出品する」ボタンには一切触れない。' +
      '商品の状態は推測せず、必ず人間が決めた値を渡すこと。' +
      '**保存（dry_run:false）では cost_price と min_price が必須。** メルカリの下書きと同時に、フリモーラの在庫へ仮登録する' +
      '（メルカリの下書きだけ作ってフリモーラ側が空になるのを防ぐ）。メルカリへ書く前に、フリモーラ側の重複と入力欄を検査し、' +
      '失敗したらメルカリには何も書かない。出品後は furimora_register_from_listing でURL・画像を紐づける。',
    inputSchema: {
      title: z.string().min(1).describe('商品名'),
      description: z.string().min(1).describe('商品説明'),
      price: z.number().int().min(300).max(9999999).describe('価格（円・整数）'),
      category_path: z.array(z.string().min(1)).min(2)
        .describe('カテゴリーの経路を大分類から末端まで名前で指定する（例: ["ファッション","レディース","トップス","シャツ・ブラウス","半袖"]）。経路が違うと候補を返す'),
      condition: z.number().int().min(1).max(6)
        .describe('商品の状態。1=新品、未使用 / 2=未使用に近い / 3=目立った傷や汚れなし / 4=やや傷や汚れあり / 5=傷や汚れあり / 6=全体的に状態が悪い。**大きいほど状態が悪い。推測せず人間が決めた値を渡すこと**'),
      image_paths: z.array(z.string()).default([])
        .describe('画像のローカルファイルパス。省略可（画像なしでも下書きは保存できる）'),
      shipping_method: z.string().optional()
        .describe('配送の方法（例: "らくらくメルカリ便"）。省略するとメルカリ側の既定（ゆうゆうメルカリ便）のままになる。一致しない場合は候補を返す'),
      shipping_from: z.string().optional()
        .describe('発送元の都道府県（例: "大阪府"）。省略するとメルカリ側の既定のまま。一致しない場合は候補を返す'),
      shipping_duration: z.string().optional()
        .describe('発送日数（"1~2日で発送" / "2~3日で発送" / "4~7日で発送"）。**省略時のメルカリ既定は「2~3日で発送」**なので、実運用が違うなら必ず指定すること'),
      cost_price: z.number().int().min(0).optional()
        .describe('仕入れ値（円）。**dry_run:false では必須**（フリモーラの在庫へ仮登録するため）。0 は「仕入0円」の意味'),
      min_price: z.number().int().min(300).optional()
        .describe('最低価格（円）。**dry_run:false では必須**。price − min_price がバッファ（既定 800 円）になる'),
      inventory_shipping_cost: z.number().int().min(0).max(5000).optional()
        .describe('フリモーラの在庫に入れる送料+梱包の経費（円）。省略するとアプリの既定の配送方法。厚みのある箱物など'),
      supplier: z.string().max(80).optional().describe('仕入れ先（在庫用）'),
      purchase_date: z.string().max(10).optional().describe('仕入日 YYYY-MM-DD（在庫用）'),
      dry_run: z.boolean().default(true)
        .describe('true（既定）は確認のみで何も保存しない。実際に下書きを作る場合だけ false を指定する'),
    },
  },
  async ({ title, description, price, category_path, condition, image_paths, shipping_method, shipping_from, shipping_duration, cost_price, min_price, inventory_shipping_cost, supplier, purchase_date, dry_run }) => {
    try {
      const pendingArgs = cost_price == null || min_price == null ? null : {
        title, description, price, min: min_price, cost: cost_price, categoryPath: category_path, condition,
        shippingCost: inventory_shipping_cost, supplier, purchaseDate: purchase_date,
      };
      const isSave = dry_run === false;
      // メルカリへ書く前に、フリモーラ側を通し稽古する（重複・入力欄・アプリ起動）。ここで止まればメルカリには何も書かない
      if (isSave && !pendingArgs) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [FURIMORA_REGISTRATION_REQUIRED] 保存には cost_price（仕入れ値）と min_price（最低価格）が必要です。メルカリの下書きだけ作るとフリモーラ側が空になるため、何も書いていません。' }] };
      }
      let pendingPreview = null;
      if (pendingArgs) {
        pendingPreview = await registerPendingFlow(pendingArgs, { save: false });
        if (!pendingPreview.ok && isSave) {
          return { isError: true, content: [{ type: 'text', text: `エラー [${pendingPreview.code}] フリモーラ側で止まりました。メルカリには何も書いていません: ${pendingPreview.message}` }] };
        }
      }
      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.createDraft({
          title, description, price,
          categoryPath: category_path, condition,
          imagePaths: image_paths ?? [],
          shippingMethod: shipping_method ?? null,
          shippingFrom: shipping_from ?? null,
          shippingDuration: shipping_duration ?? null,
          dryRun: dry_run !== false,
        });
      });
      if (r.needsLogin) {
        return { isError: true, content: [{ type: 'text', text: 'エラー [NOT_LOGGED_IN] メルカリにログインしていません。mercari_login を実行してください。' }] };
      }
      if (!r.ok) {
        // 候補があれば必ず見せる。「無い」とだけ言われても直しようがない
        const cand = Array.isArray(r.candidates) && r.candidates.length
          ? `\n候補: ${r.candidates.join(' / ')}`
          : '';
        return { isError: true, content: [{ type: 'text', text: `エラー [${r.code}] ${r.message}${cand}` }] };
      }
      const warn = [];
      // **発送日数の既定は「2~3日で発送」。** 実運用が違うなら黙ってズレるので必ず知らせる
      if (!shipping_duration) {
        warn.push(`発送日数を指定していない（いまの値「${r.plan?.shippingDuration ?? '不明'}」）。実運用と違うなら shipping_duration を指定すること`);
      }
      if (!shipping_from) {
        warn.push(`発送元を指定していない（いまの値「${r.plan?.shippingFrom ?? '未選択'}」）`);
      }
      const out = warn.length ? { ...r, needsHuman: warn } : { ...r };
      if (!pendingArgs) {
        // 確認モードで仕入れ値・最低価格が無い。保存時は必須になることを、ここで必ず知らせる
        out.needsHuman = [...(out.needsHuman || []), '保存（dry_run:false）には cost_price と min_price が必要です（フリモーラの在庫へ仮登録するため）'];
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      if (!isSave) {
        out.furimoraRegistration = { ...pendingPreview, note: '確認のみ。保存時にメルカリの下書きと同時に仮登録します' };
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      // メルカリの下書きが保存できたら、続けてフリモーラの在庫へ仮登録する
      let reg;
      try { reg = await registerPendingFlow(pendingArgs, { save: true }); }
      catch (e) { reg = { ok: false, code: 'REGISTER_PENDING_THREW', message: String((e && e.message) || e) }; }
      out.furimoraRegistration = reg;
      out.ok = r.ok !== false && reg.ok === true;
      out.note = reg.ok
        ? '**メルカリの下書きと、フリモーラの在庫（仮登録）の両方を作りました。出品はしていません。** 出品したら furimora_register_from_listing で商品URL・画像・実際の出品価格を紐づけてください。'
        : `**メルカリの下書き（${r.draftUrl ?? '作成済み'}）は作りましたが、フリモーラの在庫への仮登録に失敗しました。完了ではありません。** 原因: [${reg.code}] ${reg.message}。furimora_register_pending で登録し直してください（メルカリの下書きは作り直さない）。`;
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

server.registerTool(
  'furimora_register_from_listing',
  {
    title: '出品した商品をフリモーラの在庫に登録する',
    description:
      '**出品後**の自分のメルカリ商品URLから、フリモーラの下書きを作り、在庫に登録する。' +
      'メルカリの出品中一覧でその商品が自分の出品であることと出品価格を確かめ、' +
      '出品価格 − 最低価格 をバッファとして開始価格を実際の出品価格に一致させる。' +
      '同じ商品がすでに在庫にあれば何も書かずに止まる（二重登録しない）。' +
      '**仮登録（furimora_register_pending / mercari_create_draft が作る、URL の無い在庫）があれば、新規に作らずそれに紐づける**' +
      '（URL・実際の出品価格・画像・出品日を入れる）。仮登録が無ければ新しく登録する。' +
      '**フリモーラ Desktop（electron/）の起動が必要。** アプリ自身の保存経路（下書き→在庫登録）を通す。' +
      '**dry_run の既定は true。** 確認モードでは何も書かず、登録内容と利益の見積もりを返す。' +
      '保存後は読み直して値を確かめ、出品中一覧との照合まで行って差分を返す。1 回の呼び出しで 1 件のみ。' +
      'メルカリには何も書き込まない。',
    inputSchema: {
      url: z.string().describe('自分の出品中のメルカリ商品URL（出品すると決まる）'),
      cost_price: z.number().int().min(0).describe('仕入れ値（円）。必ず指定する。0 は「仕入0円」の意味'),
      min_price: z.number().int().min(300).describe('最低価格（円）。必ず指定する。出品価格との差がバッファ（既定 800 円）になる'),
      shipping_method_id: z.string().max(60).optional()
        .describe('配送方法の ID（例: sm_nekopos / sm_rakuraku）。省略するとアプリの既定'),
      shipping_cost: z.number().int().min(0).max(5000).optional()
        .describe('送料+梱包の経費（円）を直接指定する。厚みのある箱物など、配送方法の既定値と違うとき'),
      supplier: z.string().max(80).optional().describe('仕入れ先'),
      purchase_date: z.string().max(10).optional().describe('仕入日（YYYY-MM-DD）'),
      adopt_item_id: z.string().max(40).optional()
        .describe('紐づける仮登録の在庫 id。省略するとタイトルが同じ仮登録を探す（2 件以上あれば止まる）'),
      dry_run: z.boolean().default(true).describe('true（既定）なら何も書かない。実際に登録するときだけ false'),
    },
  },
  async ({ url, cost_price, min_price, shipping_method_id, shipping_cost, supplier, purchase_date, adopt_item_id, dry_run = true }) => {
    const fail = (code, message, extra) => ({
      isError: true,
      content: [{ type: 'text', text: `エラー [${code}] ${message}` + (extra ? '\n' + JSON.stringify(extra, null, 2) : '') }],
    });
    const done = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
    try {
      const itemId = parseMercariItemId(url);
      if (!itemId) return fail('BAD_URL', 'メルカリの商品URL（…/item/m123…）を指定してください');
      const svc = new FurimoraService(callApp);

      // 1) 在庫と下書きを読む。アプリが起動していなければここで止まる（何も書いていない）
      let items;
      let drafts;
      try {
        items = await readJsonArrayFromApp('furimora_items');
        drafts = await readJsonArrayFromApp('furimora_drafts');
      } catch (e) {
        const code = e?.code === 'APP_NOT_RUNNING' ? 'APP_NOT_RUNNING' : 'APP_READ_FAILED';
        const hint = e?.code === 'APP_NOT_RUNNING' ? '（cd electron && npm start で起動してください）' : '';
        return fail(code, String((e && e.message) || e) + hint);
      }

      // 2) 二重登録の防止。すでにあれば何も変えない
      const existing = findExistingItem(items, itemId);
      if (existing) {
        return fail('ALREADY_REGISTERED', `在庫に登録済みです。何も変更していません（id ${existing.id}）`, {
          existingItem: {
            id: existing.id, title: existing.title, status: existing.status,
            startPrice: existing.startPrice, minPrice: existing.minPrice, costPrice: existing.costPrice,
          },
        });
      }

      // 3) メルカリの出品中一覧で、自分の出品か・出品価格はいくらかを確かめる
      const remote = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.getMyListings({ tab: 'active', maxItems: 1000 });
      });
      if (remote.needsLogin) return fail('NOT_LOGGED_IN', 'メルカリにログインしていません。mercari_login を実行してください。');
      const listing = remote.items.find((x) => x.itemId === itemId);
      if (!listing) {
        return fail('NOT_ACTIVE_LISTING',
          `自分の出品中に ${itemId} がありません。他人の出品、出品前（下書き）、売却済み、または出品直後で一覧に反映されていない可能性があります`,
          { activeCount: remote.count, truncated: remote.truncated });
      }

      // 3.5) 紐づける仮登録があるか。あれば新規に作らずそれを更新する
      const chosenPending = choosePending(items, { title: listing.title, adoptItemId: adopt_item_id });
      if (!chosenPending.ok) return fail(chosenPending.code, chosenPending.message, chosenPending.candidates ? { candidates: chosenPending.candidates } : undefined);
      const pending = chosenPending.pending;

      // 4) 登録内容を決める。書き込みの前に止められるものはここで止める
      const planned = planRegistration({ itemId, listing, cost: cost_price, min: min_price, purchaseDate: purchase_date });
      if (!planned.ok) return fail(planned.code, planned.message);

      // 5) 配送方法と手数料（アプリの設定を読む。読み取りのみ）
      const stored = await svc.readStorage(['furimora_shipping_methods', 'furimora_marketplaces']);
      const parse = (s) => { try { const v = JSON.parse(s || 'null'); return Array.isArray(v) ? v : []; } catch { return []; } };
      const methods = parse(stored.furimora_shipping_methods);
      const marketplaces = parse(stored.furimora_marketplaces);
      let method = null;
      let shippingNote = null;
      if (methods.length) {
        const chosen = chooseShippingMethod(methods, shipping_method_id);
        if (!chosen.ok) return fail(chosen.code, chosen.message);
        method = chosen.method;
      } else if (shipping_method_id) {
        return fail('UNKNOWN_SHIPPING_METHOD', 'アプリに配送方法の設定が保存されていないため、shipping_method_id は使えません');
      } else {
        shippingNote = '配送方法の設定が未保存のため、入力画面の既定値のまま登録します（登録後に送料を確認してください）';
      }
      const keepPendingShipping = !!pending && !shipping_method_id && shipping_cost == null;
      const expectedShipping = keepPendingShipping
        ? Number(pending.shippingCost || 0)
        : (shipping_cost ?? (method ? Number(method.shippingCost || 0) + Number(method.packingCost || 0) : null));
      const feePercent = Number((marketplaces.find((m) => m.isDefault) || marketplaces[0] || { fee: 10 }).fee ?? 10);
      const profit = expectedShipping == null ? null : estimateProfit({
        startPrice: planned.plan.startPrice, minPrice: planned.plan.minPrice, costPrice: planned.plan.costPrice,
        feePercent, shippingCost: expectedShipping,
      });

      const existingDraft = findDraftForItem(drafts, itemId);
      const plan = {
        ...planned.plan,
        shippingMethod: method ? { id: method.id, name: method.name } : null,
        shippingCost: expectedShipping,
        feePercent,
        estimatedProfit: profit ? { 出品価格で売れたとき: profit.atStart, 最低価格で売れたとき: profit.atMin } : null,
        registration: pending
          ? { action: '仮登録の在庫に紐づける（新規には作らない）', id: pending.id, title: pending.title }
          : { action: '新しく在庫に登録する（紐づける仮登録なし）' },
        draft: existingDraft ? { action: '既存の下書きを使う', id: existingDraft.id } : { action: 'この出品URLから新しく作る' },
      };
      const needsHuman = [...planned.warnings];
      if (shippingNote) needsHuman.push(shippingNote);

      if (dry_run) {
        return done({
          ok: true, saved: false, dryRun: true, plan, needsHuman,
          note: '確認のみです。フリモーラには何も保存していません。実際に登録するには dry_run を false にしてください。',
        });
      }

      // 6) フリモーラの下書き（①）。この出品URLを複製元にする。あれば再利用する
      let draftId;
      let draftCreated = false;
      if (existingDraft) {
        draftId = existingDraft.id;
      } else {
        const opened = await svc.openCloneScreen(url);
        if (!opened.ok) return fail(opened.code, opened.message);
        const got = await svc.fetchSource();
        if (!got.ok) return fail(got.code, got.message);
        const applied = await svc.applyDecisions({ price: planned.plan.startPrice });
        if (!applied.ok) return fail(applied.code, applied.message);
        const res = await svc.save();
        if (!res.ok) return fail(res.code, res.message);
        if (!res.saved || String(res.saved.itemId) !== itemId) {
          return fail('DRAFT_MISMATCH', `保存された下書きの複製元が ${itemId} ではありません（${res.saved?.itemId ?? '不明'}）。在庫には登録していません`, { savedDraftId: res.saved?.id ?? null });
        }
        draftId = res.saved.id;
        draftCreated = true;
        // 保存できたと言われても、消えることがある。読み直して確かめる
        await sleep(1500);
        const again = await readJsonArrayFromApp('furimora_drafts');
        if (!again.some((d) => d && String(d.id) === String(draftId))) {
          return fail('DRAFT_LOST', `フリモーラの下書き ${draftId} が保存直後に見当たりません。在庫には登録していません。もう一度実行してください`);
        }
      }

      // 7) 在庫へ登録（下書きの「出品登録」と同じ経路）
      let reg;
      if (pending) {
        // 仮登録に、出品したメルカリ商品のURL・ID・実際の出品価格・画像・出品日を入れる（編集経路。新規には作らない）
        const draftNow = (await readJsonArrayFromApp('furimora_drafts')).find((d) => d && String(d.id) === String(draftId));
        reg = await svc.adoptListing({
          localId: pending.id, itemId, url: listing.url || url, min: min_price, cost: cost_price, buffer: planned.plan.buffer,
          listedAt: todayJst(), images: draftNow?.images,
          shippingMethodId: shipping_method_id ? method?.id : undefined, shippingCost: shipping_cost,
        }, { save: true });
      } else {
        reg = await svc.registerFromDraft({
          draftId, itemId, cost: cost_price, min: min_price, buffer: planned.plan.buffer,
          shippingMethodId: method ? method.id : undefined, shippingCost: shipping_cost,
          supplier, purchaseDate: purchase_date,
        }, { save: true });
      }
      if (!reg.ok) {
        return fail(reg.code, reg.message, { draftId, note: 'フリモーラの下書きは残っています。在庫には保存していません' });
      }
      if (!pending && reg.after === reg.before) {
        return fail('SAVE_REJECTED', '在庫の件数が増えませんでした（入力画面のチェックで弾かれた可能性）。何も保存されていません', { draftId, form: reg.form });
      }
      const expected = {
        mercariItemId: itemId, costPrice: planned.plan.costPrice, minPrice: planned.plan.minPrice,
        startPrice: planned.plan.startPrice, shippingCost: expectedShipping ?? Number(reg.form.shippingCost),
      };
      const verifyFailed = verifyRegisteredItem(reg.item, expected);
      if (pending && reg.item && String(reg.item.id) !== String(pending.id)) verifyFailed.push('仮登録とは別の在庫が更新されました');
      if (pending && reg.after !== reg.before) verifyFailed.push(`紐づけで在庫の件数が変わりました（${reg.before}→${reg.after}）`);

      // 8) 保存を信用せず、少し待って読み直す
      await sleep(2000);
      const itemsAfter = await readJsonArrayFromApp('furimora_items');
      const persisted = findExistingItem(itemsAfter, itemId);
      const persistFailed = verifyRegisteredItem(persisted, expected);
      if (pending && persisted && String(persisted.id) !== String(pending.id)) persistFailed.push('仮登録とは別の在庫に紐づいています');
      if (pending && persisted && !String(persisted.mercariUrl || '').includes(itemId)) persistFailed.push('商品URLが入っていません');

      // 9) 出品中一覧との照合。今回の商品について差分が無いことを確かめる
      const report = reconcileListings({
        local: itemsAfter, remoteActive: remote.items, remoteSold: [], remoteTruncated: remote.truncated,
      });
      const reconcile = {
        手元に無い出品: report.missingLocally.some((x) => x.itemId === itemId),
        価格のズレ: report.priceMismatch.filter((x) => x.itemId === itemId),
        メルカリID未設定: report.unlinked.length,
      };
      const synced = !reconcile.手元に無い出品 && reconcile.価格のズレ.length === 0;

      const ok = verifyFailed.length === 0 && persistFailed.length === 0 && synced;
      return done({
        ok, saved: true, dryRun: false,
        verifyFailed: verifyFailed.length ? verifyFailed : undefined,
        persistFailed: persistFailed.length ? persistFailed : undefined,
        draft: { id: draftId, created: draftCreated },
        linkedPendingId: pending ? pending.id : undefined,
        counts: { 在庫: { before: reg.before, after: itemsAfter.length } },
        registered: persisted ? {
          id: persisted.id, title: persisted.title, status: persisted.status,
          startPrice: persisted.startPrice, currentPrice: persisted.currentPrice, minPrice: persisted.minPrice,
          costPrice: persisted.costPrice, shippingCost: persisted.shippingCost, shippingMethodId: persisted.shippingMethodId,
          category: persisted.category, condition: persisted.condition, mercariUrl: persisted.mercariUrl,
        } : null,
        reconcile, plan, needsHuman,
        note: ok
          ? 'フリモーラの在庫に登録し、メルカリの出品中一覧との差分がないことを確認しました。'
          : '**確認に失敗した項目があります。** 完了とは言えません。上の verifyFailed / persistFailed / reconcile を確認してください。',
      });
    } catch (e) {
      const code = e?.code === 'APP_NOT_RUNNING' ? 'APP_NOT_RUNNING' : 'REGISTER_FAILED';
      return fail(code, String((e && e.message) || e));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout は JSON-RPC 専用。ログは必ず stderr へ。
process.stderr.write(`[furimora-mcp] 起動しました (api origin: ${API_ORIGIN})\n`);
