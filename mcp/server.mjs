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
            sessionPartition: backend === 'electron' ? 'persist:mercari' : null,
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
            sessionPartition: backend === 'electron' ? 'persist:mercari' : null,
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
      '自分の出品 1 件の価格を変更する。**既定は確認のみ（dry_run=true）で、実際には変更しない。** ' +
      '確認モードでは現在価格・新価格・差額・手数料と利益の見積りを返す。' +
      '実際に変更するには dry_run に false を明示的に指定する。' +
      '1 回の呼び出しで変更できるのは 1 商品だけ。削除や出品停止は行わない。',
    inputSchema: {
      item_id: z.string().regex(/^m\d{9,}$/, 'm から始まる商品IDを指定してください')
        .describe('メルカリの商品ID（例: m12345678901）'),
      new_price: z.number().int().min(300).max(9999999)
        .describe('新しい価格（円・整数）'),
      dry_run: z.boolean().default(true)
        .describe('true（既定）は確認のみで何も変更しない。実際に変更する場合だけ false を指定する'),
      min_price: z.number().int().min(0).optional()
        .describe('下回ってはいけない価格。指定するとこれを下回る変更を拒否する'),
    },
  },
  async ({ item_id, new_price, dry_run, min_price }) => {
    try {
      const r = await withMercari(async (mercari) => {
        const login = await mercari.checkLogin();
        if (!login.loggedIn) return { needsLogin: true };
        return mercari.updatePrice({
          itemId: item_id, newPrice: new_price,
          dryRun: dry_run !== false, minPrice: min_price ?? null,
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
        .describe('下書きの id。index と どちらか一方を指定する'),
      index: z.number().int().min(0).optional()
        .describe('furimora_list_drafts が返した index。draft_id と どちらか一方を指定する'),
    },
  },
  async ({ backup_path, draft_id, index }) => {
    try {
      const { drafts } = await resolveDrafts(backup_path);
      let d = null;
      if (draft_id != null) d = drafts.find((x) => String(x.id) === String(draft_id)) || null;
      else if (index != null) d = drafts[index] ?? null;
      else {
        return { isError: true, content: [{ type: 'text', text: 'エラー [BAD_PARAMS] draft_id か index のどちらかが必要です' }] };
      }
      if (!d) {
        return { isError: true, content: [{ type: 'text', text: `エラー [DRAFT_NOT_FOUND] 下書きが見つかりません（${drafts.length} 件中）` }] };
      }

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
      '商品の状態は推測せず、必ず人間が決めた値を渡すこと。',
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
      dry_run: z.boolean().default(true)
        .describe('true（既定）は確認のみで何も保存しない。実際に下書きを作る場合だけ false を指定する'),
    },
  },
  async ({ title, description, price, category_path, condition, image_paths, shipping_method, shipping_from, shipping_duration, dry_run }) => {
    try {
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
      return { content: [{ type: 'text', text: JSON.stringify(warn.length ? { ...r, needsHuman: warn } : r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout は JSON-RPC 専用。ログは必ず stderr へ。
process.stderr.write(`[furimora-mcp] 起動しました (api origin: ${API_ORIGIN})\n`);
