// api/mercari.js  –  Vercel Edge Function
// メルカリ商品URLから全フィールドをJSONで返す
//
// api.mercari.jp/items/get は DPoP（RFC 9449）付きでないと拒否される。
// 参考: take-kun/mercapi（Python）と同様に ES256 + uuid を payload に含める。

import { SignJWT } from 'jose';

export const config = { runtime: 'edge' };

/** アイソレート内で鍵とクライアント uuid を再利用（mercapi と同様の挙動） */
async function getMercariDpopState() {
  const g = globalThis;
  if (!g.__furimoraMercariDpop) {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign']
    );
    const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    g.__furimoraMercariDpop = {
      privateKey: keyPair.privateKey,
      publicJwk: pubJwk,
      uuid: crypto.randomUUID(),
    };
  }
  return g.__furimoraMercariDpop;
}

async function buildMercariDPoP(fullUrl, method) {
  const { privateKey, publicJwk, uuid } = await getMercariDpopState();
  return new SignJWT({
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    htu: fullUrl,
    htm: String(method).toUpperCase(),
    uuid,
  })
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: {
        crv: publicJwk.crv,
        kty: publicJwk.kty,
        x: publicJwk.x,
        y: publicJwk.y,
      },
    })
    .sign(privateKey);
}

/** ユーザー入力は検証後、必ずこの canonical URL のみ fetch する（SSRF 防止） */
function parseMercariItemUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hostname.toLowerCase() !== 'jp.mercari.com') return null;
  const m = u.pathname.match(/\/item\/(m\w+)/i);
  if (!m) return null;
  const itemId = m[1];
  const canonicalPageUrl = `https://jp.mercari.com/item/${itemId}`;
  return { itemId, canonicalPageUrl };
}

/** 共有テキストなどから商品 URL 部分だけ抜き出す */
function extractJpMercariItemUrlFromBlob(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/https:\/\/jp\.mercari\.com\/item\/m\w+/i);
  return m ? m[0] : null;
}

function extractMercLiFromBlob(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/https:\/\/merc\.li\/[a-zA-Z0-9_-]+/i);
  return m ? m[0] : null;
}

/** merc.li のみ追跡 fetch。ホストは正規表現で merc.li に限定（SSRF 防止） */
async function resolveMercLiToParsed(shortHref) {
  let shortUrl;
  try {
    shortUrl = new URL(shortHref);
  } catch {
    return null;
  }
  if (shortUrl.hostname.toLowerCase() !== 'merc.li') return null;
  const res = await fetch(shortUrl.href, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(12000),
  });
  return parseMercariItemUrl(res.url);
}

/**
 * クエリの url は生テキスト可（共有文のまま）。jp.mercari / merc.li を解決する。
 */
async function resolveMercariQueryToParsed(raw) {
  const blob = String(raw).trim();
  if (!blob) return null;

  const jpExtracted = extractJpMercariItemUrlFromBlob(blob);
  if (jpExtracted) {
    const p = parseMercariItemUrl(jpExtracted);
    if (p) return p;
  }

  let p = parseMercariItemUrl(blob);
  if (p) return p;

  const li = extractMercLiFromBlob(blob);
  if (li) {
    p = await resolveMercLiToParsed(li);
    if (p) return p;
  }

  return null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  if (!url) return jsonResponse({ error: 'url パラメータが必要です' }, 400);

  const parsed = await resolveMercariQueryToParsed(url);
  if (!parsed) {
    return jsonResponse(
      {
        error:
          '有効なメルカリ商品URLが見つかりません。アドレスバーの https://jp.mercari.com/item/m… 、または merc.li の短縮URLをそのまま貼り付けてください。',
        code: 'BAD_URL',
      },
      400
    );
  }
  const { itemId, canonicalPageUrl } = parsed;

  try {
    // 拡張機能は __NEXT_DATA__ 基準。URL 経路は API だけだとスキーマ差で品質が落ちるため、
    // ページ（Next と同等）と API を並列取得し、不足を相互補完する。
    const [apiData, pageData] = await Promise.all([
      fetchFromMercariApi(itemId),
      fetchFromPageSafe(canonicalPageUrl, itemId),
    ]);

    const merged = mergeMercariSources(pageData, apiData);
    if (merged) return jsonResponse(merged);

    return jsonResponse({ error: '商品データを取得できませんでした' }, 404);
  } catch (err) {
    console.error('[mercari]', err);
    return jsonResponse({ error: '商品データの取得中にエラーが発生しました' }, 500);
  }
}

// ── 非公式API（DPoP 必須）──────────────────────────────────────────────
async function fetchFromMercariApi(itemId) {
  try {
    const apiUrl = `https://api.mercari.jp/items/get?id=${encodeURIComponent(itemId)}`;
    const dpop = await buildMercariDPoP(apiUrl, 'GET');
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'X-Platform': 'web',
        DPoP: dpop,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.result === 'error' || !json.data) return null;
    const item = json.data;
    if (!item) return null;
    return normalizeApi(item);
  } catch (e) {
    console.error('[mercari] fetchFromMercariApi', e);
    return null;
  }
}

/**
 * メルカリ item からカテゴリパス文字列を組み立てる。
 * API は item.categories が空で item_category（root / parent / name）のみ返すことがある。
 */
function buildCategoryString(item) {
  if (!item || typeof item !== 'object') return '';
  const cats =
    item.categories || item.itemCategoryGroupList || item.category_list || [];
  if (Array.isArray(cats) && cats.length) {
    return cats
      .map((c) =>
        c && typeof c === 'object'
          ? c.name || c.displayName || c.root_category_name || ''
          : String(c || '')
      )
      .filter(Boolean)
      .join(' > ');
  }
  const ic = item.item_category || item.itemCategory;
  if (ic && typeof ic === 'object') {
    const parts = [];
    if (ic.root_category_name) parts.push(String(ic.root_category_name));
    if (ic.parent_category_name) parts.push(String(ic.parent_category_name));
    if (ic.name) parts.push(String(ic.name));
    const deduped = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
    return deduped.join(' > ');
  }
  if (item.category && typeof item.category === 'object' && item.category.name) {
    return String(item.category.name);
  }
  return '';
}

function normalizeApi(item) {
  const photos = item.photos || [];
  const images = [];
  for (const p of photos) {
    if (!p) continue;
    if (typeof p === 'string') {
      images.push(p.split('?')[0]);
      continue;
    }
    const u = p.image_url || p.imageUrl || p.thumbnail_url || p.url;
    if (u) images.push(String(u).split('?')[0]);
  }
  if (!images.length && item.thumbnails) {
    const th = item.thumbnails;
    if (Array.isArray(th)) {
      for (const t of th) {
        if (!t) continue;
        const u = typeof t === 'string' ? t : t.url || t.image_url;
        if (u) images.push(String(u).split('?')[0]);
      }
    }
  }

  const category = buildCategoryString(item);

  const condObj = item.item_condition || item.itemCondition || {};
  const condition =
    condObj.name || condObj.displayName || conditionLabel(condObj.id ?? item.item_condition_id);

  const payerObj = item.shipping_payer || item.shippingPayer || {};
  const payerId = payerObj.id ?? item.shipping_payer_id ?? item.shippingPayerId;
  const shippingPayer =
    payerObj.name ||
    (payerId === 1 ? '送料込み（出品者負担）' : payerId === 2 ? '着払い（購入者負担）' : '');

  const methodObj = item.shipping_method || item.shippingMethod || {};
  const shippingMethod = methodObj.name || methodObj.displayName || '';

  const fromObj = item.shipping_from_area || item.shippingFromArea || {};
  const shippingFrom = fromObj.name || fromObj.displayName || '';

  const daysObj = item.shipping_duration || item.shippingDuration || {};
  const shippingDays = daysObj.name || daysObj.displayName || '';

  const currentPrice = coercePriceFromItem(item);

  return {
    itemId: item.id,
    title: item.name || '',
    currentPrice,
    price: currentPrice,
    description: item.description || '',
    category,
    condition,
    shippingPayer,
    shippingMethod,
    shippingFrom,
    shippingDays,
    images,
    thumbnailUrl: images[0] || null,
    status: item.status || '',
    url: `https://jp.mercari.com/item/${item.id}`,
    source: 'api',
  };
}

/**
 * メルカリ API / Next の item で price が number / string / { amount } などになる場合に対応
 */
function coercePriceFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const candidates = [
    item.price,
    item.itemPrice,
    item.salePrice,
    item.item?.price,
    item.item?.itemPrice,
    item.itemStatus?.price,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c > 0 ? c : null;
    if (typeof c === 'string') {
      const n = parseInt(String(c).replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (typeof c === 'object' && c !== null) {
      const amt = c.amount ?? c.value ?? c.price;
      if (amt != null) {
        const n = Number(amt);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return null;
}

function nonEmptyStr(v) {
  if (v == null) return '';
  const t = String(v).trim();
  return t;
}

function pickPrice(p, a) {
  const np = Number(p?.currentPrice ?? p?.price);
  const na = Number(a?.currentPrice ?? a?.price);
  if (Number.isFinite(np) && np > 0) return np;
  if (Number.isFinite(na) && na > 0) return na;
  if (Number.isFinite(np)) return np;
  if (Number.isFinite(na)) return na;
  return null;
}

/** ページ（__NEXT_DATA__ 相当）を優先しつつ API で穴埋め — Chrome 拡張に近い品質に寄せる */
function mergeMercariSources(page, api) {
  if (!page && !api) return null;
  if (!page) return finalizeRecord(api);
  if (!api) return finalizeRecord(page);

  const p = page;
  const a = api;
  const nP = p.images?.length || 0;
  const nA = a.images?.length || 0;
  const images =
    nP >= nA && nP > 0 ? p.images : nA > 0 ? a.images : p.images || a.images || [];

  const merged = {
    itemId: p.itemId || a.itemId,
    title: nonEmptyStr(p.title) || nonEmptyStr(a.title) || '',
    description: nonEmptyStr(p.description) || nonEmptyStr(a.description) || '',
    currentPrice: pickPrice(p, a),
    category: nonEmptyStr(p.category) || nonEmptyStr(a.category) || '',
    condition: nonEmptyStr(p.condition) || nonEmptyStr(a.condition) || '',
    shippingPayer: nonEmptyStr(p.shippingPayer) || nonEmptyStr(a.shippingPayer) || '',
    shippingMethod: nonEmptyStr(p.shippingMethod) || nonEmptyStr(a.shippingMethod) || '',
    shippingFrom: nonEmptyStr(p.shippingFrom) || nonEmptyStr(a.shippingFrom) || '',
    shippingDays: nonEmptyStr(p.shippingDays) || nonEmptyStr(a.shippingDays) || '',
    images,
    thumbnailUrl: images[0] || p.thumbnailUrl || a.thumbnailUrl || null,
    status: nonEmptyStr(p.status) || nonEmptyStr(a.status) || '',
    url: p.url || a.url,
    source: 'merged',
  };
  merged.price = merged.currentPrice;
  return finalizeRecord(merged);
}

function finalizeRecord(rec) {
  if (!rec) return null;
  return {
    ...rec,
    title: decodeHtmlEntities(rec.title || ''),
    description: decodeHtmlEntities(rec.description || ''),
  };
}

async function fetchFromPageSafe(url, itemId) {
  try {
    return await fetchFromPage(url, itemId);
  } catch (e) {
    console.error('[mercari] fetchFromPage', e);
    return null;
  }
}

// ── ページスクレイプ ────────────────────────────────────────────────────
async function fetchFromPage(url, itemId) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja-JP,ja;q=0.9',
      'Cache-Control': 'no-cache',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // __NEXT_DATA__ — [^<]+ だと JSON 内の '<' で途切れて parse 失敗するため境界で切り出す
  const ndJson = extractNextDataJson(html);
  if (ndJson) {
    try {
      const nd = JSON.parse(ndJson);
      const item = nd?.props?.pageProps?.item
        || nd?.props?.pageProps?.itemResponse?.item
        || nd?.props?.pageProps?.data?.item
        || findItemInObject(nd?.props);
      if (item) {
        const row = normalizePageData(item, itemId, url);
        if (row.currentPrice == null || row.currentPrice === 0) {
          const fromLd = extractPriceFromLdJson(html);
          if (fromLd != null && fromLd > 0) row.currentPrice = fromLd;
          else {
            const fromHtml = extractPriceFromItemPageHtml(html);
            if (fromHtml != null && fromHtml > 0) row.currentPrice = fromHtml;
          }
        }
        row.price = row.currentPrice;
        return await maybeExpandMercdnImages(row, itemId);
      }
    } catch (e) {
      console.error('[mercari] __NEXT_DATA__ parse', e);
    }
  }

  // og: メタタグにフォールバック（現行 SSR では商品 JSON が無く、SEO 用 meta のみのことが多い）
  let og = parseOgMeta(html, itemId, url);
  if (og) {
    if (isGenericMercariSeoDescription(og.description)) og.description = '';
    if (og.currentPrice == null || og.currentPrice === 0) {
      const fromLd = extractPriceFromLdJson(html);
      if (fromLd != null && fromLd > 0) og.currentPrice = fromLd;
      else {
        const fromHtml = extractPriceFromItemPageHtml(html);
        if (fromHtml != null && fromHtml > 0) og.currentPrice = fromHtml;
      }
      og.price = og.currentPrice;
    }
    og = await maybeExpandMercdnImages(og, itemId);
  }
  return og;
}

function extractNextDataJson(html) {
  const startMark = '<script id="__NEXT_DATA__" type="application/json">';
  const i = html.indexOf(startMark);
  if (i === -1) return null;
  const jsonStart = i + startMark.length;
  const j = html.indexOf('</script>', jsonStart);
  if (j === -1) return null;
  return html.slice(jsonStart, j);
}

/** 説明文内の '<' 等で item が取れない場合に備え、id が m で始まる商品オブジェクトを探索 */
function looksLikeMercariItem(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const sid = obj.id != null ? String(obj.id) : '';
  if (!/^m\d/i.test(sid)) return false;
  return !!(obj.name || obj.title);
}

// __NEXT_DATA__ のネスト構造を再帰探索
function findItemInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;
  if (looksLikeMercariItem(obj)) return obj;
  for (const val of Object.values(obj)) {
    const found = findItemInObject(val, depth + 1);
    if (found) return found;
  }
  return null;
}

/** schema.org Product / Offer から価格 */
function extractPriceFromLdJson(html) {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      const nodes = Array.isArray(j) ? j : [j];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const types = ([]).concat(node['@type'] || []);
        const isProduct = types.some((t) => t === 'Product' || t === 'product');
        if (!isProduct && !node.offers) continue;
        const off = node.offers;
        if (!off) continue;
        const offer = Array.isArray(off) ? off[0] : off;
        const p = offer?.price ?? offer?.lowPrice ?? offer?.highPrice;
        if (p != null) {
          const n = typeof p === 'string' ? parseInt(p.replace(/[^\d]/g, ''), 10) : Number(p);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
    } catch {
      /* next script */
    }
  }
  return null;
}

/** JSON 文字列または DOM から商品価格らしき数値（関連出品の高額を拾わないよう __NEXT_DATA__ 内を優先） */
function extractPriceFromItemPageHtml(html) {
  const metaPrice = extractMercariMetaPrice(html);
  if (metaPrice != null) return metaPrice;

  const nd = extractNextDataJson(html);
  if (nd) {
    const m = nd.match(/"price"\s*:\s*(\d{2,8})\b/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 100) return n;
    }
  }
  const dom = html.match(/data-testid="price"[^>]*>[\s\S]{0,240}?([\d,]+)\s*円/i);
  if (dom) {
    const n = parseInt(dom[1].replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 100) return n;
  }
  const yen = html.match(/data-testid="price"[^>]*>[\s\S]{0,240}?¥\s*([\d,]+)/);
  if (yen) {
    const n = parseInt(yen[1].replace(/,/g, ''), 10);
    if (Number.isFinite(n) && n >= 100) return n;
  }
  return null;
}

function normalizePageData(item, itemId, url) {
  // 画像配列の抽出（複数パターン対応）
  const images = extractImages(item);

  const category = buildCategoryString(item);

  // 商品状態
  const condition = item.itemCondition?.name
    || conditionLabel(item.itemConditionId || item.item_condition_id)
    || '';

  // 配送情報
  const shippingPayer = item.shippingPayer?.name
    || (item.shippingPayerId === 1 ? '送料込み（出品者負担）' : item.shippingPayerId === 2 ? '着払い（購入者負担）' : '');
  const shippingMethod = item.shippingMethod?.name || item.shipping?.name || '';
  const shippingFrom = item.shippingFromArea?.name || '';
  const shippingDays = item.shippingDuration?.name || item.shippingDays?.name || '';

  const cp = coercePriceFromItem(item);
  return {
    itemId: item.id || itemId,
    title: item.name || item.title || '',
    currentPrice: cp,
    price: cp,
    description: item.description || '',
    category,
    condition,
    shippingPayer,
    shippingMethod,
    shippingFrom,
    shippingDays,
    images,
    thumbnailUrl: images[0] || null,
    status: item.status || '',
    url: url || `https://jp.mercari.com/item/${itemId}`,
    source: 'page',
  };
}

function extractImages(item) {
  const images = [];
  // パターン1: photos配列
  if (Array.isArray(item.photos)) {
    for (const p of item.photos) {
      const u = p.imageUrl || p.image_url || p.url || (typeof p === 'string' ? p : null);
      if (u) images.push(u.split('?')[0]); // クエリストリング除去
    }
  }
  // パターン2: thumbnails配列
  if (!images.length && Array.isArray(item.thumbnails)) {
    images.push(...item.thumbnails.filter(Boolean));
  }
  // パターン3: 単体
  if (!images.length) {
    const single = item.thumbnailUrl || item.thumbnail_url || item.image_url;
    if (single) images.push(single);
  }
  return images;
}

/**
 * App Router 化後の商品ページでは __NEXT_DATA__ が無く、価格が meta のみに出ることが多い。
 * 例: <meta name="product:price:amount" content="3280"/>
 */
/** og:description のメルカリ共通 SEO 文（出品者の説明文ではない） */
function isGenericMercariSeoDescription(desc) {
  if (!desc || typeof desc !== 'string') return false;
  const t = desc.trim();
  return (
    t.includes('誰でも安心して簡単に売り買いが楽しめるフリマサービス') ||
    t.includes('品物が届いてから出品者に入金される独自システム') ||
    t.includes('をメルカリでお得に通販')
  );
}

/**
 * og 画像は 1 枚のみのことが多いが、mercdn は連番 URL で実在する — HEAD で列挙して拡張。
 */
async function probeMercdnPhotoUrls(itemId, sampleUrl) {
  const urls = [];
  let prefix;
  if (sampleUrl && /mercdn\.net\/item\//i.test(sampleUrl)) {
    const m = sampleUrl.match(
      /^(https:\/\/static\.mercdn\.net\/item\/detail\/orig\/photos\/m[a-zA-Z0-9]+)_\d+\.jpg/i
    );
    if (m) prefix = m[1];
  }
  if (!prefix) {
    prefix = `https://static.mercdn.net/item/detail/orig/photos/${itemId}`;
  }
  for (let n = 1; n <= 24; n++) {
    const u = `${prefix}_${n}.jpg`;
    try {
      const res = await fetch(u, {
        method: 'HEAD',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        },
        signal: AbortSignal.timeout(4500),
      });
      if (res.ok) urls.push(u);
      else break;
    } catch {
      break;
    }
  }
  return urls;
}

async function maybeExpandMercdnImages(row, itemId) {
  if (!row || !itemId) return row;
  if (row.images && row.images.length > 1) return row;
  const sample = row.images?.[0] || row.thumbnailUrl || '';
  const probed = await probeMercdnPhotoUrls(itemId, sample);
  if (probed.length === 0) return row;
  row.images = probed;
  row.thumbnailUrl = probed[0];
  return row;
}

function extractMercariMetaPrice(html) {
  if (!html || typeof html !== 'string') return null;
  const patterns = [
    /name="product:price:amount"[^>]*content="(\d+)"/i,
    /property="product:price:amount"[^>]*content="(\d+)"/i,
    /content="(\d+)"[^>]*name="product:price:amount"/i,
    /content="(\d+)"[^>]*property="product:price:amount"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  // RSC Flight 内のエスケープされた meta 表現
  const rsc = html.match(/\\"product:price:amount\\",\\"content\\":\\"(\d+)\\"/);
  if (rsc) {
    const n = parseInt(rsc[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parseOgMeta(html, itemId, url) {
  const title = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1];
  if (!title) return null;
  const desc = (html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1];
  const img = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  const fromProductMeta = extractMercariMetaPrice(html);
  const priceNum = (html.match(/"price"\s*:\s*(\d+)/) || [])[1];
  const cp = fromProductMeta ?? (priceNum ? parseInt(priceNum, 10) : null);
  const cleanTitle = title
    .replace(/\s*[-–]\s*メルカリ.*$/, '')
    .replace(/\s+by\s+メルカリ\s*$/i, '')
    .trim();
  return {
    itemId,
    title: cleanTitle,
    currentPrice: cp,
    price: cp,
    description: desc || '',
    category: '', condition: '',
    shippingPayer: '', shippingMethod: '', shippingFrom: '', shippingDays: '',
    images: img ? [img] : [],
    thumbnailUrl: img || null,
    url: `https://jp.mercari.com/item/${itemId}`,
    source: 'og-meta',
  };
}

function conditionLabel(id) {
  const map = { 1: '新品・未使用', 2: '未使用に近い', 3: '目立った傷や汚れなし', 4: 'やや傷や汚れあり', 5: '傷や汚れあり', 6: '全体的に状態が悪い' };
  return map[id] || '';
}

function decodeHtmlEntities(str) {
  if (str == null || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
