import assert from 'node:assert/strict';
import test from 'node:test';
import { selectDraft } from '../mcp/src/draft-select.mjs';

/** 一覧の並びはそのまま位置になる。id は数値・文字列が混ざりうる */
const drafts = [
  { id: 1789176820390, title: 'WATER BOYS ウォーターボーイズ DVD 2枚組' },
  { id: '1789176830168', title: 'ネバーエンディング・ストーリー DVD 2作品セット' },
  { id: 1788523372914, title: 'シャドウ・オブ・ヴァンパイア DVD' },
];

test('draft_id での指名は位置に関係なくその下書きを返す', () => {
  const r = selectDraft({ drafts, draftId: 1788523372914 });
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, 'シャドウ・オブ・ヴァンパイア DVD');
  assert.equal(r.index, 2);
  assert.deepEqual(r.warnings, []);
});

test('id は数値と文字列を跨いで一致する', () => {
  assert.equal(selectDraft({ drafts, draftId: '1789176820390' }).draft.title, drafts[0].title);
  assert.equal(selectDraft({ drafts, draftId: 1789176830168 }).draft.title, drafts[1].title);
});

test('指名した下書きが消えていたら止まる（位置で拾い直さない）', () => {
  const afterLoss = [drafts[0], drafts[2]];
  const r = selectDraft({ drafts: afterLoss, draftId: '1789176830168' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DRAFT_NOT_FOUND');
  assert.equal(r.detail.count, 2);
});

test('1件消えた後の同じ index は別の商品を指す — 裏取りがあれば止まる', () => {
  const afterLoss = [drafts[0], drafts[2]];
  // 一覧を見た時点では index 1 が「ネバーエンディング」だった
  const r = selectDraft({ drafts: afterLoss, index: 1, expectId: '1789176830168' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DRAFT_MISMATCH');
  assert.equal(r.detail.found.title, 'シャドウ・オブ・ヴァンパイア DVD');
});

test('裏取りが一致すれば位置指定でも警告なしで通る', () => {
  const r = selectDraft({ drafts, index: 1, expectId: '1789176830168' });
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, drafts[1].title);
  assert.deepEqual(r.warnings, []);
});

test('裏取りの無い位置指定は通すが、黙っては通さない', () => {
  const r = selectDraft({ drafts, index: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, drafts[1].title);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'INDEX_UNVERIFIED');
  assert.match(r.warnings[0].message, /ネバーエンディング/);
});

test('draft_id と index が食い違えば止まる', () => {
  const r = selectDraft({ drafts, draftId: 1789176820390, index: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DRAFT_MISMATCH');
  assert.equal(r.detail.byDraftId.index, 0);
  assert.equal(r.detail.byIndex.index, 1);
});

test('draft_id と index が同じ下書きを指すなら通る', () => {
  const r = selectDraft({ drafts, draftId: 1789176820390, index: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('範囲外の位置指定は止まる', () => {
  const r = selectDraft({ drafts, index: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'DRAFT_NOT_FOUND');
  assert.equal(r.detail.count, 3);
});

test('どちらも渡さなければ止まる', () => {
  const r = selectDraft({ drafts });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_PARAMS');
});

test('expect_id だけを渡すのは誤用として止める', () => {
  const r = selectDraft({ drafts, expectId: 1789176820390 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'BAD_PARAMS');
});

test('index 0 は「未指定」と混同されない', () => {
  const r = selectDraft({ drafts, index: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, drafts[0].title);
});

test('空の一覧でも落ちない', () => {
  assert.equal(selectDraft({ drafts: [], index: 0 }).code, 'DRAFT_NOT_FOUND');
  assert.equal(selectDraft({ drafts: undefined, draftId: 1 }).code, 'DRAFT_NOT_FOUND');
});
