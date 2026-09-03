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
}
