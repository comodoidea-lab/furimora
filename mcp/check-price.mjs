#!/usr/bin/env node
/**
 * mercari_update_price の検証（MCP プロトコル越し）。
 *
 * **このスクリプトは実際の価格変更を一切行わない。**
 * dry_run を false にする呼び出しは含まれていない。
 * 最重要の確認は「dry_run を省略したときに実行されないこと」。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, 'server.mjs')], stderr: 'ignore' });
const client = new Client({ name: 'price-check', version: '0.1.0' });
await client.connect(transport);
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const pass = (n, d) => console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => { console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); process.exitCode = 1; };

console.log('\n── ツール定義 ──');
const { tools } = await client.listTools();
const t = tools.find((x) => x.name === 'mercari_update_price');
t ? pass('mercari_update_price 登録あり') : fail('mercari_update_price', '未登録');
const dr = t?.inputSchema?.properties?.dry_run;
dr?.default === true ? pass('dry_run の既定が true', 'スキーマに default:true') : fail('dry_run の既定', JSON.stringify(dr));
const req = t?.inputSchema?.required || [];
JSON.stringify(req.sort()) === JSON.stringify(['item_id', 'new_price'])
  ? pass('必須は item_id と new_price のみ') : fail('必須項目', JSON.stringify(req));

console.log('\n── 対象商品を選ぶ ──');
const listRes = await client.callTool({ name: 'mercari_get_my_listings', arguments: { tab: 'active', max_items: 1000 } });
const list = JSON.parse(text(listRes));
const target = list.items.find((i) => i.currentPrice === 1518) || list.items[0];
console.log(`  対象: ${target.title.slice(0, 26)} / 現在 ¥${target.currentPrice}`);
const proposed = target.currentPrice - 68;

console.log('\n── 確認モード（dry_run 省略）──');
const d1 = await client.callTool({ name: 'mercari_update_price', arguments: { item_id: target.itemId, new_price: proposed } });
let plan = null;
try {
  const j = JSON.parse(text(d1));
  plan = j.plan;
  j.dryRun === true && j.applied === false
    ? pass('省略時は確認のみ', `applied=${j.applied} dryRun=${j.dryRun}`)
    : fail('省略時に実行されてしまった', text(d1).slice(0, 140));
  j.plan.currentPrice === target.currentPrice && j.plan.newPrice === proposed && j.plan.diff === -68
    ? pass('計画の内容が正しい', `¥${j.plan.currentPrice} → ¥${j.plan.newPrice} (${j.plan.diff}) ${j.plan.direction}`)
    : fail('計画の内容', JSON.stringify(j.plan));
  j.plan.estimatedNewFee > 0 && j.plan.estimatedNewProfit > 0
    ? pass('手数料と利益の見積り', `手数料 ¥${j.plan.estimatedNewFee} / 利益 ¥${j.plan.estimatedNewProfit}（現在 ¥${j.plan.currentProfit}）`)
    : fail('見積り', JSON.stringify(j.plan));
} catch (e) { fail('確認モード', text(d1).slice(0, 160)); }

console.log('\n── 実際に変わっていないことの確認 ──');
const after = JSON.parse(text(await client.callTool({ name: 'mercari_get_my_listings', arguments: { tab: 'active', max_items: 1000 } })));
const now = after.items.find((i) => i.itemId === target.itemId);
now?.currentPrice === target.currentPrice
  ? pass('価格は変わっていない', `¥${now.currentPrice}`)
  : fail('価格が変わってしまった', `¥${target.currentPrice} → ¥${now?.currentPrice}`);

console.log('\n── ガード ──');
const cases = [
  ['最低価格を下回る指定を拒否', { item_id: target.itemId, new_price: 500, min_price: 1000 }, 'BELOW_MIN_PRICE'],
  ['下限未満の価格を拒否', { item_id: target.itemId, new_price: 100 }, null],
  ['不正な商品IDを拒否', { item_id: 'not-an-id', new_price: 1000 }, null],
  ['存在しない商品を拒否', { item_id: 'm99999999999', new_price: 1000 }, 'EDIT_PAGE_UNAVAILABLE'],
];
for (const [name, args, code] of cases) {
  const r = await client.callTool({ name: 'mercari_update_price', arguments: args });
  const ok = r.isError && (!code || text(r).includes(code));
  ok ? pass(name, text(r).replace(/\s+/g, ' ').slice(0, 52)) : fail(name, text(r).slice(0, 140));
}

const same = await client.callTool({ name: 'mercari_update_price', arguments: { item_id: target.itemId, new_price: target.currentPrice } });
try {
  const j = JSON.parse(text(same));
  j.applied === false ? pass('同一価格は何もしない', j.note) : fail('同一価格', text(same).slice(0, 120));
} catch { fail('同一価格', text(same).slice(0, 120)); }

await client.close();
console.log(process.exitCode ? '\n失敗あり\n' : '\nすべて成功（実際の価格変更は一度も行っていません）\n');
