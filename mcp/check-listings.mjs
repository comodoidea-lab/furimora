#!/usr/bin/env node
/** フェーズ1のツールを MCP プロトコル越しに確認する（ログイン操作は行わない） */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, 'server.mjs')], stderr: 'ignore' });
const client = new Client({ name: 'listings-check', version: '0.1.0' });
await client.connect(transport);
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const pass = (n, d) => console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => { console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); process.exitCode = 1; };

console.log('\n── ツール定義 ──');
const { tools } = await client.listTools();
for (const n of ['mercari_check_login', 'mercari_login', 'mercari_get_my_listings']) {
  const t = tools.find((x) => x.name === n);
  t ? pass(n, '登録あり') : fail(n, '未登録');
}
const gml = tools.find((t) => t.name === 'mercari_get_my_listings');
const tabEnum = gml?.inputSchema?.properties?.tab?.enum;
JSON.stringify(tabEnum) === JSON.stringify(['active','in_progress','sold','history'])
  ? pass('tab の enum が公開されている', tabEnum.join('/')) : fail('tab の enum', JSON.stringify(tabEnum));

console.log('\n── ブラウザ起動とログイン判定（専用プロファイル） ──');
const t0 = Date.now();
const login = await client.callTool({ name: 'mercari_check_login', arguments: {} });
const ms = Date.now() - t0;
try {
  const j = JSON.parse(text(login));
  typeof j.loggedIn === 'boolean'
    ? pass('mercari_check_login', `loggedIn=${j.loggedIn} / ${ms}ms / profile=${j.profileDir.replace(process.env.HOME, '~')}`)
    : fail('mercari_check_login', text(login).slice(0, 120));
  if (!j.loggedIn && !j.hint) fail('未ログイン時の案内', 'hint が無い'); else pass('未ログイン時の案内');
} catch (e) { fail('mercari_check_login', text(login).slice(0, 160)); }

console.log('\n── 未ログイン時のガード ──');
const listings = await client.callTool({ name: 'mercari_get_my_listings', arguments: { tab: 'active' } });
const t = text(listings);
if (listings.isError && t.includes('NOT_LOGGED_IN')) pass('未ログインなら NOT_LOGGED_IN で止まる');
else if (!listings.isError) {
  try { const j = JSON.parse(t); pass('ログイン済みのため取得された', `${j.count}件 / ${j.elapsedMs}ms / クリック${j.loadMoreClicks}回 / truncated=${j.truncated}`); }
  catch { fail('mercari_get_my_listings', t.slice(0, 160)); }
} else fail('mercari_get_my_listings', t.slice(0, 160));

console.log('\n── 異常系 ──');
const badTab = await client.callTool({ name: 'mercari_get_my_listings', arguments: { tab: 'nope' } });
badTab.isError ? pass('未知のタブは弾かれる', text(badTab).slice(0, 50)) : fail('未知のタブ', '通ってしまった');

await client.close();
console.log(process.exitCode ? '\n失敗あり\n' : '\nすべて成功\n');
