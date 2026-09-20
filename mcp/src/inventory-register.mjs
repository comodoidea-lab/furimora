/**
 * 「出品後に、自分の出品URLから在庫へ登録する」の判断ロジック（純粋関数だけ）。
 *
 * ブラウザにもアプリにも触れない。テストできるよう、判断はここへ集める。
 * アプリの画面操作は furimora-service.mjs、ツールの組み立ては server.mjs。
 *
 * 守ること:
 * - 同じメルカリ商品が在庫にあれば登録しない（二重登録の防止）
 * - 出品開始価格は「実際の出品価格」に一致させる（バッファは出品価格 − 最低価格から決まる）
 * - 仕入れ値と最低価格は呼び出し側が明示する。既定値を持たない
 */

/** 仕入れ値のバッファの既定。「最低価格 + 800 = 出品価格」が在庫の運用 */
export const DEFAULT_BUFFER = 800;

/** 最低価格の下限。フリモーラの在庫フォームと同じ（saveNewItem） */
export const MIN_PRICE_FLOOR = 300;

/** メルカリの商品URLから商品ID（m + 数字）を取り出す。取れなければ null */
export function parseMercariItemId(url) {
  const m = String(url ?? '').match(/\/item\/(m\d+)/);
  return m ? m[1] : null;
}

/**
 * URL が、その商品 ID を指しているか。`m11` が `m111` に当たらないよう、ID の直後が数字でないことを見る。
 * ID は m + 数字だけなので、正規表現へそのまま埋めてよい（それ以外は呼び出し側で弾いている）。
 */
const urlPointsTo = (url, itemId) =>
  typeof url === 'string' && /^m\d+$/.test(itemId) && new RegExp(`/item/${itemId}(?!\\d)`).test(url);

/** 在庫に同じメルカリ商品があれば、その 1 件を返す。無ければ null */
export function findExistingItem(items, itemId) {
  if (!itemId || !Array.isArray(items)) return null;
  return items.find((it) => {
    if (!it) return false;
    if (it.mercariItemId != null && String(it.mercariItemId) === itemId) return true;
    return urlPointsTo(it.mercariUrl, itemId);
  }) ?? null;
}

/**
 * 下書きの中から、同じメルカリ商品を複製元にした最新の 1 件を探す。
 * 下書きは新しいものが先頭に入る（unshift）。id は数値のことも文字列のこともある。
 */
export function findDraftForItem(drafts, itemId) {
  if (!itemId || !Array.isArray(drafts)) return null;
  const hit = drafts.find((d) => {
    if (!d) return false;
    if (d.itemId != null && String(d.itemId) === itemId) return true;
    return urlPointsTo(d.url, itemId);
  });
  return hit ?? null;
}

const isInt = (v) => Number.isInteger(v);

/**
 * 登録内容を決める。書き込みの前に、ここで止められるものは止める。
 *
 * @param {object} p
 * @param {string} p.itemId
 * @param {{currentPrice:number, title?:string, url?:string}} p.listing メルカリの出品中一覧の 1 件
 * @param {number} p.cost 仕入れ値（円）。0 は「仕入0円」の意味。必須
 * @param {number} p.min 最低価格（円）。必須
 * @param {string} [p.purchaseDate] YYYY-MM-DD
 * @returns {{ok:true, plan:object, warnings:string[]}|{ok:false, code:string, message:string}}
 */
export function planRegistration({ itemId, listing, cost, min, purchaseDate } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!itemId) return fail('BAD_URL', '商品URLからメルカリの商品IDを取り出せません');
  if (!listing || !isInt(listing.currentPrice) || listing.currentPrice <= 0) {
    return fail('NO_LISTING_PRICE', '出品中一覧から出品価格を読み取れません');
  }
  if (!isInt(cost) || cost < 0) return fail('BAD_COST', `仕入れ値は 0 以上の整数で指定してください: ${JSON.stringify(cost)}`);
  if (!isInt(min) || min < MIN_PRICE_FLOOR) {
    return fail('BAD_MIN_PRICE', `最低価格は ${MIN_PRICE_FLOOR} 円以上の整数で指定してください: ${JSON.stringify(min)}`);
  }
  if (purchaseDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(purchaseDate))) {
    return fail('BAD_PURCHASE_DATE', `仕入日は YYYY-MM-DD で指定してください: ${JSON.stringify(purchaseDate)}`);
  }
  const start = listing.currentPrice;
  const buffer = start - min;
  if (buffer < 0) {
    return fail('MIN_ABOVE_LISTING', `最低価格 ¥${min} が出品価格 ¥${start} を上回っています。最低価格の指定ミスの可能性があります`);
  }
  const warnings = [];
  if (buffer !== DEFAULT_BUFFER) {
    warnings.push(`バッファが既定の ${DEFAULT_BUFFER} 円と違います（出品価格 ¥${start} − 最低価格 ¥${min} = ${buffer} 円）。最低価格の指定を確認してください`);
  }
  return {
    ok: true,
    warnings,
    plan: { itemId, title: listing.title ?? null, startPrice: start, minPrice: min, buffer, costPrice: cost, purchaseDate: purchaseDate ?? null },
  };
}

/**
 * 販路の手数料と配送の経費から、開始価格・最低価格で売れたときの利益を見積もる。
 * 画面の calcItemPrice と同じ式（手数料は四捨五入、経費 = 送料 + 梱包）。
 */
export function estimateProfit({ startPrice, minPrice, costPrice, feePercent, shippingCost }) {
  const at = (price) => price - Math.round((price * feePercent) / 100) - shippingCost - costPrice;
  return { atStart: at(startPrice), atMin: at(minPrice) };
}

/** 配送方法の選択肢から、使う 1 件を決める。指定が無ければアプリの既定。無い指定は止める */
export function chooseShippingMethod(options, wantedId) {
  const list = Array.isArray(options) ? options : [];
  if (wantedId) {
    const hit = list.find((o) => o.id === wantedId);
    if (!hit) {
      return { ok: false, code: 'UNKNOWN_SHIPPING_METHOD', message: `配送方法「${wantedId}」がありません。選べるもの: ${list.map((o) => o.id).join(' / ')}` };
    }
    return { ok: true, method: hit, fromDefault: false };
  }
  const def = list.find((o) => o.isDefault) || list[0];
  if (!def) return { ok: false, code: 'NO_SHIPPING_METHOD', message: '配送方法の設定がありません' };
  return { ok: true, method: def, fromDefault: true };
}

/**
 * 保存された在庫の 1 件が、期待どおりかを確かめる。ズレた項目を文章で返す（空なら一致）。
 * 「保存できた」を信用せず、読み直した値と突き合わせるために使う。
 */
export function verifyRegisteredItem(item, expected) {
  if (!item) return ['在庫に見つかりません'];
  const bad = [];
  const eq = (label, actual, want) => { if (String(actual) !== String(want)) bad.push(`${label}（期待 ${want} / 実際 ${actual}）`); };
  // 仮登録（まだ出品していない）はメルカリ商品 ID が無い。expected.mercariItemId が undefined のときは見ない
  if (expected.mercariItemId !== undefined) eq('メルカリ商品ID', item.mercariItemId, expected.mercariItemId);
  if (expected.title != null) eq('タイトル', item.title, expected.title);
  eq('仕入れ値', item.costPrice, expected.costPrice);
  eq('最低価格', item.minPrice, expected.minPrice);
  eq('開始価格', item.startPrice, expected.startPrice);
  eq('現在価格', item.currentPrice, expected.startPrice);
  eq('状態', item.status, 'active');
  if (expected.shippingCost != null) eq('送料+梱包（経費）', item.shippingCost, expected.shippingCost);
  if (!item.title) bad.push('タイトルが空です');
  return bad;
}

/**
 * 仮登録の在庫（メルカリ商品 ID もURLも無い出品中の在庫）で、タイトルが同じもの。
 * 出品後の紐づけ候補であり、仮登録の二重作成を防ぐ検査にも使う。
 * 価格は見ない（出品時に価格を変えても紐づけられるように）。
 */
export function findAdoptionCandidates(items, { title } = {}) {
  if (!Array.isArray(items) || !title) return [];
  return items.filter((it) => it && it.status === 'active' && !it.mercariItemId && !it.mercariUrl && it.title === title);
}

/**
 * 仮登録の内容を決める。メルカリの下書きを作る前に止められるものはここで止める。
 * 出品価格 = 最低価格 + バッファ。バッファが既定の 800 と違えば警告する（止めはしない）。
 */
export function planPending({ title, price, min, cost, purchaseDate } = {}) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (!title || !String(title).trim()) return fail('BAD_TITLE', 'タイトルが空です');
  if (!isInt(price) || price < MIN_PRICE_FLOOR) return fail('BAD_PRICE', `出品価格は ${MIN_PRICE_FLOOR} 円以上の整数で指定してください: ${JSON.stringify(price)}`);
  if (!isInt(cost) || cost < 0) return fail('BAD_COST', `仕入れ値は 0 以上の整数で指定してください: ${JSON.stringify(cost)}`);
  if (!isInt(min) || min < MIN_PRICE_FLOOR) return fail('BAD_MIN_PRICE', `最低価格は ${MIN_PRICE_FLOOR} 円以上の整数で指定してください: ${JSON.stringify(min)}`);
  if (purchaseDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(purchaseDate))) {
    return fail('BAD_PURCHASE_DATE', `仕入日は YYYY-MM-DD で指定してください: ${JSON.stringify(purchaseDate)}`);
  }
  const buffer = price - min;
  if (buffer < 0) return fail('MIN_ABOVE_PRICE', `最低価格 ¥${min} が出品価格 ¥${price} を上回っています。最低価格の指定ミスの可能性があります`);
  const warnings = [];
  if (buffer !== DEFAULT_BUFFER) {
    warnings.push(`バッファが既定の ${DEFAULT_BUFFER} 円と違います（出品価格 ¥${price} − 最低価格 ¥${min} = ${buffer} 円）。最低価格の指定を確認してください`);
  }
  return { ok: true, warnings, plan: { title: String(title), startPrice: price, minPrice: min, buffer, costPrice: cost, purchaseDate: purchaseDate ?? null } };
}

/**
 * 出品後の紐づけ先（仮登録の在庫）を決める。
 * - `adoptItemId` を指定したら、その在庫を使う（未紐づけの出品中であること）
 * - 指定が無ければ、タイトルが同じ仮登録を探す。0 件なら `pending: null`（新しく登録する）
 * - 2 件以上あれば、推測せず止める
 */
export function choosePending(items, { title, adoptItemId } = {}) {
  const list = Array.isArray(items) ? items : [];
  const brief = (it) => ({ id: it.id, title: it.title, startPrice: it.startPrice, minPrice: it.minPrice, costPrice: it.costPrice });
  if (adoptItemId != null && adoptItemId !== '') {
    const hit = list.find((it) => it && String(it.id) === String(adoptItemId));
    if (!hit) return { ok: false, code: 'PENDING_NOT_FOUND', message: `在庫 ${adoptItemId} が見つかりません` };
    if (hit.status !== 'active' || hit.mercariItemId || hit.mercariUrl) {
      return { ok: false, code: 'NOT_PENDING', message: `在庫 ${adoptItemId} は仮登録ではありません（すでにメルカリ商品に紐づいているか、出品中ではありません）` };
    }
    return { ok: true, pending: hit };
  }
  const c = findAdoptionCandidates(list, { title });
  if (c.length === 0) return { ok: true, pending: null };
  if (c.length > 1) {
    return {
      ok: false, code: 'AMBIGUOUS_PENDING', candidates: c.map(brief),
      message: `同じタイトルの仮登録が ${c.length} 件あり、どれに紐づけるか決められません。adopt_item_id で指定してください`,
    };
  }
  return { ok: true, pending: c[0] };
}
