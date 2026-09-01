/**
 * BrowserService（PoC 版）
 * Obscura 固有のコードはこの層に閉じ込める。上位層は Obscura を直接知らない。
 * 将来ブラウザを差し替える場合は、このクラスと同じインターフェースを実装すれば済む。
 */
import { chromium } from 'playwright-core';
import { ObscuraProcess } from './obscura-process.mjs';

export class BrowserService {
  /**
   * @param {{binPath: string, port?: number, storageDir?: string, stealth?: boolean, verbose?: boolean}} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.process = new ObscuraProcess(opts);
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async startBrowser() {
    await this.process.start();
    this.browser = await chromium.connectOverCDP(this.process.cdpUrl);
    this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    this.page = this.context.pages()[0] || (await this.context.newPage());
    return { cdpUrl: this.process.cdpUrl };
  }

  async stopBrowser() {
    try { if (this.browser) await this.browser.close(); } catch {}
    this.browser = null; this.context = null; this.page = null;
    await this.process.stop();
  }

  async openPage(url, { waitUntil = 'load', timeout = 45000 } = {}) {
    await this.page.goto(url, { waitUntil, timeout });
    return this.getCurrentUrl();
  }

  async getCurrentUrl() { return this.page.url(); }
  async getPageHtml() { return this.page.content(); }
  async evaluate(fn, arg) { return this.page.evaluate(fn, arg); }
  async click(selector, o = {}) { return this.page.click(selector, o); }
  /**
   * fill(): Obscura の CDP は Input.insertText 未実装、Input.dispatchKeyEvent も
   * input の value を更新しないため、Playwright の fill/type がそのままでは効かない。
   * ネイティブ value setter 経由で値を入れ、input/change を発火させる方式へフォールバックする。
   * （React の controlled input はネイティブ setter を使わないと state に伝わらない）
   */
  async fill(selector, value, o = {}) {
    try {
      await this.page.fill(selector, value, { timeout: 3000, ...o });
      return;
    } catch {
      // Obscura フォールバックへ
    }
    const applied = await this.page.evaluate(
      ({ selector, value }) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.focus();
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === value;
      },
      { selector, value }
    );
    if (!applied) throw new Error(`fill に失敗しました: ${selector}`);
  }
  async waitForSelector(selector, o = {}) { return this.page.waitForSelector(selector, o); }
  async getCookies() { return this.context.cookies(); }
  async setCookies(cookies) { return this.context.addCookies(cookies); }

  /**
   * Obscura は --storage-dir 指定時、クリーン終了時とナビゲーション完了ごとに
   * cookies.json / localStorage を自分でディスクへ書き出す。
   * saveSession/restoreSession はその仕組みの明示的なラッパー。
   */
  async saveSession() {
    if (!this.opts.storageDir) throw new Error('storageDir が未設定です');
    // クリーン終了で確実にフラッシュさせる
    await this.stopBrowser();
    return { storageDir: this.opts.storageDir };
  }

  async restoreSession() {
    if (!this.opts.storageDir) throw new Error('storageDir が未設定です');
    if (!this.browser) await this.startBrowser();
    return { storageDir: this.opts.storageDir };
  }

  /** 診断用。Cookie の値そのものは絶対にログへ出さない */
  cookieSummary(cookies) {
    return cookies.map((c) => ({
      name: c.name, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure,
      valueLength: String(c.value ?? '').length,
    }));
  }
}
