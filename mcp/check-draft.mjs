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
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BrowserService } from './src/browser-service.mjs';
import { MercariService, SELL_URLS, SELECTORS, parseCategoryPath, normalizeCategoryPath, conditionFromLabel } from './src/mercari-service.mjs';

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

console.log('\n── クローン元との接続（純粋関数）──');
JSON.stringify(parseCategoryPath('ゲーム・おもちゃ・グッズ > キャラクターグッズ > その他')) === JSON.stringify(['ゲーム・おもちゃ・グッズ', 'キャラクターグッズ', 'その他'])
  ? pass('category 文字列を配列にできる') : fail('parseCategoryPath');
JSON.stringify(parseCategoryPath('A ＞ B')) === JSON.stringify(['A', 'B'])
  ? pass('全角の＞も区切りとして扱う') : fail('parseCategoryPath 全角');
conditionFromLabel('新品、未使用') === 1 && conditionFromLabel('全体的に状態が悪い') === 6
  ? pass('状態ラベルを番号に対応づけられる', '新品、未使用=1 / 全体的に状態が悪い=6') : fail('conditionFromLabel');
conditionFromLabel('謎の状態') === null && conditionFromLabel('') === null
  ? pass('対応づけられないラベルは null', '推測で埋めない') : fail('conditionFromLabel の未一致');

console.log('\n── カテゴリーの解決（読み取りのみ）──');
const resolve = async (category) => {
  try { return await client.callTool({ name: 'mercari_resolve_category', arguments: { category } }); }
  catch (e) { return { thrown: String((e && e.message) || e) }; }
};
{
  const r = await resolve('ゲーム・おもちゃ・グッズ > キャラクターグッズ > その他');
  const j = JSON.parse(text(r));
  j.ok === true && j.categoryApplied?.includes('その他')
    ? pass('クローン元の経路をそのまま解決できる', j.categoryPath.join(' > ')) : fail('カテゴリー解決', text(r).slice(0, 140));
}
{
  const r = await resolve('ファッション > レディース > トップス');
  const j = JSON.parse(text(r));
  j.ok === false && j.code === 'CATEGORY_PATH_TOO_SHORT' && (j.candidates || []).length > 0
    ? pass('末端に届かない経路は候補を返す', `候補 ${j.candidates.length} 件: ${j.candidates.slice(0, 3).join(' / ')}…`)
    : fail('末端に届かない経路', text(r).slice(0, 140));
}

console.log('\n── 商品URLからの下ごしらえ（読み取りのみ）──');
{
  const url = process.env.CHECK_ITEM_URL || 'https://jp.mercari.com/item/m15031621353';
  let r;
  try { r = await client.callTool({ name: 'mercari_prepare_draft_from_item', arguments: { url } }); }
  catch (e) { r = null; fail('下ごしらえの呼び出し', String((e && e.message) || e)); }
  if (r && !r.isError) {
    const j = JSON.parse(text(r));
    Array.isArray(j.draftInput?.category_path) && j.draftInput.category_path.length >= 2
      ? pass('category_path を組み立てられる', j.draftInput.category_path.join(' > ')) : fail('category_path', text(r).slice(0, 140));
    Number.isInteger(j.draftInput?.condition)
      ? pass('condition を番号に対応づけられる', `${j.conditionMapping.label} → ${j.draftInput.condition}`) : fail('condition の対応づけ', JSON.stringify(j.conditionMapping));
    j.draftInput?.price === null
      ? pass('価格は空のまま返す', 'クローン元の価格を勝手に使わない') : fail('価格', JSON.stringify(j.draftInput?.price));
    (j.needsHuman || []).length >= 3
      ? pass('人間が確定させる項目を列挙する', `${j.needsHuman.length} 件`) : fail('needsHuman', JSON.stringify(j.needsHuman));
  } else if (r) { fail('下ごしらえ', text(r).slice(0, 140)); }
}

console.log('\n── 壊れたカテゴリーの正規化（純粋関数）──');
// Chrome 拡張の旧いパンくず抽出が、経路を 2 回繰り返した文字列を保存していた。
// 実データのバックアップで下書き 50 件中 50 件が該当した（在庫データは無傷）。
{
  const r = normalizeCategoryPath(parseCategoryPath('CD・DVD・ブルーレイ > DVD > アニメ > CD・DVD・ブルーレイ > DVD > アニメ'));
  JSON.stringify(r.path) === JSON.stringify(['CD・DVD・ブルーレイ', 'DVD', 'アニメ']) && r.fixes.length === 1
    ? pass('2 回繰り返された経路を直せる', r.fixes[0]) : fail('重複の正規化', JSON.stringify(r));
}
{
  const r = normalizeCategoryPath(parseCategoryPath('1 > 本・雑誌・漫画 > 本 > 文学・小説 > 本・雑誌・漫画 > 本 > 文学・小説'));
  JSON.stringify(r.path) === JSON.stringify(['本・雑誌・漫画', '本', '文学・小説']) && r.fixes.length === 2
    ? pass('先頭の数字の断片も落とせる', `${r.fixes.length} 箇所を修正`) : fail('先頭の断片', JSON.stringify(r));
}
{
  const r = normalizeCategoryPath(parseCategoryPath('CD・DVD・ブルーレイ > DVD > 洋画・外国映画'));
  r.fixes.length === 0 && r.path.length === 3
    ? pass('壊れていない経路は触らない', '無修正') : fail('正常系', JSON.stringify(r));
}
{
  // 偶然に前後半が一致しうる短い経路を壊さないこと
  const r = normalizeCategoryPath(['ファッション', 'レディース']);
  JSON.stringify(r.path) === JSON.stringify(['ファッション', 'レディース']) && r.fixes.length === 0
    ? pass('別物の 2 段は縮めない') : fail('2 段の扱い', JSON.stringify(r));
}

console.log('\n── フリモーラの下書きからの下ごしらえ（読み取りのみ）──');
// 下書きは PWA の localStorage にあるため、バックアップ JSON 経由で渡す。
// バックアップは localStorage の生文字列を格納する形式（実装に合わせた合成データ）。
const FIXTURE = path.join(os.tmpdir(), `furimora-check-drafts-${process.pid}.json`);
fs.writeFileSync(FIXTURE, JSON.stringify({
  format: 'furimora-backup', v: 1,
  data: {
    furimora_drafts: JSON.stringify([
      {
        id: 1, title: 'リバー・ランズ・スルー・イット [DVD]', description: '説明文\r\n改行はCRLF',
        // 実データと同じ「2 回繰り返し」の壊れた値を入れる
        price: '2780', category: 'CD・DVD・ブルーレイ > DVD > 洋画・外国映画 > CD・DVD・ブルーレイ > DVD > 洋画・外国映画',
        condition: '目立った傷や汚れなし', shippingMethod: 'らくらくメルカリ便',
        shippingDays: '2~3日で発送', url: 'https://jp.mercari.com/item/m51632833579',
      },
      {
        id: 2, title: 'カテゴリーが末端まで無い下書き', description: '説明', price: '1500',
        category: 'ファッション > レディース > トップス', condition: '謎の状態',
      },
    ]),
  },
}));
try {
  {
    const r = await client.callTool({ name: 'furimora_list_drafts', arguments: { backup_path: FIXTURE } });
    const j = JSON.parse(text(r));
    j.count === 2 && j.drafts[0].shippingMethod === 'らくらくメルカリ便'
      ? pass('バックアップから下書きを読める', `${j.count} 件`) : fail('下書き一覧', text(r).slice(0, 140));
  }
  {
    const r = await client.callTool({ name: 'mercari_prepare_draft_from_furimora_draft', arguments: { backup_path: FIXTURE, draft_id: 1 } });
    const j = JSON.parse(text(r));
    JSON.stringify(j.draftInput?.category_path) === JSON.stringify(['CD・DVD・ブルーレイ', 'DVD', '洋画・外国映画'])
      ? pass('下書きのカテゴリーを解決できる', j.draftInput.category_path.join(' > ')) : fail('カテゴリー解決', text(r).slice(0, 140));
    j.draftInput?.condition === 3 && j.draftInput?.price === 2780 && j.draftInput?.shipping_method === 'らくらくメルカリ便'
      ? pass('状態・価格・配送の方法を引き継げる', `condition=3 / ¥2780 / らくらくメルカリ便`) : fail('引き継ぎ', JSON.stringify(j.draftInput));
    (j.needsHuman || []).some((x) => /配送の方法/.test(x))
      ? pass('配送の方法も人間の確認対象に載せる', '下書きの値をそのまま使わせない') : fail('needsHuman', JSON.stringify(j.needsHuman));
    (j.categoryFixes || []).length === 1 && (j.needsHuman || []).some((x) => /崩れを直した/.test(x))
      ? pass('壊れたカテゴリーを直し、直したことを報告する', j.categoryFixes[0]) : fail('categoryFixes', JSON.stringify(j.categoryFixes));
  }
  {
    const r = await client.callTool({ name: 'mercari_prepare_draft_from_furimora_draft', arguments: { backup_path: FIXTURE, index: 1 } });
    const j = JSON.parse(text(r));
    j.categoryResolution?.code === 'CATEGORY_PATH_TOO_SHORT' && j.draftInput?.condition === null
      ? pass('解決できない下書きは埋めずに返す', 'カテゴリーは候補つき / 状態は null')
      : fail('未解決の扱い', text(r).slice(0, 140));
  }
  {
    const r = await client.callTool({ name: 'mercari_prepare_draft_from_furimora_draft', arguments: { backup_path: FIXTURE } });
    r?.isError ? pass('draft_id も index も無い場合を拒否', text(r).slice(0, 50)) : fail('引数の欠落', text(r).slice(0, 80));
  }
} finally {
  fs.rmSync(FIXTURE, { force: true });
}

console.log('\n── 配送の方法のガード ──');
{
  const { r } = await call({ ...BASE, shipping_method: 'クロネコ便' });
  r?.isError && /SHIPPING_METHOD_NOT_FOUND/.test(text(r))
    ? pass('存在しない配送の方法を拒否', text(r).slice(0, 80)) : fail('配送の方法のガード', text(r).slice(0, 140));
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
