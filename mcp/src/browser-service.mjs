/**
 * BrowserService — ブラウザ固有のコードをこの層に閉じ込める。
 *
 * 上位（MercariService）はブラウザの実装を知らない。将来 Electron の webContents や
 * 別のブラウザへ差し替える場合も、同じインターフェースを実装すれば上位は無改修で済む。
 *
 * 現在の実装: 専用プロファイルの Chrome を playwright-core で起動する。
 * ユーザーが普段使っている Chrome には一切触れない（プロファイルが別）。
 * ログインセッションは userDataDir に永続するので、初回ログイン以降は再利用される。
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

/** macOS / Windows / Linux の既定の Chrome 実行ファイルを探す */
export function findChrome() {
  const candidates = [
    process.env.FURIMORA_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export const DEFAULT_PROFILE_DIR = path.join(os.homedir(), '.furimora', 'chrome-profile');

export class BrowserService {
  /**
   * @param {object} [opts]
   * @param {string} [opts.userDataDir] 専用プロファイルの置き場所
   * @param {boolean} [opts.headless] 既定は true。ログイン時のみ false にする
   * @param {string} [opts.executablePath] Chrome の実行ファイル
   */
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir || DEFAULT_PROFILE_DIR;
    this.headless = opts.headless !== undefined ? opts.headless : true;
    this.executablePath = opts.executablePath || findChrome();
    this.context = null;
    this.page = null;
  }

  hasProfile() {
    try { return fs.existsSync(path.join(this.userDataDir, 'Default')); } catch { return false; }
  }

  async startBrowser() {
    if (this.context) return;
    if (!this.executablePath) {
      throw new Error('Chrome が見つかりません。FURIMORA_CHROME_PATH で実行ファイルを指定してください。');
    }
    fs.mkdirSync(this.userDataDir, { recursive: true });
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      executablePath: this.executablePath,
      headless: this.headless,
      viewport: { width: 1280, height: 900 },
      locale: 'ja-JP',
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
  }

  /** 確実に終了させる。子プロセスを残さない。 */
  async stopBrowser() {
    try { if (this.context) await this.context.close(); } catch { /* 既に落ちている */ }
    this.context = null;
    this.page = null;
  }

  async openPage(url, { waitUntil = 'domcontentloaded', timeout = 45000 } = {}) {
    await this.page.goto(url, { waitUntil, timeout });
    return this.page.url();
  }

  async getCurrentUrl() { return this.page.url(); }
  async getPageHtml() { return this.page.content(); }
  async evaluate(fn, arg) { return this.page.evaluate(fn, arg); }
  async click(selector, o = {}) { return this.page.click(selector, o); }
  async fill(selector, value, o = {}) { return this.page.fill(selector, value, o); }
  async waitForSelector(selector, o = {}) { return this.page.waitForSelector(selector, o); }
  /** 同じセレクタに一致する要素のうち index 番目を押す。文言が重複する行を選ぶときに使う */
  async clickNth(selector, index, o = {}) { return this.page.locator(selector).nth(index).click(o); }
  /** input[type=file] へファイルを渡す。パスは呼び出し側で存在確認しておくこと */
  async setInputFiles(selector, files) { return this.page.setInputFiles(selector, files); }
  async waitForTimeout(ms) { return this.page.waitForTimeout(ms); }

  /** 診断用。Cookie の値そのものは絶対に返さない（ログにも出さない）。 */
  async cookieSummary() {
    const cookies = await this.context.cookies();
    return cookies.map((c) => ({
      name: c.name, domain: c.domain, secure: c.secure, httpOnly: c.httpOnly,
      valueLength: String(c.value ?? '').length,
    }));
  }
}
