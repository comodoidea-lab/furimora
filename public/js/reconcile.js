/**
 * 在庫リストと出品側の実データを突き合わせる純粋関数（ブラウザ / Node 共用・ESM）。
 *
 * 目的は「売れているのに手元では出品中のまま」を見つけること。
 * 副作用なし・依存なし・DOM もネットワークも触らない。
 *
 * 特定のアプリの型に依存しないよう、フィールドの読み方は adapter で差し替えられる。
 * 既定の adapter はフリモーラの在庫アイテム向け。
 */

/** レコードからメルカリの商品 ID を取り出す。取れなければ null。 */
export function extractMercariItemId(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const direct = rec.mercariItemId ?? rec.itemId;
  if (direct != null && /^m\d{9,}$/i.test(String(direct).trim())) return String(direct).trim();
  for (const key of ['mercariUrl', 'url']) {
    const v = rec[key];
    if (typeof v === 'string') {
      const m = v.match(/\/item\/(m\d{9,})/i);
      if (m) return m[1];
    }
  }
  return null;
}

/** フリモーラの在庫アイテム向けの既定 adapter */
export const FURIMORA_ADAPTER = {
  id: extractMercariItemId,
  title: (r) => r.title ?? '',
  price: (r) => {
    const n = Number(r.currentPrice ?? r.price);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  /** 手元で「まだ出品中のつもり」か */
  isActive: (r) => r.status === 'active' || r.status === 'relisted',
  /** 手元で「売却済み」か */
  isSold: (r) => r.status === 'sold',
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * 突き合わせる。
 *
 * @param {object} input
 * @param {object[]} input.local        手元の在庫リスト
 * @param {object[]} input.remoteActive 出品側の「出品中」一覧
 * @param {object[]} [input.remoteSold] 出品側の「売却済み」一覧（あれば判定精度が上がる）
 * @param {boolean}  [input.remoteTruncated] 出品側の取得が上限で打ち切られたか
 * @param {object}   [input.adapter]    フィールドの読み方（既定はフリモーラ向け）
 * @param {number}   [input.priceTolerance] 価格差をズレとみなさない許容額（既定 0）
 */
export function reconcileListings(input) {
  const a = { ...FURIMORA_ADAPTER, ...(input.adapter || {}) };
  const local = Array.isArray(input.local) ? input.local : [];
  const remoteActive = Array.isArray(input.remoteActive) ? input.remoteActive : [];
  const remoteSold = Array.isArray(input.remoteSold) ? input.remoteSold : [];
  const truncated = input.remoteTruncated === true;
  const tol = Number(input.priceTolerance) || 0;

  const activeMap = new Map();
  remoteActive.forEach((r) => { const id = extractMercariItemId(r); if (id) activeMap.set(id, r); });
  const soldMap = new Map();
  remoteSold.forEach((r) => { const id = extractMercariItemId(r); if (id) soldMap.set(id, r); });

  const soldButActive = [];   // 手元は出品中、出品側は売却済み ← 主目的
  const priceMismatch = [];   // 両方出品中だが価格が違う
  const missingRemotely = []; // 手元は出品中、出品側のどちらにも無い（削除された可能性）
  const relistedButSold = []; // 手元は売却済み、出品側では出品中（再出品したのに未更新）
  const unlinked = [];        // メルカリIDが未設定で突き合わせできない
  const matched = [];

  for (const item of local) {
    const id = a.id(item);
    if (!id) { unlinked.push({ title: a.title(item), reason: 'メルカリの商品IDまたはURLが未設定' }); continue; }
    const inActive = activeMap.get(id);
    const inSold = soldMap.get(id);
    const localPrice = a.price(item);

    if (a.isActive(item)) {
      if (inSold) {
        soldButActive.push({ itemId: id, title: a.title(item), localPrice, soldPrice: num(inSold.currentPrice) });
      } else if (inActive) {
        const rp = num(inActive.currentPrice);
        if (localPrice != null && rp != null && Math.abs(localPrice - rp) > tol) {
          priceMismatch.push({ itemId: id, title: a.title(item), localPrice, remotePrice: rp, diff: rp - localPrice });
        } else {
          matched.push({ itemId: id });
        }
      } else if (!truncated) {
        missingRemotely.push({ itemId: id, title: a.title(item), localPrice });
      }
      continue;
    }

    if (a.isSold(item) && inActive) {
      relistedButSold.push({ itemId: id, title: a.title(item), remotePrice: num(inActive.currentPrice) });
      continue;
    }
    matched.push({ itemId: id });
  }

  // 出品側にあるが手元に無い
  const localIds = new Set(local.map((i) => a.id(i)).filter(Boolean));
  const missingLocally = remoteActive
    .map((r) => ({ r, id: extractMercariItemId(r) }))
    .filter(({ id }) => id && !localIds.has(id))
    .map(({ r, id }) => ({ itemId: id, title: r.title || '', remotePrice: num(r.currentPrice) }));

  return {
    soldButActive, priceMismatch, missingRemotely, relistedButSold, missingLocally, unlinked,
    summary: {
      localCount: local.length,
      remoteActiveCount: remoteActive.length,
      remoteSoldCount: remoteSold.length,
      matchedCount: matched.length,
      soldButActive: soldButActive.length,
      priceMismatch: priceMismatch.length,
      missingRemotely: missingRemotely.length,
      relistedButSold: relistedButSold.length,
      missingLocally: missingLocally.length,
      unlinked: unlinked.length,
      // 取得が打ち切られている場合、「出品側に無い」判定は信用できないので出さない
      remoteTruncated: truncated,
      notes: truncated
        ? ['出品側の取得が上限で打ち切られているため、「出品側に無い」判定は行っていません']
        : [],
    },
  };
}
