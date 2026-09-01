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
import fs from 'node:fs';

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

  // ── 商品編集ページ（/sell/edit/<itemId>）── 2026-09-01 実機確認
  /** 価格入力。INPUT[name=price] / inputmode=decimal */
  editPriceInput: '[data-testid="price-text-input"]',
  /** 保存ボタン「変更する」 */
  editSubmitButton: '[data-testid="edit-button"]',
  editSalesFee: '[data-testid="sales-fee"]',
  editSalesProfit: '[data-testid="sales-profit"]',
  /** 触れてはいけないボタン。誤操作防止のため名前だけ記録する（コードからは押さない） */
  dangerousButtons: ['[data-testid="delete-button"]', '[data-testid="suspend-button"]'],

  // ── 出品フォーム（/sell/create）── 2026-09-01 実機調査。まだ未実装。
  // 「下書きに保存する」が存在するため、出品せず下書きで止める設計が成立する。
  //
  // 実機で確認した重要な性質:
  //  - ピッカー（カテゴリー・商品の状態・配送の方法）は**モーダルではなく別ページ**。
  //    コンテナの DIV は押せないが、その内側に本物の <a href> がある。
  //  - ピッカーへ遷移してもフォームの入力は消えない（戻ると保持されている）。
  //  - 自動保存は起きない。save-draft を押さない限り下書きは 1 件も作られない。
  sell: {
    /** 画像アップロード。input[type=file] accept=image/* multiple。setInputFiles が使える */
    photoUpload: '[data-testid="photo-upload"]',
    title: 'input[name="name"]',
    description: 'textarea[name="description"]',
    price: '[data-testid="price-text-input"]',
    /** ここは素の <select>。値をそのまま選べる */
    shippingPayer: 'select[name="shippingPayer"]',
    shippingFromArea: 'select[name="shippingFromArea"]',
    shippingDuration: 'select[name="shippingDuration"]',
    /** 下書き保存。フェーズ3のゴールはこのボタン */
    saveDraft: '[data-testid="save-draft"]',
    /** 出品実行。フェーズ4まで押さない */
    submitListing: '[data-testid="list-item-button"]',

    /**
     * AI 出品サポートのトグル。既定は ON。
     * 写真から商品名・説明文・価格を**自動で書き込む**ため、こちらの入力と衝突しうる。
     * 画像アップロード後に値が上書きされていないか必ず読み直して確認すること。
     */
    aiListingToggle: '[data-testid="ai-listing-toggle"]',

    // ── ピッカー3種。コンテナは押せない。内側の <a> を押して別ページへ遷移する ──
    categoryPicker: '[data-testid="category-link"]',      // 内側 <a> → /sell/categories
    conditionPicker: '[data-testid="item-condition"]',    // 内側 <a> → /sell/conditions
    shippingMethodPicker: '[data-testid="shipping-method-link"]', // 内側 <a> → /sell/shipping_methods
    pickerLink: 'a',                                      // 上記コンテナに対する子セレクタ

    /**
     * カテゴリー選択ページ（/sell/categories）。
     *  - 中間の階層は <a href="/sell/categories?category_id=N">。href で降りられる
     *  - **末端は merActionRow の中の <button>**。同じ文言の <a href="/sell/create"> も
     *    並んでいるが、そちらを押しても選択は反映されない。必ず button を押すこと
     *  - 1 つの階層に中間リンクと末端ボタンが混在することがある
     *  - 選択後は /sell/create に戻り、ピッカーにフルパスが入る
     *    （例: 「ファッション レディース トップス シャツ・ブラウス 半袖」）
     */
    categoryLeafButton: 'main .merActionRow button',
    categorySelected: '[data-testid="sell-category"]',

    /**
     * カテゴリーによっては末端を選んだあと /sell/wizard へ飛ぶ。
     * 「購入者にあなたの商品を見つけやすくしませんか？」という**任意**の製品情報入力の導線で、
     * 「出品画面に戻る」で素通りできる。カテゴリー自体はこの時点で確定している。
     * 実測: ゲーム・おもちゃ・グッズ > キャラクターグッズ > その他 で発生。
     */
    wizardPath: '/sell/wizard',
    wizardBackToListing: '[data-testid="back-to-listing-button"]',
    /** 製品情報の入力へ進むボタン。任意なので押さない */
    wizardNext: '[data-testid="move-to-next-screen-button"]',

    /**
     * 商品の状態（/sell/conditions）。testid 付きの <a> で 6 択。
     * 番号が大きいほど状態が悪い。**生成時の既定は保守的な側（大きい番号）にする。**
     */
    conditionLabels: {
      1: '新品、未使用', 2: '未使用に近い', 3: '目立った傷や汚れなし',
      4: 'やや傷や汚れあり', 5: '傷や汚れあり', 6: '全体的に状態が悪い',
    },

    /**
     * 配送の方法（/sell/shipping_methods）。
     * **既定で「ゆうゆうメルカリ便」が入っている**ため、複製ケースでは触らずに済む。
     * 変更が要る場合の入口は下記。選択肢は素の select ではなくボタン群。
     */
    shippingServiceGroup: '[data-testid="shipping-service-group"]',
    shippingServiceTrigger: '[data-testid="shipping-service-trigger-button"]',

    /**
     * カテゴリー確定後に**後から生える**要素。確定前には存在しない。
     *  - ブランド欄
     *  - カテゴリー固有の属性セレクト（name="dynamicAttributes.<uuid>.[0]"）。
     *    実測ではレディース>トップス>シャツ・ブラウス>半袖 で 6 本生えた。
     *    下書き保存に必須かどうかは未確認。
     */
    brandLink: '[data-testid="brand-link"]',
    attributeSelect: '[data-testid="attribute-select"]',
    dynamicAttributeSelects: 'select[name^="dynamicAttributes."]',
  },

  // ── 下書き ── 2026-09-01 実データで保存まで確認（人間の承認のもと 1 件だけ作成）
  //
  // 確認できたこと:
  //  - **画像なしでも下書きは保存できる**（一覧では NOIMAGE と表示される）
  //  - **dynamicAttributes は 6 本すべて空でも保存できる。下書きには必須ではない**
  //  - タイトル・説明・価格・カテゴリー（フルパス）・商品の状態・配送の方法はすべて保持される
  //  - save-draft を押すと /mypage/drafts へ遷移する
  draft: {
    /** 下書き一覧。/sell/drafts は /mypage/drafts へ転送される */
    listPath: '/mypage/drafts',
    list: '[data-testid="draft-list"]',
    listItem: '[data-testid="draft-item"]',
    /** 各行のリンクは /sell/draft/<draftId>。ID の取り出しは parseDraftId() */
    itemLink: 'a[href^="/sell/draft/"]',
    /** 下書き編集ページ（/sell/draft/<draftId>）のボタン */
    overwrite: '[data-testid="overwrite-draft"]',
    /** 触れてはいけないボタン。下書きから出品してしまう。フェーズ4まで押さない */
    dangerousButtons: ['[data-testid="list-draft-button"]', '[data-testid="delete-draft"]'],
  },
};

/**
 * SELECTORS は `browser.evaluate(fn, SELECTORS)` でページへ丸ごと渡す。
 * **そのため SELECTORS の値は必ず直列化可能なもの（文字列・数値・素のオブジェクト）に限る。**
 * 組み立てが要るセレクタは関数にせず、ここに置く。
 */

/**
 * クローン元の category（"A > B > C"）を名前の配列にする。
 * 全角の ＞ と半角の > の両方を区切りとして扱う。
 */
export function parseCategoryPath(s) {
  return String(s || '').split(/[>＞]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * クローン元の condition（"新品、未使用" 等）を 1〜6 の番号にする。
 * 一致しなければ null を返す。**推測で埋めないこと。**
 */
export function conditionFromLabel(label) {
  const want = String(label || '').replace(/\s+/g, '').trim();
  if (!want) return null;
  for (const [n, l] of Object.entries(SELECTORS.sell.conditionLabels)) {
    if (l.replace(/\s+/g, '') === want) return Number(n);
  }
  return null;
}

/** カテゴリー中間階層のリンク（/sell/categories?category_id=N） */
export function categoryBranchLink(categoryId) {
  return `main a[href="/sell/categories?category_id=${categoryId}"]`;
}

/** 商品の状態の行。n は 1〜6。大きいほど状態が悪い */
export function conditionRow(n) {
  return `[data-testid="condition-${n}-row"]`;
}

/** 出品フォームの URL */
export const SELL_URLS = {
  create: `${ORIGIN}/sell/create`,
  /** /sell/drafts は /mypage/drafts へ転送される */
  drafts: `${ORIGIN}/mypage/drafts`,
};

/** 下書き一覧の行の href から下書き ID を取り出す。取れなければ null */
export function parseDraftId(href) {
  const m = String(href || '').match(/\/sell\/draft\/(\d+)/);
  return m ? m[1] : null;
}

/** 下書き編集ページ（保存済みの下書きを開き直す） */
export function draftPageUrl(draftId) {
  return `${ORIGIN}/sell/draft/${draftId}`;
}

/** メルカリの価格範囲 */
export const PRICE_LIMITS = { min: 300, max: 9999999 };

/** 販売手数料 10%。見積り用。実際の値はページから読む。 */
export const FEE_RATE = 0.1;

export function editPageUrl(itemId) {
  return `${ORIGIN}/sell/edit/${itemId}`;
}

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
  const idIn = (root) => {
    const els = [root, ...root.querySelectorAll('*')];
    for (const el of els)
      for (const a of el.attributes || []) {
        const m = String(a.value).match(/\b(m\d{9,})\b/);
        if (m) return m[1];
      }
    return null;
  };
  const build = (rows) => {
    const out = new Map();
    for (const row of rows) {
      if (!/[¥￥]/.test(row.textContent || '')) continue;
      const id = idIn(row);
      if (!id || out.has(id)) continue;
      const parts = leafTexts(row);
      const updatedLabel = parts.find((t) => /前に更新$/.test(t)) || null;
      const title = parts.find((t) =>
        t.length > 3 && !/^[¥￥]/.test(t) && !/前に更新$/.test(t) && !/^[\d,]+$/.test(t)) || '';
      out.set(id, {
        itemId: id, title, currentPrice: pickPrice(parts), updatedLabel,
        url: `https://jp.mercari.com/item/${id}`,
      });
    }
    return [...out.values()];
  };

  // 一覧の各行は <li>。リスト外に出る「おすすめ」等を拾わないよう li に限定する。
  const fromLi = build(document.querySelectorAll('li'));
  if (fromLi.length) return fromLi;

  // li 構造が変わった場合のフォールバック（精度は落ちるが取りこぼさない）
  const seen = new Set(), rows = [];
  for (const el of document.querySelectorAll('*')) {
    let has = false;
    for (const a of el.attributes || []) if (/\bm\d{9,}\b/.test(String(a.value))) { has = true; break; }
    if (!has) continue;
    let r = el, hops = 0;
    while (r && hops < 8 && !/[¥￥]/.test(r.textContent || '')) { r = r.parentElement; hops++; }
    if (r && !seen.has(r)) { seen.add(r); rows.push(r); }
  }
  return build(rows);
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

  /**
   * ログイン済みかどうかを判定する。副作用なし（ページを開くだけ）。
   * domcontentloaded 直後は描画が終わっていないため、判定材料が出るまで待つ。
   */
  async checkLogin({ timeoutMs = 20000 } = {}) {
    await this.browser.openPage(ORIGIN + LISTING_TABS.active.path);
    const deadline = Date.now() + timeoutMs;
    let state = { hasSideMenu: false, redirectedToLogin: false, url: '' };
    while (Date.now() < deadline) {
      state = await this.browser.evaluate((sel) => ({
        hasSideMenu: !!document.querySelector(sel.loggedInMarker),
        redirectedToLogin: /\/login|\/signin/.test(location.pathname),
        hasLoginCta: !!document.querySelector(sel.loginMarker),
        url: location.href,
      }), { loggedInMarker: SELECTORS.loggedInMarker, loginMarker: SELECTORS.loginMarker });
      if (state.hasSideMenu || state.redirectedToLogin) break;
      await this.browser.waitForTimeout(500);
    }
    const loggedIn = state.hasSideMenu && !state.redirectedToLogin;
    return { loggedIn, url: state.url };
  }

  /**
   * 価格を変更する。
   *
   * **dryRun の既定は true。省略時は絶対に実行しない。**
   * 実行は dryRun:false を明示したときだけ。1 呼び出しにつき 1 商品のみ。
   * 削除・一時停止のボタンにはコードから一切触れない。
   *
   * @param {object} p
   * @param {string} p.itemId  m から始まる商品 ID
   * @param {number} p.newPrice 新しい価格（整数）
   * @param {boolean} [p.dryRun=true] false のときだけ実際に変更する
   * @param {number|null} [p.minPrice] 下回ってはいけない価格。下回る指定は拒否する
   */
  async updatePrice({ itemId, newPrice, dryRun = true, minPrice = null }) {
    if (!/^m\d{9,}$/.test(String(itemId || ''))) {
      return { ok: false, code: 'BAD_ITEM_ID', message: `商品IDの形式が不正です: ${itemId}` };
    }
    const price = Number(newPrice);
    if (!Number.isInteger(price)) {
      return { ok: false, code: 'BAD_PRICE', message: '価格は整数で指定してください' };
    }
    if (price < PRICE_LIMITS.min || price > PRICE_LIMITS.max) {
      return { ok: false, code: 'PRICE_OUT_OF_RANGE',
        message: `価格は ${PRICE_LIMITS.min}〜${PRICE_LIMITS.max} の範囲で指定してください（指定: ${price}）` };
    }
    if (minPrice != null && price < Number(minPrice)) {
      return { ok: false, code: 'BELOW_MIN_PRICE',
        message: `最低価格 ¥${minPrice} を下回る変更は実行しません（指定: ¥${price}）` };
    }

    await this.browser.openPage(editPageUrl(itemId));
    try {
      await this.browser.waitForSelector(SELECTORS.editPriceInput, { timeout: 20000 });
    } catch {
      return { ok: false, code: 'EDIT_PAGE_UNAVAILABLE',
        message: '編集ページを開けませんでした（売却済み・削除済み・ログイン切れの可能性）' };
    }

    const readState = (sel) => {
      const q = (x) => document.querySelector(x);
      const yen = (t) => { const m = String(t || '').match(/([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : null; };
      return {
        price: Number(String(q(sel.editPriceInput)?.value || '').replace(/[^\d]/g, '')) || null,
        fee: yen(q(sel.editSalesFee)?.textContent),
        profit: yen(q(sel.editSalesProfit)?.textContent),
      };
    };
    const before = await this.browser.evaluate(readState, SELECTORS);
    if (before.price == null) {
      return { ok: false, code: 'PRICE_UNREADABLE', message: '現在価格を読み取れませんでした' };
    }

    // 手数料以外の控除（送料など）は現在の表示から逆算する
    const otherDeduction = (before.fee != null && before.profit != null)
      ? before.price - before.fee - before.profit : 0;
    const newFee = Math.floor(price * FEE_RATE);
    const plan = {
      itemId,
      currentPrice: before.price,
      newPrice: price,
      diff: price - before.price,
      direction: price === before.price ? 'なし' : price < before.price ? '値下げ' : '値上げ',
      currentFee: before.fee,
      currentProfit: before.profit,
      estimatedNewFee: newFee,
      estimatedNewProfit: price - newFee - otherDeduction,
      minPrice: minPrice != null ? Number(minPrice) : null,
      editUrl: editPageUrl(itemId),
    };

    if (price === before.price) {
      return { ok: true, applied: false, dryRun, plan, note: '現在価格と同じため何もしませんでした' };
    }
    if (dryRun) {
      return { ok: true, applied: false, dryRun: true, plan,
        note: '確認のみです。実際に変更するには dry_run を false にしてください。' };
    }

    // ── ここから実際の変更。dryRun:false のときだけ到達する ──
    await this.browser.fill(SELECTORS.editPriceInput, String(price));
    const typed = await this.browser.evaluate(
      (sel) => Number(String(document.querySelector(sel)?.value || '').replace(/[^\d]/g, '')) || null,
      SELECTORS.editPriceInput);
    if (typed !== price) {
      return { ok: false, code: 'FILL_FAILED', plan,
        message: `価格欄に入力できませんでした（入力後の値: ${typed}）。何も変更していません。` };
    }

    await this.browser.click(SELECTORS.editSubmitButton);
    await this.browser.waitForTimeout(5000);

    // 変更後の値を編集ページから読み直して検証する
    await this.browser.openPage(editPageUrl(itemId));
    await this.browser.waitForSelector(SELECTORS.editPriceInput, { timeout: 20000 });
    const after = await this.browser.evaluate(
      (sel) => Number(String(document.querySelector(sel)?.value || '').replace(/[^\d]/g, '')) || null,
      SELECTORS.editPriceInput);

    if (after !== price) {
      return { ok: false, code: 'VERIFY_FAILED', plan, priceAfter: after,
        message: `変更後の価格が一致しません（期待 ¥${price} / 実際 ¥${after}）。メルカリ側で反映されていない可能性があります。` };
    }
    return { ok: true, applied: true, dryRun: false, plan, priceBefore: before.price, priceAfter: after };
  }

  /**
   * 末端カテゴリーを選んだあと /sell/wizard に飛んだ場合、出品画面へ戻る。
   * wizard は製品情報を入力させる**任意**の導線で、素通りしてよい
   * （カテゴリー自体はこの時点で確定している）。飛んでいなければ何もしない。
   */
  async skipSellWizard() {
    const S = SELECTORS.sell;
    if (!(await this.browser.getCurrentUrl()).includes(S.wizardPath)) return false;
    await this.browser.click(S.wizardBackToListing);
    await this.browser.waitForTimeout(5000);
    return true;
  }

  /**
   * カテゴリー選択ページ（/sell/categories）のツリーを名前でたどる。
   * **呼び出し前に /sell/categories を開いておくこと**（出品フォームからピッカーを踏んだ直後）。
   *
   * **推測はしない。** 名前が一致しなければ、その階層の候補を返して呼び出し側に決めさせる。
   * 末端に届かない場合も同じ（末端を勝手に選ばない）。
   * クローン元の商品ページの経路は大分類から始まる（実測: "ゲーム・おもちゃ・グッズ > … "）ので
   * そのまま渡してよいが、階層数が足りなければ CATEGORY_PATH_TOO_SHORT と候補が返る。
   *
   * @param {string[]} names 大分類から末端までの名前
   */
  async walkCategoryTree(names) {
    const S = SELECTORS.sell;
    const norm = (t) => String(t || '').replace(/\s+/g, '').trim();
    const readLevel = () => this.browser.evaluate((sel) => {
      const n = (t) => (t || '').replace(/\s+/g, '').trim();
      return {
        url: location.href,
        branches: [...document.querySelectorAll('main a')]
          .map((a) => ({ href: a.getAttribute('href') || '', text: n(a.textContent) }))
          .filter((a) => /category_id=/.test(a.href)),
        leaves: [...document.querySelectorAll(sel.categoryLeafButton)]
          .map((b, index) => ({ index, text: n(b.textContent) })),
      };
    }, S);

    const taken = [];
    for (let i = 0; i < names.length; i++) {
      const want = norm(names[i]);
      const level = await readLevel();
      const branch = level.branches.find((b) => b.text === want);
      const leaf = level.leaves.find((b) => b.text === want);
      const candidates = level.branches.concat(level.leaves).map((x) => x.text);

      if (!branch && !leaf) {
        return { ok: false, code: 'CATEGORY_NOT_FOUND',
          message: `階層 ${taken.length + 1} に「${names[i]}」が見つかりません`,
          resolvedSoFar: taken, candidates };
      }
      if (leaf) {
        await this.browser.clickNth(S.categoryLeafButton, leaf.index);
        await this.browser.waitForTimeout(4000);
        await this.skipSellWizard();
        taken.push(names[i]);
        if (i !== names.length - 1) {
          return { ok: false, code: 'CATEGORY_PATH_TOO_LONG',
            message: `「${names[i]}」が末端でした。経路の残り（${names.slice(i + 1).join(' > ')}）は指定できません`,
            resolvedSoFar: taken };
        }
        return { ok: true, path: taken };
      }
      const id = new URL(branch.href, ORIGIN).searchParams.get('category_id');
      await this.browser.click(categoryBranchLink(id));
      await this.browser.waitForTimeout(2500);
      taken.push(names[i]);
    }

    // 名前を使い切ったのに末端へ届いていない
    const level = await readLevel();
    return { ok: false, code: 'CATEGORY_PATH_TOO_SHORT',
      message: `「${names[names.length - 1]}」はまだ末端ではありません。さらに下の階層まで指定してください`,
      resolvedSoFar: taken,
      candidates: level.branches.concat(level.leaves).map((x) => x.text) };
  }

  /**
   * カテゴリーの経路が出品フォームのツリーに実在するかを調べる（読み取りのみ）。
   * 末端まで届けば ok:true、届かなければその地点の候補を返す。
   * クローン元の `category`（"A > B > C" 形式）をそのまま渡してよい。
   */
  async resolveCategory(categoryPathOrString) {
    const names = Array.isArray(categoryPathOrString)
      ? categoryPathOrString.map((x) => String(x).trim()).filter(Boolean)
      : parseCategoryPath(categoryPathOrString);
    if (!names.length) {
      return { ok: false, code: 'BAD_CATEGORY_PATH', message: 'カテゴリーが空です' };
    }
    await this.browser.openPage(SELL_URLS.create);
    try {
      await this.browser.waitForSelector(SELECTORS.sell.categoryPicker, { timeout: 30000 });
    } catch {
      return { ok: false, code: 'SELL_FORM_UNAVAILABLE', message: '出品フォームを開けませんでした（ログイン切れの可能性）' };
    }
    await this.browser.waitForTimeout(2000);
    await this.browser.click(`${SELECTORS.sell.categoryPicker} ${SELECTORS.sell.pickerLink}`);
    await this.browser.waitForTimeout(2500);
    const r = await this.walkCategoryTree(names);
    if (!r.ok) return { ...r, input: names };
    // 選択直後は描画が終わっていないことがある。反映されるまで待って読み直す
    const leafName = r.path[r.path.length - 1];
    let applied = '';
    for (let i = 0; i < 20; i++) {
      applied = await this.browser.evaluate(
        (sel) => (document.querySelector(sel.categoryPicker)?.textContent || '').replace(/\s+/g, ' ').trim(),
        SELECTORS.sell);
      if (applied.includes(leafName)) break;
      await this.browser.waitForTimeout(500);
    }
    if (!applied.includes(leafName)) {
      return { ok: false, code: 'CATEGORY_NOT_APPLIED', input: names, categoryPath: r.path,
        message: `「${r.path.join(' > ')}」を選びましたが、フォームに反映されませんでした（実際の表示:「${applied}」）` };
    }
    return { ok: true, input: names, categoryPath: r.path, categoryApplied: applied };
  }

  /**
   * メルカリの「下書き」を作る。**出品はしない。**
   *
   * **dryRun の既定は true。省略時は絶対に保存しない。**
   * dryRun でもフォームへの入力とカテゴリー選択は実際に行う（メルカリ側には何も残らない。
   * 自動保存が無いことは実データで確認済み）。つまり dryRun は「保存直前までの通し稽古」であり、
   * カテゴリーの経路が実在するかどうかまで確かめられる。
   *
   * 1 回の呼び出しで作る下書きは 1 件だけ。
   * 「出品する」（list-item-button / list-draft-button）にはコードから一切触れない。
   *
   * @param {object} p
   * @param {string} p.title 商品名
   * @param {string} p.description 商品説明
   * @param {number} p.price 価格（整数）
   * @param {string[]} p.categoryPath カテゴリーの経路。名前の配列
   *   （例: ['ファッション','レディース','トップス','シャツ・ブラウス','半袖']）
   * @param {number} p.condition 商品の状態 1〜6。**大きいほど状態が悪い。呼び出し側が必ず明示する**
   * @param {string[]} [p.imagePaths] 画像のローカルパス。省略可（画像なしでも下書きは保存できる）
   * @param {boolean} [p.dryRun=true] false のときだけ実際に保存する
   */
  async createDraft({ title, description, price, categoryPath, condition, imagePaths = [], dryRun = true }) {
    // ── 入力の検証。ここを抜けるまでブラウザを触らない ──
    const name = String(title ?? '').trim();
    const desc = String(description ?? '').trim();
    if (!name) return { ok: false, code: 'BAD_TITLE', message: '商品名が空です' };
    if (!desc) return { ok: false, code: 'BAD_DESCRIPTION', message: '商品説明が空です' };

    const yen = Number(price);
    if (!Number.isInteger(yen)) return { ok: false, code: 'BAD_PRICE', message: '価格は整数で指定してください' };
    if (yen < PRICE_LIMITS.min || yen > PRICE_LIMITS.max) {
      return { ok: false, code: 'PRICE_OUT_OF_RANGE',
        message: `価格は ${PRICE_LIMITS.min}〜${PRICE_LIMITS.max} の範囲で指定してください（指定: ${yen}）` };
    }

    const path = Array.isArray(categoryPath) ? categoryPath.map((x) => String(x).trim()).filter(Boolean) : [];
    if (path.length < 2) {
      return { ok: false, code: 'BAD_CATEGORY_PATH',
        message: 'カテゴリーは大分類から末端までの経路を配列で指定してください（例: ["ファッション","レディース","トップス","シャツ・ブラウス","半袖"]）' };
    }

    const cond = Number(condition);
    if (!Number.isInteger(cond) || cond < 1 || cond > 6) {
      return { ok: false, code: 'BAD_CONDITION',
        message: '商品の状態は 1〜6 で明示してください（大きいほど状態が悪い）。推測で決めてはいけません' };
    }

    const images = Array.isArray(imagePaths) ? imagePaths.map(String) : [];
    const missing = images.filter((f) => !fs.existsSync(f));
    if (missing.length) {
      return { ok: false, code: 'IMAGE_NOT_FOUND', message: `画像が見つかりません: ${missing.join(', ')}` };
    }

    // ── 出品フォームを開く ──
    const S = SELECTORS.sell;
    await this.browser.openPage(SELL_URLS.create);
    try {
      await this.browser.waitForSelector(S.title, { timeout: 30000 });
    } catch {
      return { ok: false, code: 'SELL_FORM_UNAVAILABLE',
        message: '出品フォームを開けませんでした（ログイン切れの可能性）' };
    }
    await this.browser.waitForTimeout(2500);

    // 画像は先に入れる。AI 出品サポートが ON だと写真から商品名・説明文・価格を
    // 上書きすることがあるため、**このあとに入力し、入力後に必ず読み直す**。
    if (images.length) {
      await this.browser.setInputFiles(S.photoUpload, images);
      await this.browser.waitForTimeout(2000 + 2000 * images.length);
    }

    // 文字数の上限はページから読む（こちらで決め打ちにしない）
    const limits = await this.browser.evaluate((sel) => ({
      title: document.querySelector(sel.title)?.maxLength ?? -1,
      description: document.querySelector(sel.description)?.maxLength ?? -1,
    }), S);
    if (limits.title > 0 && name.length > limits.title) {
      return { ok: false, code: 'TITLE_TOO_LONG',
        message: `商品名が長すぎます（${name.length} 文字 / 上限 ${limits.title} 文字）` };
    }
    if (limits.description > 0 && desc.length > limits.description) {
      return { ok: false, code: 'DESCRIPTION_TOO_LONG',
        message: `商品説明が長すぎます（${desc.length} 文字 / 上限 ${limits.description} 文字）` };
    }

    await this.browser.fill(S.title, name);
    await this.browser.fill(S.description, desc);
    await this.browser.fill(S.price, String(yen));

    // ── カテゴリー。中間はリンク、末端はボタン ──
    await this.browser.click(`${S.categoryPicker} ${S.pickerLink}`);
    await this.browser.waitForTimeout(2500);
    const walked = await this.walkCategoryTree(path);
    if (!walked.ok) return walked;

    const backOnForm = /\/sell\/create/.test(await this.browser.getCurrentUrl());
    if (!backOnForm) {
      return { ok: false, code: 'CATEGORY_NOT_APPLIED',
        message: 'カテゴリー選択後に出品フォームへ戻りませんでした。何も保存していません。' };
    }

    // ── 商品の状態 ──
    await this.browser.click(`${S.conditionPicker} ${S.pickerLink}`);
    await this.browser.waitForTimeout(2500);
    await this.browser.click(conditionRow(cond));
    await this.browser.waitForTimeout(4000);

    // ── 入力結果を読み直す。AI サポートによる上書きもここで検出する ──
    const state = await this.browser.evaluate((sel) => {
      const t = (q) => (document.querySelector(q)?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        title: document.querySelector(sel.title)?.value ?? null,
        description: document.querySelector(sel.description)?.value ?? null,
        price: Number(String(document.querySelector(sel.price)?.value || '').replace(/[^\d]/g, '')) || null,
        categoryText: t(sel.categoryPicker),
        conditionText: t(sel.conditionPicker),
        shippingText: t(sel.shippingMethodPicker),
        photoCount: document.querySelectorAll(`${sel.photoUpload} , [data-testid="photo-upload"]`).length,
        dynamicAttributes: [...document.querySelectorAll(sel.dynamicAttributeSelects)]
          .map((e) => ({ name: e.getAttribute('name'), value: e.value })),
        aiAssistOn: /AI出品サポートがON/.test(document.body.textContent || ''),
        saveDraftDisabled: document.querySelector(sel.saveDraft)?.disabled ?? null,
      };
    }, S);

    const mismatches = [];
    if (state.title !== name) mismatches.push(`商品名（期待「${name}」/ 実際「${state.title}」）`);
    if (state.description !== desc) mismatches.push('商品説明');
    if (state.price !== yen) mismatches.push(`価格（期待 ${yen} / 実際 ${state.price}）`);
    if (!state.categoryText.includes(path[path.length - 1])) mismatches.push(`カテゴリー（実際「${state.categoryText}」）`);
    if (!state.conditionText.includes(SELECTORS.sell.conditionLabels[cond])) mismatches.push(`商品の状態（実際「${state.conditionText}」）`);
    if (mismatches.length) {
      return { ok: false, code: 'FILL_FAILED',
        message: `入力内容が一致しません: ${mismatches.join(' / ')}。保存せずに中断しました。`,
        state };
    }

    const plan = {
      title: name,
      description: desc.length > 80 ? desc.slice(0, 80) + '…' : desc,
      descriptionLength: desc.length,
      price: yen,
      categoryPath: path,
      categoryApplied: state.categoryText,
      condition: cond,
      conditionLabel: SELECTORS.sell.conditionLabels[cond],
      conditionApplied: state.conditionText,
      shipping: state.shippingText,
      imageCount: images.length,
      dynamicAttributes: state.dynamicAttributes,
      aiAssistOn: state.aiAssistOn,
      note: '配送の方法・発送元・発送日数はメルカリ側の既定値のままです。変更が要る場合は保存後に人間が直してください。',
    };

    if (dryRun) {
      return { ok: true, saved: false, dryRun: true, plan,
        note: '確認のみです。メルカリ側には何も保存していません（自動保存は起きません）。実際に下書きを作るには dry_run を false にしてください。' };
    }

    // ── ここから実際の保存。dryRun:false のときだけ到達する ──
    await this.browser.click(S.saveDraft);
    await this.browser.waitForTimeout(7000);

    // 下書き一覧から自分の下書きを見つける（新しい順ではなく商品名で特定する）
    await this.browser.openPage(SELL_URLS.drafts);
    await this.browser.waitForTimeout(5000);
    const found = await this.browser.evaluate((arg) => {
      const rows = [...document.querySelectorAll(arg.sel.draft.itemLink)];
      const hit = rows.find((a) => (a.textContent || '').includes(arg.title));
      return hit ? { href: hit.getAttribute('href'), text: (hit.textContent || '').trim().slice(0, 120) } : null;
    }, { sel: SELECTORS, title: name });

    if (!found) {
      return { ok: false, code: 'DRAFT_NOT_FOUND',
        message: '保存後に下書き一覧で見つかりませんでした。保存に失敗した可能性があります。', plan };
    }
    const draftId = parseDraftId(found.href);

    // 保存された中身を開き直して検証する
    await this.browser.openPage(draftPageUrl(draftId));
    await this.browser.waitForSelector(S.title, { timeout: 30000 });
    await this.browser.waitForTimeout(5000);
    const saved = await this.browser.evaluate((sel) => {
      const t = (q) => (document.querySelector(q)?.textContent || '').replace(/\s+/g, ' ').trim();
      return {
        title: document.querySelector(sel.title)?.value ?? null,
        description: document.querySelector(sel.description)?.value ?? null,
        price: Number(String(document.querySelector(sel.price)?.value || '').replace(/[^\d]/g, '')) || null,
        categoryText: t(sel.categoryPicker),
        conditionText: t(sel.conditionPicker),
      };
    }, S);

    const bad = [];
    if (saved.title !== name) bad.push('商品名');
    if (saved.description !== desc) bad.push('商品説明');
    if (saved.price !== yen) bad.push(`価格（期待 ${yen} / 実際 ${saved.price}）`);
    if (!saved.categoryText.includes(path[path.length - 1])) bad.push('カテゴリー');
    if (!saved.conditionText.includes(SELECTORS.sell.conditionLabels[cond])) bad.push('商品の状態');
    if (bad.length) {
      return { ok: false, code: 'VERIFY_FAILED', plan, draftId, draftUrl: draftPageUrl(draftId), saved,
        message: `保存後の内容が一致しません: ${bad.join(' / ')}。下書きは作られているので中身を確認してください。` };
    }

    return { ok: true, saved: true, dryRun: false, plan, draftId,
      draftUrl: draftPageUrl(draftId), savedContent: saved,
      note: '**下書きです。出品はしていません。** 出品するかどうかは人間が判断してください。' };
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

    // 一覧が描画されるまで待つ。
    // 1 件でも取れた時点で打ち切ると描画途中を掴む（実データで 44 件中 1 件しか取れなかった）。
    // ヘッダーの「N件」に達するか、件数が 3 回連続で変わらなくなるまで待つ。
    // ヘッダーの「N件」は参考値にとどめ、件数が安定したことだけで判断する
    // （ページ内に複数の「N件」表記があり、制御に使うと早期に打ち切ってしまう）
    let items = [];
    let stable = 0, prev = -1;
    for (let i = 0; i < 40; i++) {
      items = await this.browser.evaluate(extractListingsInPage);
      stable = items.length === prev && items.length > 0 ? stable + 1 : 0;
      prev = items.length;
      if (stable >= 3) break;
      await this.browser.waitForTimeout(500);
    }

    let clicks = 0, truncated = false;
    while (items.length < maxItems && clicks < maxLoadMore) {
      // ボタンは読み込み中に一時的に消えることがある。数回確認してから終了と判断する。
      let r = await this.browser.evaluate(clickLoadMoreInPage);
      if (!r.clicked) {
        let recovered = false;
        for (let retry = 0; retry < 3; retry++) {
          await this.browser.waitForTimeout(1500);
          r = await this.browser.evaluate(clickLoadMoreInPage);
          if (r.clicked) { recovered = true; break; }
        }
        if (!recovered) break;
      }
      clicks++;
      // 増え始めてからも描画が続くため、増加を確認したあと件数が安定するまで待つ
      let grew = false;
      for (let i = 0; i < 25; i++) {
        await this.browser.waitForTimeout(400);
        items = await this.browser.evaluate(extractListingsInPage);
        if (items.length > r.before) { grew = true; break; }
      }
      if (grew) {
        let p = -1, st = 0;
        for (let i = 0; i < 20; i++) {
          await this.browser.waitForTimeout(300);
          items = await this.browser.evaluate(extractListingsInPage);
          st = items.length === p ? st + 1 : 0;
          p = items.length;
          if (st >= 2) break;
        }
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
