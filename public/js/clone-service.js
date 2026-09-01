/**
 * クローンデータ取得の共通層（ブラウザ / Node 共用・ESM）
 *
 * ここには DOM・トースト・ボタン状態を一切書かない。
 * 人間の導線（public/index.html の UI、Chrome 拡張から渡る clone_data）と
 * エージェントの導線（MCP サーバー）が、同じ実装に着地するための層。
 *
 * 正規の取得経路は /api/mercari（実装は api/mercari.js。非公式 API + ページ解析をマージ）。
 *
 * 環境差はコンストラクタ引数だけで吸収する:
 *   ブラウザ: createCloneService({ useRelativeApi: true, apiOrigins: [...] })
 *   Node    : createCloneService({ apiOrigins: ['https://furimora.vercel.app'] })
 */

/** クローン Step2 が必要とする項目（充足度の判定にも使う） */
export const CLONE_FIELDS = [
  'title', 'currentPrice', 'description', 'category', 'condition',
  'shippingPayer', 'shippingMethod', 'shippingFrom', 'shippingDays', 'images',
];

export function isMercariUrlLike(s) {
  return typeof s === 'string' && (/jp\.mercari\.com\/item\/m/i.test(s) || /merc\.li\//i.test(s));
}

export function extractUrl(s) {
  if (!s || typeof s !== 'string') return '';
  const jp = s.match(/https:\/\/jp\.mercari\.com\/item\/m\w+/i);
  if (jp) return jp[0];
  const li = s.match(/https:\/\/merc\.li\/[a-zA-Z0-9_-]+/i);
  if (li) return li[0];
  return '';
}

export function describeFailure(res, data) {
  if (data && data.code === 'BAD_URL') return data.error;
  if (res.status === 404 || (data && data.error === '商品データを取得できませんでした')) {
    return 'この商品情報は取得できませんでした（削除・非公開・売り切れ、または一時的な障害の可能性があります）。';
  }
  if (res.status === 400) return (data && data.error) ? data.error : 'URLの形式を確認してください。';
  if (res.status >= 500) return 'サーバーでエラーが発生しました。しばらくしてから再度お試しください。';
  return (data && data.error) || '商品情報を取得できませんでした。URLを確認してください。';
}

export function inferItemId(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.itemId) return String(d.itemId);
  const u = d.url;
  if (typeof u === 'string') {
    const m = u.match(/\/item\/(m\w+)/i);
    if (m) return m[1];
  }
  const imgs = d.images;
  if (Array.isArray(imgs)) {
    for (const src of imgs) {
      const s = String(src);
      const im = s.match(/(m\d{8,})/);
      if (im) return im[1];
    }
  }
  return null;
}

export function normalize(d) {
  if (!d || typeof d !== 'object') return d;
  const itemId = inferItemId(d);
  const url = d.url || (itemId ? `https://jp.mercari.com/item/${itemId}` : '');
  const rawP = d.currentPrice != null ? d.currentPrice : d.price;
  let numP = typeof rawP === 'string' ? parseInt(rawP.replace(/[^\d]/g, ''), 10) : Number(rawP);
  if (!Number.isFinite(numP) || numP < 0) numP = null;
  return { ...d, itemId: itemId || d.itemId, url: url || d.url, currentPrice: numP, price: numP };
}

export function mergePartial(partial, api) {
  if (!api || api.error) return partial;
  const out = { ...api };
  if (partial.title) out.title = partial.title;
  if (partial.description) out.description = partial.description;
  if (Array.isArray(partial.images) && partial.images.length) out.images = partial.images;
  if (partial.thumbnailUrl) out.thumbnailUrl = partial.thumbnailUrl;
  const pp = Number(partial.currentPrice ?? partial.price);
  if (Number.isFinite(pp) && pp > 0) {
    out.currentPrice = pp;
    out.price = pp;
  }
  if (partial.likesCount != null) out.likesCount = partial.likesCount;
  ['category', 'condition', 'shippingPayer', 'shippingMethod', 'shippingFrom', 'shippingDays'].forEach((k) => {
    const v = partial[k];
    if (v != null && String(v).trim() !== '') out[k] = v;
  });
  return out;
}

/** Step2 に必要な項目がどれだけ揃っているか。導線ごとの品質比較と MCP の応答に使う。 */
export function completeness(data) {
  const filled = CLONE_FIELDS.filter((f) => {
    const v = data && data[f];
    return Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '';
  });
  return {
    filled: filled.length,
    total: CLONE_FIELDS.length,
    missing: CLONE_FIELDS.filter((f) => !filled.includes(f)),
  };
}

/** Chrome 拡張互換: ?clone_data= の base64 JSON をデコードする */
export function decodeLegacyCloneData(encoded) {
  try {
    return normalize(JSON.parse(decodeURIComponent(escape(atob(encoded)))));
  } catch (e) {
    return null;
  }
}

/**
 * 取得系をまとめたサービスを作る。
 * @param {object} [options]
 * @param {string[]} [options.apiOrigins] /api/mercari を持つオリジン。先頭から順に試す
 * @param {boolean} [options.useRelativeApi] 同一オリジンの /api/mercari を最優先で試す（ブラウザ用）
 * @param {Function} [options.fetchImpl] fetch の差し替え（テスト用）
 */
export function createCloneService(options = {}) {
  const apiOrigins = Array.isArray(options.apiOrigins) ? options.apiOrigins : [];
  const useRelativeApi = options.useRelativeApi === true;
  const doFetch = options.fetchImpl || ((...args) => globalThis.fetch(...args));

  if (!useRelativeApi && apiOrigins.length === 0) {
    throw new Error('createCloneService: apiOrigins か useRelativeApi のいずれかが必要です');
  }

  /** /api/mercari のエンドポイント候補。同一実装の既知オリジンへ順にフォールバックする。 */
  function endpointsFor(query) {
    const q = encodeURIComponent(query);
    const list = apiOrigins.map((origin) => `${origin}/api/mercari?url=${q}`);
    return useRelativeApi ? ['/api/mercari?url=' + q, ...list] : list;
  }

  /**
   * URL（または URL を含む共有文）から商品データを取得する。
   * @param {string} rawInput アドレスバーの URL、または共有文そのまま
   * @returns {Promise<{ok:true,data:object}|{ok:false,code:string,message:string}>}
   */
  async function fetchItem(rawInput) {
    const raw = String(rawInput ?? '').trim();
    if (!raw) {
      return { ok: false, code: 'EMPTY_INPUT', message: '商品ページのURLを入力するか、クリップボードから貼り付けてください。' };
    }
    const payload = extractUrl(raw) || raw;
    if (!isMercariUrlLike(payload)) {
      return {
        ok: false, code: 'BAD_URL',
        message: 'メルカリの商品URLが見つかりません。アドレスバーに表示される「https://jp.mercari.com/item/m…」をコピーするか、共有文の中にURLが含まれるようにしてください。',
      };
    }

    let lastMessage = '';
    for (const endpoint of endpointsFor(raw)) {
      try {
        const res = await doFetch(endpoint);
        const data = await res.json().catch(() => null);
        if (!data) { lastMessage = 'サーバーからの応答を解析できませんでした。'; continue; }
        if (!res.ok) { lastMessage = describeFailure(res, data); continue; }
        if (data.error) { lastMessage = describeFailure({ status: 404 }, data); continue; }
        return { ok: true, data: normalize(data) };
      } catch (e) {
        const net = e instanceof TypeError || String(e && e.message || '').includes('fetch');
        lastMessage = net
          ? '通信に失敗しました。電波を確認するか、Wi-Fiに切り替えて再度お試しください。'
          : '商品情報を取得できませんでした。URLを確認してください。';
      }
    }
    return { ok: false, code: 'FETCH_FAILED', message: lastMessage || '商品情報を取得できませんでした。URLを確認してください。' };
  }

  /** 部分的なデータ（Chrome 拡張の clone_data など）の欠損を /api/mercari で補完する */
  async function enrich(data) {
    const norm = normalize(data);
    const url = norm.url || (norm.itemId ? `https://jp.mercari.com/item/${norm.itemId}` : '');
    if (!url || !/\/item\/m\w+/i.test(url)) return norm;

    const nonEmpty = (v) => v != null && String(v).trim() !== '';
    const lacksPrice = norm.currentPrice == null || norm.currentPrice === 0;
    const hasShippingMeta = nonEmpty(norm.shippingPayer) || nonEmpty(norm.shippingMethod) ||
      nonEmpty(norm.shippingFrom) || nonEmpty(norm.shippingDays);
    const lacksMeta = !nonEmpty(norm.category) || !nonEmpty(norm.condition) || !hasShippingMeta;
    if (!lacksPrice && !lacksMeta) return norm;

    let api = null;
    for (const ep of endpointsFor(url)) {
      try {
        const res = await doFetch(ep);
        const j = await res.json();
        if (res.ok && j && !j.error) { api = j; break; }
      } catch (e) { /* next */ }
    }
    if (!api) return norm;
    return mergePartial(norm, api);
  }

  return {
    CLONE_FIELDS,
    isMercariUrlLike, extractUrl, describeFailure,
    inferItemId, normalize, mergePartial, completeness, decodeLegacyCloneData,
    endpointsFor, fetchItem, enrich,
  };
}

/**
 * 内部 API ディスパッチャ。
 *
 * UI はサービスを直接呼び、MCP サーバー / ローカルエージェントはこちらの
 * 名前付きオペレーションを呼ぶ。どちらも同じ実装に着地する。
 * MCP ツール名との対応: mercari_get_item / mercari_create_clone_data。
 *
 * 引数・戻り値はいずれも JSON 化できる素の値のみ。
 */
export function createInternalApi(service) {
  const ops = {
    /** 商品 URL から商品データを取得する */
    async 'mercari.getItem'(params) {
      const r = await service.fetchItem((params || {}).url);
      if (!r.ok) return r;
      return { ok: true, data: r.data, completeness: service.completeness(r.data) };
    },

    /** 商品 URL からクローン用データを組み立てる（欠損は補完する） */
    async 'mercari.createCloneData'(params) {
      const r = await service.fetchItem((params || {}).url);
      if (!r.ok) return r;
      const data = await service.enrich(r.data);
      return { ok: true, data, completeness: service.completeness(data) };
    },

    /** 部分データ（Chrome 拡張の clone_data 等）を補完する */
    async 'mercari.enrichCloneData'(params) {
      const partial = (params || {}).data;
      if (!partial || typeof partial !== 'object') {
        return { ok: false, code: 'BAD_PARAMS', message: 'data オブジェクトが必要です' };
      }
      const data = await service.enrich(partial);
      return { ok: true, data, completeness: service.completeness(data) };
    },

    /** 共有文などのテキストからメルカリ商品 URL を抽出する */
    'mercari.extractUrl'(params) {
      const url = service.extractUrl((params || {}).text || '');
      return url
        ? { ok: true, data: { url } }
        : { ok: false, code: 'BAD_URL', message: 'メルカリの商品URLが見つかりません。' };
    },
  };

  const api = { ...ops };

  api.list = function () {
    return Object.keys(ops);
  };

  /** 名前でオペレーションを呼ぶ。例外は必ず {ok:false} に畳んで返す（MCP 側で扱いやすくするため）。 */
  api.call = async function (name, params) {
    if (typeof ops[name] !== 'function') {
      return { ok: false, code: 'UNKNOWN_OPERATION', message: `未知の操作: ${name}` };
    }
    try {
      return await ops[name](params || {});
    } catch (e) {
      return { ok: false, code: 'INTERNAL_ERROR', message: String((e && e.message) || e) };
    }
  };

  return api;
}
