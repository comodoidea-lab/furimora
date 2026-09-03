/**
 * BrowserService と同じ面を、フリモーラ Desktop（Electron）の非表示ウィンドウで実装する。
 *
 * **MercariService は無改修で動く。** ロードマップが「BrowserService / MercariService の
 * 層が分かれていれば下だけ差し替えられる」と書いていたとおりの差し替え。
 *
 * これに寄せると外部 Chrome（~/.furimora/chrome-profile + Playwright）が要らなくなる:
 *   - `show: false` で作るので**前面に出てくる概念が無い**
 *   - Chrome の ProcessSingleton（同時 1 プロセス）の制約が消える
 *   - キャッシュ方針がこちらの持ち物になる（881 MB のような育ち方をさせずに済む）
 *
 * **既定では使わない。** メルカリ側は書き込み経路なので、読み取りで十分検証してから
 * 既定を切り替える（フェーズ1で読み取りから始めたのと同じ順序）。
 */
const TARGET = 'mercari';

/** ページ内で使う小道具。evaluate へ文字列として送り込む */
const HELPERS = `
  const __vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const __find = (sel) => [...document.querySelectorAll(sel)].find(__vis) || document.querySelector(sel);
`;

export class ElectronBrowserService {
  /**
   * @param {(op:string, args?:object, opts?:object)=>Promise<any>} call フリモーラ Desktop を叩く関数
   */
  constructor(call, { defaultTimeout = 30000 } = {}) {
    this.call = call;
    this.defaultTimeout = defaultTimeout;
    /** BrowserService と同じ形にしておく。headless 相当＝非表示ウィンドウ */
    this.headless = true;
  }

  /** Electron 側でウィンドウは遅延生成されるので、ここでは何もしない */
  async startBrowser() { await this.call('ping', {}, { timeoutMs: 5000 }); }

  /**
   * ウィンドウを閉じる。
   * **外部 Chrome と違い「都度開いて閉じる」必要は無い**（ProcessSingleton が無いため）が、
   * BrowserService と同じ面を保つために用意する。
   */
  async stopBrowser() { try { await this.call('close_window', { target: TARGET }); } catch { /* 既に無い */ } }

  async openPage(url, { timeout = 45000 } = {}) {
    const r = await this.call('open_page', { url, target: TARGET, timeoutMs: timeout }, { timeoutMs: timeout + 5000 });
    return r.url;
  }

  async getCurrentUrl() { return (await this.call('current_url', { target: TARGET })).url; }

  async getPageHtml() { return this.#eval(`document.documentElement.outerHTML`); }

  /** ページ内で任意の JS を評価する。Electron は文字列しか受けないので毎回組み立てる */
  #eval(expr, { timeoutMs } = {}) {
    return this.call('evaluate', { script: expr, target: TARGET }, { timeoutMs: timeoutMs ?? this.defaultTimeout + 5000 });
  }

  /**
   * Playwright と同じく「関数と引数」で呼べるようにする。
   * 関数は文字列化して送るので、**引数は直列化可能なものに限る**
   * （SELECTORS を丸ごと渡している制約はここでも同じ）。
   */
  async evaluate(fn, arg) {
    const body = typeof fn === 'function' ? fn.toString() : String(fn);
    const argLiteral = arg === undefined ? '' : JSON.stringify(arg);
    return this.#eval(`(${body})(${argLiteral})`);
  }

  async waitForTimeout(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** セレクタが現れるまで待つ。ページ内でポーリングする（往復を増やさない） */
  async waitForSelector(selector, { timeout = this.defaultTimeout } = {}) {
    const found = await this.#eval(`(async () => {
      ${HELPERS}
      const sel = ${JSON.stringify(selector)};
      const deadline = Date.now() + ${Number(timeout)};
      while (Date.now() < deadline) {
        if (document.querySelector(sel)) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`, { timeoutMs: timeout + 10000 });
    if (!found) throw new Error(`要素が現れませんでした: ${selector}（${timeout}ms）`);
    return true;
  }

  async scrollIntoView(selector) {
    return this.#eval(`(() => {
      ${HELPERS}
      const el = __find(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      return !!el;
    })()`);
  }

  /** 押す前に必ず見える位置へ寄せる。画像でフォームが伸びると押せなくなるのは実測済み */
  async #clickExpr(pickExpr, label) {
    const ok = await this.#eval(`(async () => {
      ${HELPERS}
      const el = ${pickExpr};
      if (!el) return { ok: false, reason: 'not_found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise((r) => setTimeout(r, 120));
      if (el.disabled) return { ok: false, reason: 'disabled' };
      el.click();
      return { ok: true };
    })()`);
    if (!ok?.ok) throw new Error(`クリックできません（${ok?.reason || 'unknown'}）: ${label}`);
    return true;
  }

  async click(selector) {
    await this.waitForSelector(selector);
    return this.#clickExpr(`__find(${JSON.stringify(selector)})`, selector);
  }

  async clickNth(selector, index) {
    await this.waitForSelector(selector);
    return this.#clickExpr(
      `[...document.querySelectorAll(${JSON.stringify(selector)})][${Number(index)}]`,
      `${selector} [${index}]`
    );
  }

  async clickFirstWithText(selector, text) {
    await this.waitForSelector(selector);
    return this.#clickExpr(
      `[...document.querySelectorAll(${JSON.stringify(selector)})].filter(__vis)
        .find((e) => (e.textContent || '').includes(${JSON.stringify(text)}))`,
      `${selector} ⊃ ${JSON.stringify(text)}`
    );
  }

  /**
   * 入力欄に値を入れる。
   *
   * **素直に .value を代入しても React は気づかない。**
   * React は value に自前のセッターを被せて変更を追跡しているので、
   * プロトタイプ側のネイティブセッターで書いてから input / change を bubbles で飛ばす。
   * ここを間違えると「入れたつもりで空のまま保存される」という最悪の壊れ方をする。
   */
  async fill(selector, value) {
    await this.waitForSelector(selector);
    const res = await this.#eval(`(() => {
      ${HELPERS}
      const el = __find(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not_found' };
      const val = ${JSON.stringify(String(value ?? ''))};
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      el.focus();
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, readBack: el.value };
    })()`);
    if (!res?.ok) throw new Error(`入力できません（${res?.reason || 'unknown'}）: ${selector}`);
    if (res.readBack !== String(value ?? '')) {
      throw new Error(`入力が反映されていません: ${selector}（期待 ${JSON.stringify(String(value ?? ''))} / 実際 ${JSON.stringify(res.readBack)}）`);
    }
    return true;
  }

  /** input[type=file] へファイルを渡す。パスの存在確認は呼び出し側の責任 */
  async setInputFiles(selector, files) {
    const list = Array.isArray(files) ? files : [files];
    return this.call('set_input_files', { selector, files: list, target: TARGET }, { timeoutMs: 60000 });
  }

  /** ログインなど人間の操作が要るときだけ出す */
  async showWindow(show = true) { return this.call('show_window', { target: TARGET, show }); }
}
