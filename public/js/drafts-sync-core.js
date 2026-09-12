/**
 * 下書きの同期。**商品（furimora_items）と同じ考え方を下書きにも持たせる。**
 *
 * もともと下書きは `FURIMORA_SYNC_KEYS` の塊に入れて `users/{uid}/app/state` の
 * 1 ドキュメントへまとめて書いていた。pull はその塊での丸ごと上書きになるため、
 * まだ push していない下書きは痕跡なく消えた
 * （実測 2026-09-12: 2 件続けて作り、サーバーに届いていなかった 2 件目だけが消えた）。
 *
 * 書き手が 1 人になることは無い。**デスクトップを開いたままモバイルで見る、
 * エージェントを切り替える、どれも通常運用。** だから塊での上書きをやめ、
 * 商品と同じく「1 件ずつ・未送信の印・削除の記録」で解く。
 *
 * ここに置くのは判断だけで、localStorage も Firestore も触らない（試験できるように）。
 */

/** 下書きの id は数値のことも文字列のこともある */
export const draftKey = (d) => (d && d.id != null ? String(d.id) : '');

function toMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** 下書きの「いつの内容か」。updatedAt が無い旧データは createdAt で代用する */
export function draftUpdatedMs(draft) {
  if (!draft || typeof draft !== 'object') return 0;
  return toMs(draft.updatedAt) || toMs(draft.createdAt);
}

export function parseDrafts(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 新しい順。時刻を持たないものは末尾へ */
export function sortDrafts(drafts) {
  return [...drafts].sort((a, b) => {
    const am = draftUpdatedMs(a);
    const bm = draftUpdatedMs(b);
    if (am === bm) return 0;
    if (!am) return 1;
    if (!bm) return -1;
    return bm - am;
  });
}

/**
 * 旧データに updatedAt を入れる。**createdAt を流用し、今の時刻にはしない。**
 * 今の時刻にすると、他端末の新しい内容より「新しい」と誤って勝ってしまう。
 */
export function backfillUpdatedAt(drafts) {
  let changed = false;
  const out = drafts.map((d) => {
    if (!d || typeof d !== 'object' || d.updatedAt) return d;
    changed = true;
    return { ...d, updatedAt: d.createdAt || new Date(0).toISOString() };
  });
  return { drafts: out, changed };
}

/**
 * 未送信の印を作り直す（印が消えていた場合の復旧）。
 * 最後に push した時刻より後に変わったものを未送信とみなす。
 *
 * @returns {Record<string,string>} id → その時刻
 */
export function rebuildDirty({ drafts, tombstones = {}, lastPushMs = 0 } = {}) {
  const dirty = {};
  for (const d of parseDrafts(drafts)) {
    const key = draftKey(d);
    if (!key) continue;
    const ms = draftUpdatedMs(d);
    // 最後の push より前の内容は届いている。印を付けない
    if (lastPushMs && ms && ms <= lastPushMs) continue;
    dirty[key] = d.updatedAt || d.createdAt || new Date().toISOString();
  }
  for (const [key, deletedAt] of Object.entries(tombstones || {})) {
    const ms = toMs(deletedAt);
    if (lastPushMs && ms && ms <= lastPushMs) continue;
    dirty[key] = deletedAt || new Date().toISOString();
  }
  return dirty;
}

/**
 * push する行を組み立てる。削除は payload:null + deleted:true で送る
 * （行ごと消すと、他端末が「知らない」のか「消された」のか区別できない）。
 *
 * @returns {{rows: Array, staleKeys: string[]}} staleKeys は実体も墓標も無い迷子の印
 */
export function buildPushRows({ drafts, dirty = {}, tombstones = {} } = {}) {
  const map = new Map(parseDrafts(drafts).filter(draftKey).map((d) => [draftKey(d), d]));
  const rows = [];
  const staleKeys = [];
  for (const [key, dirtyAt] of Object.entries(dirty)) {
    const draft = map.get(key);
    const deletedAt = tombstones[key];
    if (deletedAt && !draft) {
      rows.push({ draftId: key, payload: null, deleted: true, updatedAt: deletedAt, dirtyAt });
      continue;
    }
    if (!draft) {
      staleKeys.push(key);
      continue;
    }
    rows.push({
      draftId: key,
      payload: JSON.parse(JSON.stringify(draft)),
      deleted: false,
      updatedAt: draft.updatedAt || draft.createdAt || dirtyAt || new Date().toISOString(),
      dirtyAt,
    });
  }
  return { rows, staleKeys };
}

/**
 * クラウドから来た行を手元へ取り込む。**新しいほうが勝つ。**
 * 手元が新しければ残す（＝まだ push していない下書きは消えない）。
 *
 * @param {object} params
 * @param {Array} params.localDrafts     手元の下書き
 * @param {Array} params.remoteRows      `{draftId, payload, deleted, updatedAt}` の配列
 * @param {Record<string,string>} [params.tombstones] 手元の削除記録
 * @param {boolean} [params.preferRemote] クラウドで完全に置き換える（初回・復旧時）
 * @param {number} [params.limit=150]    手元に残す件数
 */
export function applyRemoteDrafts({
  localDrafts, remoteRows, tombstones = {}, preferRemote = false, limit = 150,
} = {}) {
  const local = parseDrafts(localDrafts);
  const map = preferRemote ? new Map() : new Map(local.filter(draftKey).map((d) => [draftKey(d), d]));
  const tombs = preferRemote ? {} : { ...tombstones };
  const appliedKeys = [];
  let changed = preferRemote && local.length > 0;

  for (const row of Array.isArray(remoteRows) ? remoteRows : []) {
    const key = row && row.draftId != null ? String(row.draftId) : '';
    if (!key) continue;
    const remoteMs = toMs(row.updatedAt);
    const localMs = draftUpdatedMs(map.get(key));
    const localDelMs = toMs(tombs[key]);
    const localLatest = Math.max(localMs, localDelMs);
    // 手元のほうが新しければ触らない。**まだ push していない下書きはここで守られる**
    if (!preferRemote && remoteMs <= localLatest) continue;

    if (row.deleted) {
      if (map.has(key)) { map.delete(key); changed = true; }
      if (tombs[key] !== row.updatedAt) { tombs[key] = row.updatedAt; changed = true; }
      appliedKeys.push(key);
      continue;
    }
    const incoming = row.payload && typeof row.payload === 'object' ? { ...row.payload } : null;
    if (!incoming) continue;
    incoming.updatedAt = row.updatedAt;
    const prev = map.get(key);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(incoming)) {
      map.set(key, incoming);
      changed = true;
    }
    // 復活した下書きの墓標は消す
    if (Object.prototype.hasOwnProperty.call(tombs, key)) { delete tombs[key]; changed = true; }
    appliedKeys.push(key);
  }

  const sorted = sortDrafts(Array.from(map.values()));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : sorted.length;
  return {
    drafts: sorted.slice(0, cap),
    droppedByLimit: sorted.slice(cap),
    tombstones: tombs,
    appliedKeys,
    changed,
  };
}

/**
 * 旧方式（state ドキュメントの塊）から来た下書きの受け入れ。
 *
 * **手元に下書きがあるときは受け入れない。** 商品が差分同期へ移ったときと同じ扱いで、
 * 塊は「まだ何も無い端末への初期移行」にだけ使う。これを許すと丸ごと上書きが戻る。
 */
export function acceptLegacySnapshot({ localDrafts, incomingRaw } = {}) {
  const local = parseDrafts(localDrafts);
  if (local.length > 0) return { accept: false, drafts: local, reason: 'LOCAL_NOT_EMPTY' };
  const incoming = parseDrafts(incomingRaw);
  if (incoming.length === 0) return { accept: false, drafts: local, reason: 'NOTHING_INCOMING' };
  return { accept: true, drafts: sortDrafts(incoming), reason: 'INITIAL_MIGRATION' };
}
