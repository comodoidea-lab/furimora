/**
 * フェーズ0 PoC — 3 項目を確かめて記録するだけ。ここで止める。
 *
 *   1. https://furimora.vercel.app がそのまま開くか
 *   2. ログインが通るか（操作は人間。ここでは結果を観測するだけ）
 *   3. executeJavaScript で furimora_drafts が読めるか
 *
 * **既存コードは一切変更しない。認証方式も変えない。**
 * 失敗したらエラー内容を記録して終わる。直しに行かない。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT = path.join(HERE, 'result.json');
const TARGET = 'https://furimora.vercel.app';
const TIMEOUT_MS = 15 * 60 * 1000;

const report = {
  startedAt: new Date().toISOString(),
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  target: TARGET,
  check1_load: null,
  check2_login: null,
  check3_readDrafts: null,
  loadFailures: [],
  consoleErrors: [],
  popups: [],
};

const save = () => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n=== 結果 ===\n' + JSON.stringify(report, null, 2));
};

// 認証の有無だけ見る。uid もメールアドレスも中身は記録しない
const PROBE_LOGIN = `(() => {
  try {
    const u = (typeof furimoraCurrentUser === 'function') ? furimoraCurrentUser() : null;
    if (u) return { loggedIn: true, hasUid: !!u.uid, hasEmail: !!u.email, provider: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || null };
    return { loggedIn: false };
  } catch (e) { return { loggedIn: false, probeError: String((e && e.message) || e) }; }
})()`;

const PROBE_DRAFTS = `(() => {
  try {
    const raw = localStorage.getItem('furimora_drafts');
    if (raw == null) return { readable: true, present: false, note: 'キーが無い（未ログイン or 同期前）' };
    const arr = JSON.parse(raw);
    return {
      readable: true, present: true, bytes: raw.length,
      count: Array.isArray(arr) ? arr.length : null,
      firstTitle: (Array.isArray(arr) && arr[0]) ? String(arr[0].title || '').slice(0, 40) : null,
    };
  } catch (e) { return { readable: false, error: String((e && e.message) || e) }; }
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280, height: 900, show: true,
    webPreferences: { partition: 'persist:furimora-poc', contextIsolation: true, nodeIntegration: false },
  });
  const wc = win.webContents;

  wc.on('did-fail-load', (_e, code, desc, url) => {
    report.loadFailures.push({ code, desc, url });
  });
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) report.consoleErrors.push(String(message).slice(0, 300));
  });
  // signInWithPopup は window.open を使う。塞ぐと2の結果が「Electronのせい」か
  // 「Googleに弾かれた」か区別できなくなるので、PoC では開かせて観測する
  wc.setWindowOpenHandler(({ url }) => {
    report.popups.push({ url: url.split('?')[0], at: new Date().toISOString() });
    return { action: 'allow' };
  });
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('did-fail-load', (_x, code, desc, url) => {
      report.popups.push({ failed: true, code, desc, url: String(url).split('?')[0] });
    });
  });

  try {
    await wc.loadURL(TARGET);
    const info = await wc.executeJavaScript('({ title: document.title, url: location.origin, hasApp: typeof furimoraCurrentUser === "function" })');
    report.check1_load = { ok: true, ...info };
    console.log('[1] 読み込み OK:', JSON.stringify(info));
  } catch (e) {
    report.check1_load = { ok: false, error: String((e && e.message) || e) };
    console.log('[1] 読み込み 失敗:', report.check1_load.error);
    save(); app.quit(); return;
  }

  console.log('\n>>> ウィンドウでログインしてください。ログインを検知するか、ウィンドウを閉じると結果を出します。\n');
  const started = Date.now();
  const tick = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(tick); return; }
    try {
      const login = await wc.executeJavaScript(PROBE_LOGIN);
      const drafts = await wc.executeJavaScript(PROBE_DRAFTS);
      report.check2_login = login;
      report.check3_readDrafts = drafts;
      if (login.loggedIn) {
        console.log('[2] ログイン検知:', JSON.stringify(login));
        console.log('[3] furimora_drafts:', JSON.stringify(drafts));
        clearInterval(tick); save(); app.quit();
      }
    } catch (e) {
      report.check2_login = { loggedIn: false, probeError: String((e && e.message) || e) };
    }
    if (Date.now() - started > TIMEOUT_MS) {
      console.log('タイムアウト。そこまでの結果を記録します');
      clearInterval(tick); save(); app.quit();
    }
  }, 3000);

  win.on('closed', () => { clearInterval(tick); save(); app.quit(); });
});

app.on('window-all-closed', () => app.quit());
