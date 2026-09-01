#!/usr/bin/env node
/**
 * MCP クライアントとして server.mjs を実際に起動し、プロトコル越しに動作確認する。
 * （内部関数を直接呼ぶのではなく、Claude Code などが繋ぐのと同じ経路で叩く）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ITEM_URL = process.env.CHECK_ITEM_URL || 'https://jp.mercari.com/item/m15031621353';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, 'server.mjs')],
  stderr: 'ignore',
});
const client = new Client({ name: 'furimora-mcp-check', version: '0.1.0' });
await client.connect(transport);

const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const pass = (n, d) => console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => { console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); process.exitCode = 1; };

console.log('\n── ツール一覧 ──');
const { tools } = await client.listTools();
console.log('  ' + tools.map((t) => t.name).join(', '));
const expected = ['mercari_get_item', 'mercari_create_clone_data', 'mercari_extract_url', 'furimora_status'];
const missing = expected.filter((n) => !tools.some((t) => t.name === n));
missing.length ? fail('期待するツールが揃っている', `不足: ${missing.join(', ')}`) : pass('期待するツールが揃っている', `${tools.length} 個`);

const urlTool = tools.find((t) => t.name === 'mercari_get_item');
const req = urlTool?.inputSchema?.required || [];
req.includes('url') ? pass('入力スキーマが公開されている', 'required: ' + req.join(',')) : fail('入力スキーマが公開されている', JSON.stringify(urlTool?.inputSchema));

console.log('\n── 正常系 ──');
const got = await client.callTool({ name: 'mercari_get_item', arguments: { url: ITEM_URL } });
try {
  const j = JSON.parse(text(got));
  j.completeness?.filled === 10
    ? pass('mercari_get_item', `${j.completeness.filled}/${j.completeness.total} 項目 / 画像 ${j.data.images.length} 枚 / ¥${j.data.currentPrice}`)
    : fail('mercari_get_item', JSON.stringify(j.completeness));
} catch (e) { fail('mercari_get_item', text(got).slice(0, 120)); }

const clone = await client.callTool({ name: 'mercari_create_clone_data', arguments: { url: `見て ${ITEM_URL} 安い` } });
try {
  const j = JSON.parse(text(clone));
  j.completeness?.filled === 10
    ? pass('mercari_create_clone_data（共有文をそのまま渡す）', `${j.completeness.filled}/${j.completeness.total} 項目`)
    : fail('mercari_create_clone_data', JSON.stringify(j.completeness));
} catch (e) { fail('mercari_create_clone_data', text(clone).slice(0, 120)); }

const ex = await client.callTool({ name: 'mercari_extract_url', arguments: { text: `クリップボードの中身: ${ITEM_URL} ですよ` } });
text(ex).includes(ITEM_URL) ? pass('mercari_extract_url') : fail('mercari_extract_url', text(ex).slice(0, 120));

const st = await client.callTool({ name: 'furimora_status', arguments: {} });
try {
  const j = JSON.parse(text(st));
  j.checks?.[0]?.ok ? pass('furimora_status', `${j.checks.filter(c=>c.ok).length}/${j.checks.length} オリジン到達 / transport=${j.transport}`)
                    : fail('furimora_status', JSON.stringify(j.checks));
} catch (e) { fail('furimora_status', text(st).slice(0, 120)); }

console.log('\n── 異常系 ──');
const bad = await client.callTool({ name: 'mercari_get_item', arguments: { url: 'ただの文字列' } });
bad.isError && text(bad).includes('BAD_URL') ? pass('不正なURL → isError + BAD_URL', text(bad).slice(0, 40)) : fail('不正なURL', JSON.stringify(bad).slice(0, 160));

// スキーマ違反は例外ではなく isError + JSON-RPC -32602 で返る
for (const [label, args] of [['型違反 (url: 123)', { url: 123 }], ['必須項目の欠落 ({})', {}]]) {
  let rejected = false, detail = '';
  try {
    const r = await client.callTool({ name: 'mercari_get_item', arguments: args });
    rejected = !!r.isError && text(r).includes('-32602');
    detail = text(r).slice(0, 60);
  } catch (e) { rejected = true; detail = String(e.message).slice(0, 60); }
  rejected ? pass(`スキーマ検証で弾かれる: ${label}`, detail) : fail(`スキーマ検証で弾かれる: ${label}`, '通ってしまった');
}

let unknownRejected = false;
try { const r = await client.callTool({ name: 'no_such_tool', arguments: {} }); unknownRejected = !!r.isError; }
catch (e) { unknownRejected = true; }
unknownRejected ? pass('未知のツールは拒否される') : fail('未知のツールは拒否される');

await client.close();
console.log(process.exitCode ? '\n失敗あり\n' : '\nすべて成功\n');
