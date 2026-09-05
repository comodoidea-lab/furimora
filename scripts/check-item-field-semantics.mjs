#!/usr/bin/env node
/**
 * 在庫アイテムのフィールドの「意味」を守るための回帰テスト。
 * ログイン・メルカリ・Firestore・Electron を一切使わない（合成データと静的検査のみ）。
 *
 * 使い方: node scripts/check-item-field-semantics.mjs
 *
 * 守っている取り決め:
 *   - costPrice は「未入力 = null」「0 円 = 0」を区別して保存する
 *   - fee は 0（手数料なしの販路）を既定値 10 に潰さない
 *   - purchaseDate（仕入日）は新規・編集・再出品の 3 経路すべてで往復する
 *   - soldPrice は必ず soldPriceSource と対で書かれる
 *
 * ブラウザ上の通し確認（モーダル操作を含む E2E）は別途 `npm run preview` で行う。
 * ここは Node だけで回る範囲を押さえ、退行を早く落とすためのもの。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

let failed = 0;
const pass = (name, note = '') => console.log(`  ✅ ${name}${note ? `  ${note}` : ''}`);
const fail = (name, note = '') => { failed++; console.log(`  ❌ ${name}${note ? `  ${note}` : ''}`); };
const ok = (cond, name, note = '') => (cond ? pass(name, note) : fail(name, note));

/** index.html から関数の本文をそのまま切り出す。テスト側にロジックを写経しないための仕掛け */
function extractFunction(name) {
  const head = `function ${name}(`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`${name} が index.html に見つかりません`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} の終端を特定できません`);
}

console.log('\n── 静的検査: 保存経路の取り決め ──');

const saveNewItem = extractFunction('saveNewItem');

ok(/const costPrice\s*=\s*costRaw === ''[^\n]*\?\s*null/.test(saveNewItem),
  'costPrice: 空欄は null で保存する');
ok(!/costPrice:\s*parseInt\([^\n]*\)\s*\|\|\s*0/.test(saveNewItem),
  'costPrice: 空欄を 0 に潰す `|| 0` が残っていない');
ok(/const fee\s*=\s*Number\.isFinite\(feeParsed\)/.test(saveNewItem),
  'fee: 0 を保つ判定になっている');
ok(!/fee:\s*parseInt\([^\n]*\)\s*\|\|\s*10/.test(saveNewItem),
  'fee: 0 を 10 に潰す `|| 10` が残っていない');
ok(/purchaseDate:\s*purchaseDate\s*\|\|\s*undefined/.test(saveNewItem),
  'purchaseDate: 未入力ならキーを持たせない');
ok(/prev\.soldPriceSource != null/.test(saveNewItem) && /item\.soldPriceSource = prev\.soldPriceSource/.test(saveNewItem),
  'soldPrice / soldPriceSource は編集保存でも引き継がれる');

const executeItemConfirm = extractFunction('executeItemConfirm');
ok(/item\.soldPriceSource = 'currentPriceSnapshot'/.test(executeItemConfirm),
  'soldPriceSource は currentPriceSnapshot 固定で必ず書かれる');
ok(executeItemConfirm.indexOf('item.soldPrice =') >= 0 &&
   executeItemConfirm.indexOf('item.soldPriceSource =') >= 0,
  'soldPrice と soldPriceSource が対で書かれる');
ok(/item\.soldAt = new Date\(\)\.toISOString\(\);/.test(executeItemConfirm),
  'soldAt の既存挙動は変えていない');

console.log('\n── 静的検査: 3 つのモーダルで仕入日が往復する ──');
for (const fn of ['openNewItemModal', 'openInventoryEditItemModal', 'openRelistItemModal']) {
  const body = extractFunction(fn);
  ok(/getElementById\('ni-purchase-date'\)\.value/.test(body), `${fn} が ni-purchase-date を設定する`);
}
ok(/id="ni-purchase-date"/.test(src), 'ni-purchase-date の入力欄が存在する');
ok(/id="ni-cost"[^>]*placeholder="未入力"/.test(src.replace(/\n\s*/g, ' ')),
  'ni-cost は既定値 0 ではなく「未入力」プレースホルダ');

console.log('\n── 利益計算（index.html の実装をそのまま実行） ──');
const computeSrc = extractFunction('furimoraComputeItemNetProfit');
const furimoraComputeItemNetProfit = new Function(`${computeSrc}; return furimoraComputeItemNetProfit;`)();

const cases = [
  ['手数料 0% はそのまま 0%', { currentPrice: 1000, fee: 0, shippingCost: 0, costPrice: 0 }, 1000],
  ['手数料 10%', { currentPrice: 1000, fee: 10, shippingCost: 0, costPrice: 0 }, 900],
  ['fee 未設定は既定 10%', { currentPrice: 1000, shippingCost: 0, costPrice: 0 }, 900],
  ['fee が不正値なら既定 10%', { currentPrice: 1000, fee: 'x', shippingCost: 0, costPrice: 0 }, 900],
  ['costPrice=null は 0 円として計算', { currentPrice: 1000, fee: 10, shippingCost: 0, costPrice: null }, 900],
  ['costPrice=0 は null と同じ計算結果', { currentPrice: 1000, fee: 10, shippingCost: 0, costPrice: 0 }, 900],
  ['送料と仕入を引く', { currentPrice: 1000, fee: 10, shippingCost: 250, costPrice: 300 }, 350],
  ['手数料 0% + 仕入あり', { currentPrice: 1400, fee: 0, shippingCost: 0, costPrice: 300 }, 1100],
];
for (const [name, item, expected] of cases) {
  const got = furimoraComputeItemNetProfit(item);
  ok(got === expected, name, `期待 ¥${expected} / 実際 ¥${got}`);
}

console.log('\n── 既存データの非破壊（レガシー形状を壊さない） ──');
const legacy = { currentPrice: 1000, fee: 10, shippingCost: 0, costPrice: 0 };
ok(furimoraComputeItemNetProfit(legacy) === 900,
  'fee=10 / costPrice=0 のレガシー商品の粗利は従来どおり', '¥900');
ok(furimoraComputeItemNetProfit({ ...legacy, costPrice: undefined }) === 900,
  'costPrice 未定義のレガシー商品も従来どおり', '¥900');

console.log(failed ? `\n${failed} 件失敗\n` : '\nすべて成功\n');
process.exit(failed ? 1 : 0);
