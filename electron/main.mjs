/**
 * フリモーラ Desktop。
 *
 * **これがデスクトップのフリモーラそのものになる。** Vivaldi のタブで開くのをやめ、
 * これを使う。そうしないと同期の書き手が 2 人のままで、競合したとき
 * furimoraApplySyncPayload(payload, replaceLocal=true) に片方の作業を消される。
 *
 * UI は作り直さない。デプロイ済みの本番をそのまま開く
 * （ローカルに public/ を置くと /api/* と Firebase の authDomain が壊れる）。
 */
import { app, BrowserWindow, shell } from 'electron';
import { startControlServer } from './control.mjs';

const APP_URL = process.env.FURIMORA_URL || 'https://furimora.vercel.app';
const PARTITION = 'persist:furimora';

/** 二重起動を許さない。書き手を 1 人に保つのがこのアプリの存在理由なので、ここは譲れない */
if (!app.requestSingleInstanceLock()) {
  console.error('[furimora-desktop] 既に起動しています。既存のウィンドウを使ってください');
  app.exit(0);
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
let control = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'フリモーラ',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // ページに Node を一切渡さない。MCP からの操作はメインプロセス側の
      // executeJavaScript だけで行う（preload を置くと攻撃面が広がる）
    },
  });
  mainWindow.loadURL(APP_URL);

  // アプリ外へのリンクは既定のブラウザで開く。ただし Firebase の認証ハンドラだけは
  // アプリ内で開かせる（signInWithPopup が使う。外に出すとログインが完了しない）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('/__/auth/')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** ウィンドウが生きていることを確かめてから使う */
function requireWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('フリモーラのウィンドウが開いていません');
  return mainWindow;
}

/** MCP から呼べる操作。増やすときは「必要になったものだけ」足す */
const ops = {
  async ping() {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    return {
      ok: true,
      app: 'furimora-desktop',
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      url: win ? win.webContents.getURL() : null,
      windowOpen: !!win,
    };
  },

  /**
   * localStorage のキーを読む（読み取りのみ）。
   * 値は生の文字列で返す。解釈は呼び出し側でやる。
   */
  async read_storage({ keys }) {
    if (!Array.isArray(keys) || !keys.length) throw new Error('keys（配列）が必要です');
    const win = requireWindow();
    const script = `(() => {
      const out = {};
      for (const k of ${JSON.stringify(keys)}) {
        try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; }
      }
      return { values: out, origin: location.origin };
    })()`;
    return win.webContents.executeJavaScript(script);
  },

  /** ログイン状態。UID もメールアドレスも中身は返さない */
  async auth_state() {
    const win = requireWindow();
    return win.webContents.executeJavaScript(`(() => {
      try {
        const u = (typeof furimoraCurrentUser === 'function') ? furimoraCurrentUser() : null;
        if (!u) return { loggedIn: false };
        return { loggedIn: true, provider: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || null };
      } catch (e) { return { loggedIn: false, error: String((e && e.message) || e) }; }
    })()`);
  },
};

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  createWindow();
  try {
    control = await startControlServer(ops);
    console.log('[furimora-desktop] 制御チャネル開始');
  } catch (e) {
    // ソケットが張れなくても GUI は使えるべきなので、落とさず警告に留める
    console.error('[furimora-desktop] 制御チャネルを開始できません:', String((e && e.message) || e));
  }
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', async () => { if (control) await control.close(); });
