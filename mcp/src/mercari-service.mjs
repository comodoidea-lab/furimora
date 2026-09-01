/**
 * MercariService — メルカリ固有のロジックとセレクタを「ここだけ」に集約する。
 *
 * DOM 依存は避けられないので、壊れたときに直す場所を 1 箇所に閉じ込めることが目的。
 * メルカリの UI が変わったら、原則としてこのファイルだけを直せばよい状態を保つこと。
 *
 * 読み取り専用。価格変更・出品・削除は行わない（フェーズ 2 以降）。
 */

/**
 * 出品一覧のタブとルート。
 * 注意: メルカリ側の命名が直感と食い違っている（2026-09-01 実機確認）。
 *   /mypage/listings/completed = 「売却済み」   ← completed が売却済み
 *   /mypage/listings/sold      = 「販売履歴」
 */
export const LISTING_TABS = {
  active:      { path: '/mypage/listings',             label: '出品中' },
  in_progress: { path: '/mypage/listings/in_progress', label: '取引中' },
  sold:        { path: '/mypage/listings/completed',   label: '売却済み' },
  history:     { path: '/mypage/listings/sold',        label: '販売履歴' },
};

export const ORIGIN = 'https://jp.mercari.com';

/** メルカリ固有のセレクタ・文言。UI 変更時はここを見る。 */
export const SELECTORS = {
  /** ログイン済みなら出るマイページのサイドメニュー */
  loggedInMarker: '[data-testid="mypage-side-menu"]',
  /** 未ログイン時に出るログイン導線 */
  loginMarker: 'a[href*="/login"], [data-testid="login-button"]',
  /** 一覧の追加読み込みボタンの文言 */
  loadMoreText: /もっと見る/,
  /** 商品 ID の形 */
  itemIdPattern: /\b(m\d{9,})\b/,
};

/**
 * ページ内で実行される抽出関数のソース。
 *
 * 実機検証（2026-09-01, 50 件）で確定した仕様:
 *  - 行は <a href="/item/..."> ではない。商品 ID は要素の「属性値」に埋まっている
 *    （遅延読み込みされる画像の src/srcset 等）。属性を走査して拾う。
 *  - innerText は非表示要素で空になるため必ず textContent を使う。
 *  - 行の textContent は連結されるため（"¥1,9802日前に更新"）、
 *    価格・更新日はテキストノード単位で拾う。
 *  - 価格は "¥" と数字が別テキストノードに分かれることがある。
 */
export function extractListingsInPage() {
  const leafTexts = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = []; let n;
    while ((n = w.nextNode())) { const t = (n.nodeValue || '').trim(); if (t) out.push(t); }
    return out;
  };
  const pickPrice = (parts) => {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const m = p.match(/^[¥￥]\s?([\d,]+)$/);
      if (m) return Number(m[1].replace(/,/g, ''));
      if (p === '¥' || p === '￥') {
        const nx = parts[i + 1] || '';
        if (/^[\d,]+$/.test(nx)) return Number(nx.replace(/,/g, ''));
      }
    }
    return null;
  };
  const out = new Map();
  for (const el of document.querySelectorAll('*')) {
    let id = null;
    for (const a of el.attributes || []) {
      const m = String(a.value).match(/\b(m\d{9,})\b/);
      if (m) { id = m[1]; break; }
    }
    if (!id || out.has(id)) continue;
    let row = el, hops = 0;
    while (row && hops < 8 && !/[¥￥]/.test(row.textContent || '')) { row = row.parentElement; hops++; }
    if (!row) continue;
    const parts = leafTexts(row);
    const updatedLabel = parts.find((t) => /前に更新$/.test(t)) || null;
    const title = parts.find((t) =>
      t.length > 3 && !/^[¥￥]/.test(t) && !/前に更新$/.test(t) && !/^[\d,]+$/.test(t)) || '';
    out.set(id, {
      itemId: id,
      title,
      currentPrice: pickPrice(parts),
      updatedLabel,
      url: `https://jp.mercari.com/item/${id}`,
    });
  }
  return [...out.values()];
}

/** 「もっと見る」を 1 回押して件数が増えるまで待つ。増えなければ false。 */
export function clickLoadMoreInPage() {
  const countIds = () => new Set(
    [...document.querySelectorAll('*')].flatMap((e) =>
      [...(e.attributes || [])].map((a) => (String(a.value).match(/\bm\d{9,}\b/) || [])[0]).filter(Boolean))
  ).size;
  const btn = [...document.querySelectorAll('button, a')].find((b) => /もっと見る/.test(b.textContent || ''));
  if (!btn) return { clicked: false, before: countIds() };
  const before = countIds();
  btn.click();
  return { clicked: true, before };
}

export class MercariService {
  /** @param {import('./browser-service.mjs').BrowserService} browser */
  constructor(browser) {
    this.browser = browser;
  }

  /** ログイン済みかどうかを判定する。副作用なし（ページを開くだけ）。 */
  async checkLogin() {
    await this.browser.openPage(ORIGIN + LISTING_TABS.active.path);
    const state = await this.browser.evaluate((sel) => ({
      hasSideMenu: !!document.querySelector(sel.loggedInMarker),
      url: location.href,
      title: document.title,
    }), { loggedInMarker: SELECTORS.loggedInMarker });
    const loggedIn = state.hasSideMenu && !/\/login/.test(state.url);
    return { loggedIn, url: state.url };
  }

  /**
   * 自分の出品一覧を取得する（読み取りのみ）。
   * @param {object} [opts]
   * @param {'active'|'in_progress'|'sold'|'history'} [opts.tab]
   * @param {number} [opts.maxItems] 上限。既定 1000
   * @param {number} [opts.maxLoadMore] 「もっと見る」の最大クリック数。既定 40
   * @param {(p:{loaded:number,clicks:number})=>void} [opts.onProgress]
   */
  async getMyListings(opts = {}) {
    const tabKey = opts.tab || 'active';
    const tab = LISTING_TABS[tabKey];
    if (!tab) throw new Error(`未知のタブ: ${tabKey}（有効: ${Object.keys(LISTING_TABS).join(', ')}）`);
    const maxItems = opts.maxItems ?? 1000;
    const maxLoadMore = opts.maxLoadMore ?? 40;
    const startedAt = Date.now();

    await this.browser.openPage(ORIGIN + tab.path);

    // 一覧が描画されるまで待つ（商品 ID が 1 件でも現れるか、タイムアウト）
    let items = [];
    for (let i = 0; i < 30; i++) {
      items = await this.browser.evaluate(extractListingsInPage);
      if (items.length) break;
      await this.browser.waitForTimeout(1000);
    }

    let clicks = 0, truncated = false;
    while (items.length < maxItems && clicks < maxLoadMore) {
      const r = await this.browser.evaluate(clickLoadMoreInPage);
      if (!r.clicked) break;
      clicks++;
      let grew = false;
      for (let i = 0; i < 25; i++) {
        await this.browser.waitForTimeout(400);
        items = await this.browser.evaluate(extractListingsInPage);
        if (items.length > r.before) { grew = true; break; }
      }
      if (opts.onProgress) opts.onProgress({ loaded: items.length, clicks });
      if (!grew) break;
    }
    // 上限で打ち切ったかどうかを呼び出し側へ正直に伝える
    if (clicks >= maxLoadMore || items.length >= maxItems) {
      const more = await this.browser.evaluate(
        () => !![...document.querySelectorAll('button, a')].find((b) => /もっと見る/.test(b.textContent || '')));
      truncated = more;
    }

    return {
      tab: tabKey,
      tabLabel: tab.label,
      items: items.slice(0, maxItems),
      count: Math.min(items.length, maxItems),
      loadMoreClicks: clicks,
      truncated,
      elapsedMs: Date.now() - startedAt,
    };
  }
}
