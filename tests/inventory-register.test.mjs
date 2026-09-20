import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_BUFFER,
  choosePending,
  chooseShippingMethod,
  findAdoptionCandidates,
  planPending,
  estimateProfit,
  findDraftForItem,
  findExistingItem,
  parseMercariItemId,
  planRegistration,
  verifyRegisteredItem,
} from '../mcp/src/inventory-register.mjs';

const listing = { currentPrice: 3580, title: '悪魔のいけにえ スペシャル・エディション(2枚組) [DVD]' };

test('商品URLから商品IDを取り出す（クエリ付き・別ホスト表記でも）', () => {
  assert.equal(parseMercariItemId('https://jp.mercari.com/item/m12345678901'), 'm12345678901');
  assert.equal(parseMercariItemId('https://jp.mercari.com/item/m12345678901?afid=1'), 'm12345678901');
  assert.equal(parseMercariItemId('https://jp.mercari.com/sell/draft/1194454247'), null);
  assert.equal(parseMercariItemId(''), null);
  assert.equal(parseMercariItemId(undefined), null);
});

test('在庫に同じメルカリ商品があれば見つかる（ID・URLのどちらでも）', () => {
  const items = [
    { id: 1, mercariItemId: 'm111', title: 'a' },
    { id: 2, mercariUrl: 'https://jp.mercari.com/item/m222', title: 'b' },
    { id: 3, title: 'ID もURLも無い' },
  ];
  assert.equal(findExistingItem(items, 'm111').id, 1);
  assert.equal(findExistingItem(items, 'm222').id, 2);
  assert.equal(findExistingItem(items, 'm333'), null);
  assert.equal(findExistingItem(items, null), null);
  assert.equal(findExistingItem(undefined, 'm111'), null);
});

test('m11 が m111 に部分一致して二重登録を誤検出しない（在庫・下書きとも）', () => {
  const items = [{ id: 1, mercariUrl: 'https://jp.mercari.com/item/m111' }];
  assert.equal(findExistingItem(items, 'm11'), null);
  assert.equal(findExistingItem(items, 'm111').id, 1);
  assert.equal(findExistingItem([{ id: 2, mercariUrl: 'https://jp.mercari.com/item/m111?x=1' }], 'm111').id, 2);
  const drafts = [{ id: 1, url: 'https://jp.mercari.com/item/m111' }];
  assert.equal(findDraftForItem(drafts, 'm11'), null);
  assert.equal(findExistingItem(items, 'x; drop'), null, 'm+数字以外の ID は URL 照合に使わない');
});

test('下書きは同じ複製元の最新（先頭側）を返す', () => {
  const drafts = [
    { id: 30, itemId: 'm999' },
    { id: 20, url: 'https://jp.mercari.com/item/m555' },
    { id: 10, url: 'https://jp.mercari.com/item/m555' },
  ];
  assert.equal(findDraftForItem(drafts, 'm555').id, 20);
  assert.equal(findDraftForItem(drafts, 'm999').id, 30);
  assert.equal(findDraftForItem(drafts, 'm000'), null);
});

test('登録内容: 出品価格 3580・最低価格 2780 ならバッファ 800 で警告なし', () => {
  const r = planRegistration({ itemId: 'm1', listing, cost: 890, min: 2780 });
  assert.equal(r.ok, true);
  assert.equal(r.plan.buffer, DEFAULT_BUFFER);
  assert.equal(r.plan.startPrice, 3580);
  assert.deepEqual(r.warnings, []);
});

test('登録内容: バッファが 800 でなければ警告する（止めはしない）', () => {
  const r = planRegistration({ itemId: 'm1', listing, cost: 890, min: 2280 });
  assert.equal(r.ok, true);
  assert.equal(r.plan.buffer, 1300);
  assert.equal(r.warnings.length, 1);
});

test('登録内容: 最低価格が出品価格を上回れば止まる', () => {
  const r = planRegistration({ itemId: 'm1', listing, cost: 890, min: 3600 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'MIN_ABOVE_LISTING');
});

test('登録内容: 仕入れ値・最低価格・仕入日・URL の不正は止まる。仕入れ値 0 は正当', () => {
  const bad = (over) => planRegistration({ itemId: 'm1', listing, cost: 890, min: 2780, ...over });
  assert.equal(bad({ cost: -1 }).code, 'BAD_COST');
  assert.equal(bad({ cost: 550.5 }).code, 'BAD_COST');
  assert.equal(bad({ cost: '890' }).code, 'BAD_COST');
  assert.equal(bad({ cost: undefined }).code, 'BAD_COST', '仕入れ値は必須（未指定で 0 円確定にしない）');
  assert.equal(bad({ min: 299 }).code, 'BAD_MIN_PRICE');
  assert.equal(bad({ min: undefined }).code, 'BAD_MIN_PRICE');
  assert.equal(bad({ purchaseDate: '2026/09/20' }).code, 'BAD_PURCHASE_DATE');
  assert.equal(bad({ itemId: null }).code, 'BAD_URL');
  assert.equal(bad({ cost: 0 }).ok, true);
  assert.equal(planRegistration({ itemId: 'm1', listing: { currentPrice: 0 }, cost: 1, min: 300 }).code, 'NO_LISTING_PRICE');
});

test('利益の見積もりは画面の式と同じ（手数料は四捨五入）', () => {
  // 3580 - round(358) - 250 - 890 = 2082 / 2780 - round(278) - 250 - 890 = 1362
  assert.deepEqual(
    estimateProfit({ startPrice: 3580, minPrice: 2780, costPrice: 890, feePercent: 10, shippingCost: 250 }),
    { atStart: 2082, atMin: 1362 },
  );
  assert.equal(estimateProfit({ startPrice: 1005, minPrice: 1005, costPrice: 0, feePercent: 10, shippingCost: 0 }).atMin, 1005 - 101);
});

test('配送方法: 指定が無ければアプリの既定。存在しない指定は止まる', () => {
  const options = [
    { id: 'sm_none', isDefault: false }, { id: 'sm_nekopos', isDefault: true }, { id: 'sm_rakuraku', isDefault: false },
  ];
  const d = chooseShippingMethod(options, undefined);
  assert.equal(d.method.id, 'sm_nekopos');
  assert.equal(d.fromDefault, true);
  assert.equal(chooseShippingMethod(options, 'sm_rakuraku').method.id, 'sm_rakuraku');
  const bad = chooseShippingMethod(options, 'sm_x');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'UNKNOWN_SHIPPING_METHOD');
  assert.equal(chooseShippingMethod([], undefined).code, 'NO_SHIPPING_METHOD');
  assert.equal(chooseShippingMethod([{ id: 'a' }], undefined).method.id, 'a', '既定が無ければ先頭');
});

const expected = { mercariItemId: 'm1', costPrice: 890, minPrice: 2780, startPrice: 3580, shippingCost: 250 };
const saved = { mercariItemId: 'm1', costPrice: 890, minPrice: 2780, startPrice: 3580, currentPrice: 3580, status: 'active', shippingCost: 250, title: 'x' };

test('読み直した在庫が期待どおりなら、ズレは空', () => {
  assert.deepEqual(verifyRegisteredItem(saved, expected), []);
});

test('読み直した在庫のズレを項目ごとに返す（仕入れ値 0 円確定・価格ズレ・状態違い）', () => {
  const bad = verifyRegisteredItem({ ...saved, costPrice: 0, currentPrice: 3480, status: 'sold', title: '' }, expected);
  assert.equal(bad.length, 4);
  assert.ok(bad.some((s) => s.startsWith('仕入れ値')));
  assert.ok(bad.some((s) => s.startsWith('現在価格')));
  assert.ok(bad.some((s) => s.startsWith('状態')));
  assert.ok(bad.some((s) => s.startsWith('タイトル')));
  assert.deepEqual(verifyRegisteredItem(null, expected), ['在庫に見つかりません']);
});

test('ツール定義: 既定で書かない・localStorage を直接書かない', () => {
  const src = fs.readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const start = src.indexOf("'furimora_register_from_listing'");
  assert.ok(start > 0, 'furimora_register_from_listing が登録されていない');
  const block = src.slice(start, src.indexOf('server.registerTool(', start + 10) > 0 ? src.indexOf('server.registerTool(', start + 10) : undefined);
  assert.match(block, /dry_run: z\.boolean\(\)\.default\(true\)/);
  assert.match(block, /cost_price: z\.number\(\)\.int\(\)\.min\(0\)/, '仕入れ値は必須（.optional() を付けない）');
  assert.doesNotMatch(block, /cost_price[^\n]*optional/);
  assert.doesNotMatch(block, /min_price[^\n]*optional/);
  assert.doesNotMatch(block, /localStorage\.setItem/);
  const svc = fs.readFileSync(new URL('../mcp/src/furimora-service.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(svc, /localStorage\.setItem\(\s*['"]furimora_items/);
});

const pendingItem = (over = {}) => ({ id: 1, title: '変態村 [DVD]', status: 'active', startPrice: 2480, minPrice: 1680, costPrice: 550, ...over });

test('仮登録の候補: 同じタイトルで、ID もURLも無い出品中の在庫だけ', () => {
  const items = [
    pendingItem({ id: 1 }),
    pendingItem({ id: 2, mercariItemId: 'm1' }),
    pendingItem({ id: 3, mercariUrl: 'https://jp.mercari.com/item/m2' }),
    pendingItem({ id: 4, status: 'sold' }),
    pendingItem({ id: 5, title: '別の商品' }),
  ];
  assert.deepEqual(findAdoptionCandidates(items, { title: '変態村 [DVD]' }).map((i) => i.id), [1]);
  assert.deepEqual(findAdoptionCandidates(items, { title: '' }), []);
  assert.deepEqual(findAdoptionCandidates(undefined, { title: 'x' }), []);
});

test('仮登録の内容: 出品価格 − 最低価格 がバッファ。不正は止まる。0円仕入れは正当', () => {
  const ok = planPending({ title: '変態村 [DVD]', price: 2480, min: 1680, cost: 550 });
  assert.equal(ok.ok, true);
  assert.equal(ok.plan.buffer, 800);
  assert.deepEqual(ok.warnings, []);
  assert.equal(planPending({ title: 'x', price: 2480, min: 1000, cost: 1 }).warnings.length, 1, 'バッファ 800 以外は警告');
  assert.equal(planPending({ title: 'x', price: 1000, min: 1200, cost: 1 }).code, 'MIN_ABOVE_PRICE');
  assert.equal(planPending({ title: ' ', price: 1000, min: 500, cost: 1 }).code, 'BAD_TITLE');
  assert.equal(planPending({ title: 'x', price: 299, min: 300, cost: 1 }).code, 'BAD_PRICE');
  assert.equal(planPending({ title: 'x', price: 1000, min: 299, cost: 1 }).code, 'BAD_MIN_PRICE');
  assert.equal(planPending({ title: 'x', price: 1000, min: 500 }).code, 'BAD_COST', '仕入れ値は必須');
  assert.equal(planPending({ title: 'x', price: 1000, min: 500, cost: 0 }).ok, true);
  assert.equal(planPending({ title: 'x', price: 1000, min: 500, cost: 1, purchaseDate: '9/20' }).code, 'BAD_PURCHASE_DATE');
});

test('紐づけ先: 1 件ならそれ、0 件なら新規、2 件以上は推測せず止まる', () => {
  const one = [pendingItem({ id: 1 }), pendingItem({ id: 9, title: '別の商品' })];
  assert.equal(choosePending(one, { title: '変態村 [DVD]' }).pending.id, 1);
  assert.equal(choosePending(one, { title: '知らない商品' }).pending, null);
  const two = [pendingItem({ id: 1 }), pendingItem({ id: 2 })];
  const amb = choosePending(two, { title: '変態村 [DVD]' });
  assert.equal(amb.ok, false);
  assert.equal(amb.code, 'AMBIGUOUS_PENDING');
  assert.equal(amb.candidates.length, 2);
});

test('紐づけ先: adopt_item_id の指定は、仮登録でなければ止まる', () => {
  const items = [pendingItem({ id: 1 }), pendingItem({ id: 2, mercariItemId: 'm1' }), pendingItem({ id: 3, status: 'sold' })];
  assert.equal(choosePending(items, { adoptItemId: '1' }).pending.id, 1, 'タイトル無しでも id 指定で選べる');
  assert.equal(choosePending(items, { adoptItemId: 1 }).pending.id, 1, '数値でも文字列でも一致');
  assert.equal(choosePending(items, { adoptItemId: '2' }).code, 'NOT_PENDING');
  assert.equal(choosePending(items, { adoptItemId: '3' }).code, 'NOT_PENDING');
  assert.equal(choosePending(items, { adoptItemId: '99' }).code, 'PENDING_NOT_FOUND');
});

test('仮登録の検証: メルカリ商品 ID が未設定でも通り、タイトル違いは検出する', () => {
  const exp = { title: '変態村 [DVD]', costPrice: 550, minPrice: 1680, startPrice: 2480, shippingCost: 250 };
  const item = { title: '変態村 [DVD]', costPrice: 550, minPrice: 1680, startPrice: 2480, currentPrice: 2480, status: 'active', shippingCost: 250 };
  assert.deepEqual(verifyRegisteredItem(item, exp), []);
  assert.equal(verifyRegisteredItem({ ...item, title: '別' }, exp).length, 1);
});

function toolBlock(src, name) {
  const start = src.indexOf(`'${name}',`);
  assert.ok(start > 0, `${name} が登録されていない`);
  const next = src.indexOf('server.registerTool(', start + 10);
  return src.slice(start, next > 0 ? next : undefined);
}
const serverSrc = fs.readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');

test('ツール定義: furimora_register_pending は既定で書かず、仕入れ値・最低価格が必須', () => {
  const block = toolBlock(serverSrc, 'furimora_register_pending');
  assert.match(block, /dry_run: z\.boolean\(\)\.default\(true\)/);
  assert.match(block, /cost_price: z\.number\(\)\.int\(\)\.min\(0\)\.describe/);
  assert.match(block, /min_price: z\.number\(\)\.int\(\)\.min\(300\)\.describe/);
  assert.doesNotMatch(block, /localStorage\.setItem/);
});

test('ツール定義: mercari_create_draft は既定 dry_run のまま、保存時に仕入れ値・最低価格を必須にし、メルカリへ書く前にフリモーラ側を検査する', () => {
  const block = toolBlock(serverSrc, 'mercari_create_draft');
  assert.match(block, /dry_run: z\.boolean\(\)\.default\(true\)/);
  assert.match(block, /FURIMORA_REGISTRATION_REQUIRED/);
  // 保存前の検査（save:false）が、メルカリの書き込み（withMercari / createDraft）より前にある
  const pre = block.indexOf('registerPendingFlow(pendingArgs, { save: false })');
  const write = block.indexOf('mercari.createDraft(');
  assert.ok(pre > 0 && write > 0 && pre < write, 'フリモーラ側の通し稽古はメルカリへ書く前に行う');
  // 保存後に仮登録する。失敗を黙って成功にしない
  assert.match(block, /registerPendingFlow\(pendingArgs, \{ save: true \}\)/);
  assert.match(block, /out\.ok = r\.ok !== false && reg\.ok === true/);
});

test('ツール定義: furimora_register_from_listing は仮登録に紐づける分岐を持ち、二重作成しない', () => {
  const block = toolBlock(serverSrc, 'furimora_register_from_listing');
  assert.match(block, /choosePending\(/);
  assert.match(block, /adoptListing\(/);
  assert.match(block, /!pending && reg\.after === reg\.before/, '紐づけは件数が増えないのが正しい');
});
