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

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout は JSON-RPC 専用。ログは必ず stderr へ。
process.stderr.write(`[furimora-mcp] 起動しました (api origin: ${API_ORIGIN})\n`);
