import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  acceptLegacySnapshot,
  applyRemoteDrafts,
  backfillUpdatedAt,
  buildPushRows,
  draftUpdatedMs,
  rebuildDirty,
  sortDrafts,
} from '../public/js/drafts-sync-core.js';

const wb = { id: 1789176820390, title: 'WATER BOYS', createdAt: '2026-09-12T01:33:40.390Z', updatedAt: '2026-09-12T01:33:40.390Z' };
const nes = { id: 1789176830168, title: 'ネバーエンディング・ストーリー', createdAt: '2026-09-12T01:33:50.168Z', updatedAt: '2026-09-12T01:33:50.168Z' };
const old1 = { id: 1788523372914, title: 'シャドウ・オブ・ヴァンパイア', createdAt: '2026-09-04T12:02:52.914Z', updatedAt: '2026-09-04T12:02:52.914Z' };

const row = (d, extra = {}) => ({ draftId: String(d.id), payload: d, deleted: false, updatedAt: d.updatedAt, ...extra });

// ── 今日の消失そのもの ──

test('実測した消失: クラウドに未着の下書きは pull で消えない', () => {
  // 手元には2件。クラウドには1件目だけ届いている
  const r = applyRemoteDrafts({
    localDrafts: [nes, wb, old1],
    remoteRows: [row(wb), row(old1)],
  });
  assert.equal(r.drafts.length, 3);
  assert.ok(r.drafts.some((d) => d.id === nes.id), 'ネバーエンディングが残る');
  assert.equal(r.drafts[0].id, nes.id, '新しい順');
});

test('クラウドが空でも手元の下書きは消えない', () => {
  const r = applyRemoteDrafts({ localDrafts: [nes, wb], remoteRows: [] });
  assert.equal(r.drafts.length, 2);
  assert.equal(r.changed, false, '何も変わっていないなら書き戻さない');
});

// ── 削除の記録 ──

test('他端末での削除は墓標として伝わり、下書きが消える', () => {
  const r = applyRemoteDrafts({
    localDrafts: [nes, old1],
    remoteRows: [{ draftId: String(old1.id), payload: null, deleted: true, updatedAt: '2026-09-12T02:00:00.000Z' }],
  });
  assert.deepEqual(r.drafts.map((d) => d.id), [nes.id]);
  assert.equal(r.tombstones[String(old1.id)], '2026-09-12T02:00:00.000Z');
  assert.equal(r.changed, true);
});

test('手元で削除したものは、古いクラウド版で復活しない', () => {
  const r = applyRemoteDrafts({
    localDrafts: [nes],
    remoteRows: [row(old1)],
    tombstones: { [String(old1.id)]: '2026-09-12T03:00:00.000Z' }, // 削除のほうが新しい
  });
  assert.deepEqual(r.drafts.map((d) => d.id), [nes.id]);
});

test('削除より後にクラウドで作り直されたものは復活し、墓標が消える', () => {
  const revived = { ...old1, updatedAt: '2026-09-12T04:00:00.000Z' };
  const r = applyRemoteDrafts({
    localDrafts: [nes],
    remoteRows: [row(revived)],
    tombstones: { [String(old1.id)]: '2026-09-12T03:00:00.000Z' },
  });
  assert.ok(r.drafts.some((d) => d.id === old1.id));
  assert.equal(Object.prototype.hasOwnProperty.call(r.tombstones, String(old1.id)), false);
});

test('新しいほうが勝つ（手元が新しければクラウドで上書きしない）', () => {
  const localNewer = { ...wb, title: '手元で直した', updatedAt: '2026-09-12T05:00:00.000Z' };
  const r = applyRemoteDrafts({
    localDrafts: [localNewer],
    remoteRows: [row({ ...wb, title: 'クラウドの古い版' })],
  });
  assert.equal(r.drafts[0].title, '手元で直した');
});

test('preferRemote ならクラウドで完全に置き換える', () => {
  const r = applyRemoteDrafts({ localDrafts: [nes, wb], remoteRows: [row(old1)], preferRemote: true });
  assert.deepEqual(r.drafts.map((d) => d.id), [old1.id]);
});

// ── 未送信の印と push ──

test('未送信の印から push する行が作られる', () => {
  const { rows, staleKeys } = buildPushRows({
    drafts: [nes, wb],
    dirty: { [String(nes.id)]: nes.updatedAt },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].draftId, String(nes.id));
  assert.equal(rows[0].deleted, false);
  assert.deepEqual(staleKeys, []);
});

test('削除は payload:null の行として送る（行ごと消さない）', () => {
  const { rows } = buildPushRows({
    drafts: [nes],
    dirty: { '999': '2026-09-12T02:00:00.000Z' },
    tombstones: { '999': '2026-09-12T02:00:00.000Z' },
  });
  assert.equal(rows[0].deleted, true);
  assert.equal(rows[0].payload, null);
});

test('実体も墓標も無い迷子の印は送らずに捨てる', () => {
  const { rows, staleKeys } = buildPushRows({ drafts: [nes], dirty: { '404': '2026-09-12T02:00:00.000Z' } });
  assert.deepEqual(rows, []);
  assert.deepEqual(staleKeys, ['404']);
});

test('push する行は元の下書きを参照で持ち回らない', () => {
  const { rows } = buildPushRows({ drafts: [nes], dirty: { [String(nes.id)]: nes.updatedAt } });
  rows[0].payload.title = '書き換え';
  assert.equal(nes.title, 'ネバーエンディング・ストーリー');
});

test('印が消えても、最後の push 時刻から作り直せる', () => {
  const lastPushMs = new Date('2026-09-12T01:33:45.000Z').getTime(); // WBの後、NESの前
  const dirty = rebuildDirty({ drafts: [nes, wb, old1], lastPushMs });
  assert.deepEqual(Object.keys(dirty), [String(nes.id)], '届いていない NES だけが未送信');
});

test('作り直しでは未送信の削除も拾う', () => {
  const lastPushMs = new Date('2026-09-12T01:00:00.000Z').getTime();
  const dirty = rebuildDirty({ drafts: [], tombstones: { '55': '2026-09-12T02:00:00.000Z' }, lastPushMs });
  assert.equal(dirty['55'], '2026-09-12T02:00:00.000Z');
});

// ── 旧方式からの移行 ──

test('旧方式の塊は、手元が空のときだけ受け入れる', () => {
  const ok = acceptLegacySnapshot({ localDrafts: [], incomingRaw: JSON.stringify([old1]) });
  assert.equal(ok.accept, true);
  assert.equal(ok.reason, 'INITIAL_MIGRATION');

  const ng = acceptLegacySnapshot({ localDrafts: [nes], incomingRaw: JSON.stringify([old1]) });
  assert.equal(ng.accept, false);
  assert.equal(ng.reason, 'LOCAL_NOT_EMPTY');
  assert.deepEqual(ng.drafts.map((d) => d.id), [nes.id], '手元をそのまま返す');
});

test('updatedAt の無い旧データは createdAt で埋める（今の時刻にしない）', () => {
  const legacy = { id: 5, title: '旧', createdAt: '2026-07-01T00:00:00.000Z' };
  const r = backfillUpdatedAt([legacy]);
  assert.equal(r.changed, true);
  assert.equal(r.drafts[0].updatedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(legacy.updatedAt, undefined, '元を書き換えない');
});

test('updatedAt が無くても createdAt で新旧を判定できる', () => {
  assert.equal(draftUpdatedMs({ createdAt: '2026-09-01T00:00:00.000Z' }), new Date('2026-09-01T00:00:00.000Z').getTime());
  assert.equal(draftUpdatedMs(null), 0);
});

// ── 並びと上限 ──

test('上限を超えた分は最古から落ち、落ちた分が分かる', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: 100 + i, title: `古い${i}`, updatedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
  }));
  const r = applyRemoteDrafts({ localDrafts: [nes], remoteRows: many.map((d) => row(d)), limit: 3 });
  assert.equal(r.drafts.length, 3);
  assert.equal(r.drafts[0].id, nes.id);
  assert.equal(r.droppedByLimit.length, 3);
});

test('時刻を持たない下書きは末尾に置く', () => {
  const sorted = sortDrafts([{ id: 1 }, nes, old1]);
  assert.equal(sorted[0].id, nes.id);
  assert.equal(sorted[sorted.length - 1].id, 1);
});

test('壊れた入力でも落ちない', () => {
  assert.deepEqual(applyRemoteDrafts({ localDrafts: '{壊れ', remoteRows: null }).drafts, []);
  assert.deepEqual(buildPushRows({}).rows, []);
  assert.deepEqual(applyRemoteDrafts({}).drafts, []);
});

// ── 配線が外れていないか ──

test('下書きは state の塊から外れている', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const syncKeys = page.slice(page.indexOf('const FURIMORA_SYNC_KEYS = ['), page.indexOf('];', page.indexOf('const FURIMORA_SYNC_KEYS = [')));
  assert.equal(syncKeys.includes("'furimora_drafts'"), false,
    '塊に戻すと丸ごと上書きが復活する');
  assert.match(page, /const FURIMORA_LEGACY_SYNC_WRITE_KEYS = \[[^\]]*'furimora_drafts'/,
    '旧クライアントからの初期移行では読む');
});

test('下書きの書き込み口はすべて未送信・削除を記録する', () => {
  const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const fn = (name) => {
    const start = page.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} が無い`);
    return page.slice(start, page.indexOf('\n}', start));
  };
  assert.match(fn('deleteDraft'), /furimoraMarkDraftDeleted\(/, '1件削除が記録されない');
  assert.match(fn('clearAllDrafts'), /furimoraMarkDraftDeleted\(/, '全削除が記録されない');
  assert.match(fn('createClone'), /furimoraMarkDraftDirty\(/, '新規作成が未送信にならない');
  // 同期の適用で下書きを丸ごと書き戻していないこと
  assert.match(fn('furimoraApplySyncPayload'), /furimoraAcceptLegacyDrafts\(/);
});
