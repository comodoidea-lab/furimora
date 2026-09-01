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
import { MercariService, LISTING_TABS } from './src/mercari-service.mjs';

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
async function withMercari(fn, { headless = true } = {}) {
  const browser = new BrowserService({ headless });
  try {
    await browser.startBrowser();
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            loggedIn: r.loggedIn,
            profileDir: DEFAULT_PROFILE_DIR,
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
    const browser = new BrowserService({ headless: false });
    try {
      await browser.startBrowser();
      const mercari = new MercariService(browser);
      await browser.openPage('https://jp.mercari.com/login');
      const deadline = Date.now() + wait_seconds * 1000;
      let loggedIn = false;
      while (Date.now() < deadline) {
        await browser.waitForTimeout(3000);
        try { loggedIn = (await mercari.checkLogin()).loggedIn; } catch { /* 遷移中 */ }
        if (loggedIn) break;
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            loggedIn,
            profileDir: DEFAULT_PROFILE_DIR,
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
            truncated: r.truncated, loadMoreClicks: r.loadMoreClicks, elapsedMs: r.elapsedMs,
            items: r.items,
          }, null, 2),
        }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `エラー [BROWSER] ${String((e && e.message) || e)}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout は JSON-RPC 専用。ログは必ず stderr へ。
process.stderr.write(`[furimora-mcp] 起動しました (api origin: ${API_ORIGIN})\n`);
