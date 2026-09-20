/**
 * フリモーラ（PWA）のクローン作成画面を駆動して、①フリモーラの下書きを作る。
 *
 * **アプリ自身の保存経路（createClone）を通す。** localStorage を直接書くと
 * 統計・アクティビティ・同期シグネチャの更新を迂回してしまう。
 *
 * 画面の ID とグローバル関数はここに集約する（メルカリ側を mercari-service.mjs に
 * 集めているのと同じ方針）。壊れたときに直す場所を 1 箇所に保つ。
 */
import { conditionFromLabel, SELECTORS } from './mercari-service.mjs';

/** クローン作成画面。**変更が要るときはここだけ直す** */
export const CLONE = {
  urlInput: 'clone-url-input',
  title: 'clone-title',
  price: 'clone-price',
  description: 'clone-description',
  /** readonly。人間は触れないが .value は入る */
  category: 'clone-category-input',
  condition: 'clone-condition-input',
  error: 'clone-error',
  errorMsg: 'clone-error-msg',
  step1: 'clone-step-1',
  step2: 'clone-step-2',
  step3: 'clone-step-3',
};

export const CONDITION_LABELS = Object.values(SELECTORS.sell.conditionLabels);

/** 商品の状態のラベルが 6 択のどれかであることを確かめる。推測はしない */
export function assertConditionLabel(label) {
  if (conditionFromLabel(label) == null) {
    throw new Error(`商品の状態が不正です: ${JSON.stringify(label)}。次のいずれか: ${CONDITION_LABELS.join(' / ')}`);
  }
  return label;
}

const js = (v) => JSON.stringify(v);

export class FurimoraService {
  /** @param {(op:string, args?:object, opts?:object)=>Promise<any>} call フリモーラ Desktop を叩く関数 */
  constructor(call) { this.call = call; }

  evaluate(script, opts) { return this.call('evaluate', { script }, opts); }

  /** クローン作成画面を開き直して URL を入れる。resetClone が URL 欄を消すので順序を守る */
  async openCloneScreen(url) {
    return this.evaluate(`(() => {
      try {
        if (typeof navigate === 'function') navigate('clone');
        if (typeof resetClone === 'function') resetClone();
      } catch (e) { return { ok: false, code: 'NAV_FAILED', message: String((e && e.message) || e) }; }
      const el = document.getElementById(${js(CLONE.urlInput)});
      if (!el) return { ok: false, code: 'NO_FORM', message: 'クローン作成画面が見つかりません' };
      el.value = ${js(url)};
      return { ok: true };
    })()`);
  }

  /** 「データ取得」を実行して Step2 まで進める。ネットワークを伴うので時間がかかる */
  async fetchSource() {
    return this.evaluate(`(async () => {
      try { await fetchCloneData(); }
      catch (e) { return { ok: false, code: 'FETCH_THREW', message: String((e && e.message) || e) }; }
      const err = document.getElementById(${js(CLONE.error)});
      if (err && !err.classList.contains('hidden')) {
        const m = document.getElementById(${js(CLONE.errorMsg)});
        return { ok: false, code: 'FETCH_FAILED', message: (m && m.textContent) || '取得に失敗しました' };
      }
      const step2 = document.getElementById(${js(CLONE.step2)});
      if (!step2 || step2.classList.contains('hidden')) {
        return { ok: false, code: 'STEP2_NOT_SHOWN', message: 'Step2 が表示されませんでした' };
      }
      const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      return { ok: true, fetched: {
        title: v(${js(CLONE.title)}),
        price: v(${js(CLONE.price)}),
        description: v(${js(CLONE.description)}),
        category: v(${js(CLONE.category)}),
        condition: v(${js(CLONE.condition)}),
        shippingMethod: (typeof clonedData === 'object' && clonedData) ? (clonedData.shippingMethod || null) : null,
        shippingDays: (typeof clonedData === 'object' && clonedData) ? (clonedData.shippingDays || null) : null,
        itemId: (typeof clonedData === 'object' && clonedData) ? (clonedData.itemId || null) : null,
        sourcePrice: (typeof clonedData === 'object' && clonedData) ? (clonedData.currentPrice ?? null) : null,
        imageCount: (typeof clonedData === 'object' && clonedData && Array.isArray(clonedData.images)) ? clonedData.images.length : 0,
      } };
    })()`, { timeoutMs: 60000 });
  }

  /**
   * 人間が確定させた値を入れる。
   * **配送の方法はフォームに欄が無く clonedData から保存される**ので、そちらを書き換える。
   */
  async applyDecisions({ price, condition, shippingMethod }) {
    return this.evaluate(`(() => {
      const set = (id, val) => { const el = document.getElementById(id); if (!el) return false; el.value = val; return true; };
      const applied = {};
      ${price == null ? '' : `applied.price = set(${js(CLONE.price)}, ${js(String(price))});
      try { if (typeof updateFeeCalc === 'function') updateFeeCalc(); } catch (e) {}`}
      ${condition == null ? '' : `applied.condition = set(${js(CLONE.condition)}, ${js(condition)});`}
      ${shippingMethod == null ? '' : `try {
        if (typeof clonedData !== 'object' || !clonedData) return { ok: false, code: 'NO_CLONE_DATA', message: 'clonedData がありません' };
        clonedData.shippingMethod = ${js(shippingMethod)};
        applied.shippingMethod = true;
      } catch (e) { return { ok: false, code: 'SHIPPING_FAILED', message: String((e && e.message) || e) }; }`}
      const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      return { ok: true, applied, current: {
        title: v(${js(CLONE.title)}), price: v(${js(CLONE.price)}),
        category: v(${js(CLONE.category)}), condition: v(${js(CLONE.condition)}),
        descriptionLength: (v(${js(CLONE.description)}) || '').length,
        shippingMethod: (typeof clonedData === 'object' && clonedData) ? (clonedData.shippingMethod || null) : null,
      } };
    })()`);
  }

  /**
   * 保存する。**dry_run:false のときだけ呼ぶこと。**
   * 件数の前後と保存された先頭 1 件を返し、呼び出し側で検証できるようにする。
   */
  async save() {
    return this.evaluate(`(() => {
      const read = () => { try { return JSON.parse(localStorage.getItem('furimora_drafts') || '[]'); } catch (e) { return []; } };
      const before = read().length;
      try { createClone(); }
      catch (e) { return { ok: false, code: 'SAVE_THREW', message: String((e && e.message) || e) }; }
      const after = read();
      const step3 = document.getElementById(${js(CLONE.step3)});
      return {
        ok: true, before, after: after.length,
        step3Shown: !!(step3 && !step3.classList.contains('hidden')),
        saved: after[0] || null,
      };
    })()`);
  }

  /** localStorage の値を読む（読み取りのみ）。キーが無ければ null */
  async readStorage(keys) {
    const { values } = await this.call('read_storage', { keys });
    return values || {};
  }

  /**
   * 在庫の入力画面（new-item-modal）に、人が確定した値を入れて読み戻す JS 片。
   * 下書きからの登録・仮登録・出品後の紐づけで共通。失敗したらモーダルを閉じて FILL_FAILED を返す。
   * 前提: 呼び出し側の JS に `const v = ...` は無い（ここで定義する）。
   */
  static fillScript({ cost, min, buffer, shippingMethodId, shippingCost, supplier, purchaseDate, listedAt }) {
    return `
      const set = (id, val) => { const el = document.getElementById(id); if (!el) throw new Error('入力欄がありません: ' + id); el.value = val; };
      try {
        ${cost == null ? '' : `set('ni-cost', ${js(String(cost))});`}
        ${min == null ? '' : `set('ni-minprice', ${js(String(min))});`}
        ${buffer == null ? '' : `setBuffer(${js(buffer)});`}
        ${shippingMethodId == null ? '' : `{
          const sel = document.getElementById('ni-shipping-method');
          if (!sel || ![...sel.options].some((o) => o.value === ${js(shippingMethodId)})) throw new Error('配送方法がありません: ' + ${js(shippingMethodId)});
          sel.value = ${js(shippingMethodId)};
          onNiShippingMethodChange();
        }`}
        ${shippingCost == null ? '' : `set('ni-shipping', ${js(String(shippingCost))});`}
        ${supplier ? `set('ni-supplier', ${js(supplier)});` : ''}
        ${purchaseDate ? `set('ni-purchase-date', ${js(purchaseDate)});` : ''}
        ${listedAt ? `set('ni-listed-at', ${js(listedAt)});` : ''}
        calcItemPrice();
      } catch (e) {
        try { closeModal('new-item-modal'); } catch (e2) {}
        return { ok: false, code: 'FILL_FAILED', message: String((e && e.message) || e) };
      }
      const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
      const form = {
        title: v('ni-title'), cost: v('ni-cost'), minPrice: v('ni-minprice'), buffer: v('ni-buffer'),
        fee: v('ni-fee'), shippingCost: v('ni-shipping'), shippingMethodId: v('ni-shipping-method'),
        marketplaceId: v('ni-marketplace'), category: v('ni-category'), condition: v('ni-condition'),
        listedAt: v('ni-listed-at'), supplier: v('ni-supplier'), purchaseDate: v('ni-purchase-date'),
      };`;
  }

  /**
   * 下書き 1 件を「在庫に登録」する。アプリ自身の経路（出品登録ボタンと同じ
   * openNewItemModalFromDraftIndex → 各欄 → saveNewItem）を通す。localStorage は直接書かない。
   *
   * - 下書きは **id で探す**（位置は一覧を見てから渡すまでに動く）。無ければ止まる
   * - `save:false` は欄を埋めて内容を読み出し、保存せずモーダルを閉じる（通し稽古）
   * - 保存したら、在庫の件数の前後と、メルカリ商品 ID で見つけた 1 件を返す
   *
   * 在庫の欄 ID とグローバル関数はここに集約する。壊れたときに直す場所を 1 箇所に保つ。
   */
  async registerFromDraft({ draftId, itemId, cost, min, buffer, shippingMethodId, shippingCost, supplier, purchaseDate }, { save }) {
    return this.evaluate(`(() => {
      const wantId = ${js(String(draftId))};
      const itemId = ${js(itemId)};
      const readItems = () => { try { return JSON.parse(localStorage.getItem('furimora_items') || '[]'); } catch (e) { return []; } };
      let drafts;
      try { drafts = JSON.parse(localStorage.getItem('furimora_drafts') || '[]'); } catch (e) { drafts = []; }
      const index = drafts.findIndex((d) => d && String(d.id) === wantId);
      if (index < 0) return { ok: false, code: 'DRAFT_NOT_FOUND', message: '下書き ' + wantId + ' が見つかりません（消えた可能性があります）' };
      try { openNewItemModalFromDraftIndex(index); }
      catch (e) { return { ok: false, code: 'OPEN_FORM_FAILED', message: String((e && e.message) || e) }; }
      const modal = document.getElementById('new-item-modal');
      if (!modal || !modal.classList.contains('open')) return { ok: false, code: 'FORM_NOT_OPEN', message: '在庫の入力画面が開きませんでした' };
      ${FurimoraService.fillScript({ cost, min, buffer, shippingMethodId, shippingCost, supplier, purchaseDate })}
      if (${save ? 'false' : 'true'}) {
        try { closeModal('new-item-modal'); } catch (e) {}
        return { ok: true, saved: false, form };
      }
      const before = readItems().length;
      try { saveNewItem(); }
      catch (e) { return { ok: false, code: 'SAVE_THREW', message: String((e && e.message) || e), form }; }
      const items = readItems();
      const hit = items.find((it) => it && String(it.mercariItemId) === itemId) || null;
      return { ok: true, saved: true, form, before, after: items.length, item: hit };
    })()`, { timeoutMs: 30000 });
  }

  /**
   * **仮登録**: メルカリの下書きを作った時点で、フリモーラの在庫にも 1 件入れる。
   * まだ出品していないのでメルカリの商品URL・IDは無い（出品後に adoptListing で紐づける）。
   * アプリ自身の経路（openNewItemModal → 各欄 → saveNewItem）を通す。localStorage は直接書かない。
   *
   * 見つけ方: メルカリ商品 ID が無いので、タイトルが同じで ID の無い在庫のうち最新の 1 件。
   */
  async registerPending({ title, description, min, cost, buffer, category, condition, shippingMethodId, shippingCost, supplier, purchaseDate }, { save }) {
    return this.evaluate(`(() => {
      const wantTitle = ${js(title)};
      const readItems = () => { try { return JSON.parse(localStorage.getItem('furimora_items') || '[]'); } catch (e) { return []; } };
      try {
        navigate('relist');
        openNewItemModal({ title: wantTitle, description: ${js(description ?? '')}, price: ${js(min)}, category: ${js(category ?? '')}, condition: ${js(condition ?? '')}, images: [], url: '' });
      } catch (e) { return { ok: false, code: 'OPEN_FORM_FAILED', message: String((e && e.message) || e) }; }
      const modal = document.getElementById('new-item-modal');
      if (!modal || !modal.classList.contains('open')) return { ok: false, code: 'FORM_NOT_OPEN', message: '在庫の入力画面が開きませんでした' };
      ${FurimoraService.fillScript({ cost, min, buffer, shippingMethodId, shippingCost, supplier, purchaseDate })}
      if (${save ? 'false' : 'true'}) {
        try { closeModal('new-item-modal'); } catch (e) {}
        return { ok: true, saved: false, form };
      }
      const before = readItems().length;
      try { saveNewItem(); }
      catch (e) { return { ok: false, code: 'SAVE_THREW', message: String((e && e.message) || e), form }; }
      const items = readItems();
      const hit = items.find((it) => it && it.title === wantTitle && !it.mercariItemId && !it.mercariUrl && Number(it.minPrice) === ${js(min)}) || null;
      return { ok: true, saved: true, form, before, after: items.length, item: hit };
    })()`, { timeoutMs: 30000 });
  }

  /**
   * **出品後の紐づけ**: 仮登録した在庫に、出品したメルカリ商品のURL・IDと実際の出品価格を入れる。
   * 在庫の「編集」と同じ経路（openInventoryEditItemModal → 各欄 → saveNewItem）。新規作成にはならない。
   * 画像は下書き（出品URLから作った複製）のものを入れる。出品日は今日に更新する。
   */
  async adoptListing({ localId, itemId, url, min, buffer, cost, listedAt, images, shippingMethodId, shippingCost }, { save }) {
    return this.evaluate(`(() => {
      const readItems = () => { try { return JSON.parse(localStorage.getItem('furimora_items') || '[]'); } catch (e) { return []; } };
      const target = readItems().find((it) => it && String(it.id) === ${js(String(localId))});
      if (!target) return { ok: false, code: 'PENDING_NOT_FOUND', message: '仮登録した在庫 ' + ${js(String(localId))} + ' が見つかりません' };
      if (target.mercariItemId || target.mercariUrl) return { ok: false, code: 'ALREADY_LINKED', message: 'この在庫はすでにメルカリ商品に紐づいています' };
      try { navigate('relist'); openInventoryEditItemModal(target.id); }
      catch (e) { return { ok: false, code: 'OPEN_FORM_FAILED', message: String((e && e.message) || e) }; }
      const modal = document.getElementById('new-item-modal');
      if (!modal || !modal.classList.contains('open')) return { ok: false, code: 'FORM_NOT_OPEN', message: '在庫の編集画面が開きませんでした' };
      modal.dataset.mercariUrl = ${js(url)};
      modal.dataset.mercariItemId = ${js(itemId)};
      ${Array.isArray(images) && images.length ? `modal.dataset.images = ${js(JSON.stringify(images))};` : ''}
      ${FurimoraService.fillScript({ cost, min, buffer, listedAt, shippingMethodId, shippingCost })}
      if (${save ? 'false' : 'true'}) {
        try { closeModal('new-item-modal'); } catch (e) {}
        return { ok: true, saved: false, form };
      }
      const before = readItems().length;
      try { saveNewItem(); }
      catch (e) { return { ok: false, code: 'SAVE_THREW', message: String((e && e.message) || e), form }; }
      const items = readItems();
      const hit = items.find((it) => it && String(it.id) === ${js(String(localId))}) || null;
      return { ok: true, saved: true, form, before, after: items.length, item: hit };
    })()`, { timeoutMs: 30000 });
  }
}
