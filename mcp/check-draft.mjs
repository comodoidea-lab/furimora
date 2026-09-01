#!/usr/bin/env node
/**
 * mercari_create_draft の検証（MCP プロトコル越し）。
 *
 * **このスクリプトは下書きを 1 件も作らない。**
 * dry_run を false にする呼び出しは含まれていない。
 * 最重要の確認は「dry_run を省略したときに保存されないこと」。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserService } from './src/browser-service.mjs';
import { MercariService, SELL_URLS, SELECTORS } from './src/mercari-service.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(HERE, 'server.mjs')], stderr: 'ignore' });
const client = new Client({ name: 'draft-check', version: '0.1.0' });
await client.connect(transport);
const text = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const pass = (n, d) => console.log(`  ✅ ${n}${d ? ' — ' + d : ''}`);
const fail = (n, d) => { console.log(`  ❌ ${n}${d ? ' — ' + d : ''}`); process.exitCode = 1; };
const call = async (args) => {
  try { return { r: await client.callTool({ name: 'mercari_create_draft', arguments: args }) }; }
  catch (e) { return { thrown: String((e && e.message) || e) }; }
};

const BASE = {
  title: 'ZZ検証用ZZ通し稽古',
  description: 'これは確認モードの検証です。保存はされません。',
  price: 1000,
  category_path: ['ファッション', 'レディース', 'トップス', 'シャツ・ブラウス', '半袖'],
  condition: 6,
};

console.log('\n── ツール定義 ──');
const { tools } = await client.listTools();
const t = tools.find((x) => x.name === 'mercari_create_draft');
t ? pass('mercari_create_draft 登録あり') : fail('mercari_create_draft', '未登録');
const dr = t?.inputSchema?.properties?.dry_run;
dr?.default === true ? pass('dry_run の既定が true', 'スキーマに default:true') : fail('dry_run の既定', JSON.stringify(dr));
const req = (t?.inputSchema?.required || []).slice().sort();
JSON.stringify(req) === JSON.stringify(['category_path', 'condition', 'description', 'price', 'title'])
  ? pass('必須項目が 5 つ', '商品の状態も必須（既定値を与えない）') : fail('必須項目', JSON.stringify(req));

console.log('\n── スキーマ段階のガード（ブラウザを起動しない）──');
for (const [name, args] of [
  ['商品の状態 0 を拒否', { ...BASE, condition: 0 }],
  ['商品の状態 7 を拒否', { ...BASE, condition: 7 }],
  ['下限未満の価格を拒否', { ...BASE, price: 100 }],
  ['小数の価格を拒否', { ...BASE, price: 1000.5 }],
  ['カテゴリー経路 1 段を拒否', { ...BASE, category_path: ['ファッション'] }],
  ['商品名の欠落を拒否', { ...BASE, title: undefined }],
]) {
  const { r, thrown } = await call(args);
  (thrown || r?.isError) ? pass(name, String(thrown || text(r)).slice(0, 60)) : fail(name, text(r).slice(0, 80));
}

console.log('\n── 実行時のガード ──');
{
  const { r } = await call({ ...BASE, image_paths: ['/no/such/file.png'] });
  r?.isError && /IMAGE_NOT_FOUND/.test(text(r)) ? pass('存在しない画像を拒否', text(r).slice(0, 60)) : fail('存在しない画像', text(r).slice(0, 80));
}
{
  const { r } = await call({ ...BASE, category_path: ['ファッション', 'そんな分類はない'] });
  r?.isError && /CATEGORY_NOT_FOUND/.test(text(r)) ? pass('存在しないカテゴリーを拒否', text(r).slice(0, 70)) : fail('存在しないカテゴリー', text(r).slice(0, 100));
}
{
  const { r } = await call({ ...BASE, category_path: ['ファッション', 'レディース'] });
  r?.isError && /CATEGORY_PATH_TOO_SHORT/.test(text(r)) ? pass('末端まで届かない経路を拒否', text(r).slice(0, 70)) : fail('末端まで届かない経路', text(r).slice(0, 100));
}

console.log('\n── 確認モード（dry_run 省略）──');
// 専用プロファイルは Chrome の ProcessSingleton により同時に 1 プロセスしか使えない。
// MCP サーバーがブラウザを使う間はこちらを閉じておくこと。
const countDrafts = async () => {
  const browser = new BrowserService({ headless: true });
  try {
    await browser.startBrowser();
    await browser.openPage(SELL_URLS.drafts);
    await browser.waitForTimeout(5000);
    return await browser.evaluate((sel) => document.querySelectorAll(sel.draft.itemLink).length, SELECTORS);
  } finally { await browser.stopBrowser(); }
};

const before = await countDrafts();
{
  const { r } = await call(BASE);
  if (r?.isError) { fail('確認モードが成功しない', text(r).slice(0, 120)); }
  else {
    const j = JSON.parse(text(r));
    j.saved === false && j.dryRun === true ? pass('省略時は保存しない', 'saved=false dryRun=true') : fail('省略時の挙動', text(r).slice(0, 120));
    j.plan?.categoryApplied?.includes('半袖') ? pass('カテゴリーの経路が実在する', j.plan.categoryApplied.slice(0, 60)) : fail('カテゴリー適用', JSON.stringify(j.plan?.categoryApplied));
    j.plan?.conditionApplied?.includes('全体的に状態が悪い') ? pass('商品の状態が反映される', `condition=${j.plan.condition} ${j.plan.conditionLabel}`) : fail('状態適用', JSON.stringify(j.plan?.conditionApplied));
    j.plan?.shipping?.includes('メルカリ便') ? pass('配送の方法は既定値のまま', j.plan.shipping.slice(0, 40)) : fail('配送の方法', JSON.stringify(j.plan?.shipping));
  }
}
const after = await countDrafts();
before === after ? pass('下書きが増えていない', `前 ${before} 件 / 後 ${after} 件`) : fail('下書きが増えた', `前 ${before} 件 / 後 ${after} 件`);

console.log(process.exitCode ? '\n失敗あり' : '\nすべて成功（下書きは 1 件も作っていません）');
await client.close();
