// api/mercari.js  –  Vercel Edge Function
// メルカリ商品URLから全フィールドをJSONで返す

export const config = { runtime: 'edge' };

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

// ── 非公式API ──────────────────────────────────────────────────────────
async function fetchFromMercariApi(itemId) {
  try {
    const res = await fetch(`https://api.mercari.jp/items/get?id=${itemId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const item = json.data;
    if (!item) return null;
    return normalizeApi(item);
  } catch {
    return null;
  }
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

  const cats = item.categories || [];
  const category = Array.isArray(cats)
    ? cats.map((c) => (c && typeof c === 'object' ? c.name || c.displayName : c)).filter(Boolean).join(' > ')
    : '';

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

  let currentPrice = null;
  if (item.price != null) {
    const n = Number(item.price);
    if (Number.isFinite(n)) currentPrice = n;
  }

  return {
    itemId: item.id,
    title: item.name || '',
    currentPrice,
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

function nonEmptyStr(v) {
  if (v == null) return '';
  const t = String(v).trim();
  return t;
}

function pickPrice(p, a) {
  const np = Number(p?.currentPrice);
  const na = Number(a?.currentPrice);
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

  // __NEXT_DATA__ を解析
  const ndMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const item = nd?.props?.pageProps?.item
        || nd?.props?.pageProps?.itemResponse?.item
        || nd?.props?.pageProps?.data?.item
        || findItemInObject(nd?.props);
      if (item) return normalizePageData(item, itemId, url);
    } catch {}
  }

  // og: メタタグにフォールバック
  return parseOgMeta(html, itemId, url);
}

// __NEXT_DATA__ のネスト構造を再帰探索
function findItemInObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  if (obj.id && (obj.name || obj.title) && (obj.price !== undefined)) return obj;
  for (const val of Object.values(obj)) {
    const found = findItemInObject(val, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizePageData(item, itemId, url) {
  // 画像配列の抽出（複数パターン対応）
  const images = extractImages(item);

  // カテゴリ
  const cats = item.categories || item.itemCategoryGroupList || item.category_list || [];
  const category = Array.isArray(cats)
    ? cats.map(c => c.name || c.displayName || '').filter(Boolean).join(' > ')
    : (item.category?.name || '');

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

  return {
    itemId: item.id || itemId,
    title: item.name || item.title || '',
    currentPrice: item.price ?? null,
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

function parseOgMeta(html, itemId, url) {
  const title = (html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1];
  if (!title) return null;
  const desc = (html.match(/<meta property="og:description" content="([^"]+)"/) || [])[1];
  const img = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  const priceNum = (html.match(/"price"\s*:\s*(\d+)/) || [])[1];
  return {
    itemId,
    title: title.replace(/\s*[-–]\s*メルカリ.*$/, '').trim(),
    currentPrice: priceNum ? parseInt(priceNum, 10) : null,
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
