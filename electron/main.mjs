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
/**
 * メルカリ専用の非表示ウィンドウ。**独立 partition。**
 * 外部 Chrome + Playwright を畳むための受け皿（~/.furimora/chrome-profile の置き換え）。
 * `show: false` で作るので、そもそも前面に出てくる概念が無い。
 */
/** @type {BrowserWindow | null} */
let mercariWindow = null;
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

function createMercariWindow() {
  mercariWindow = new BrowserWindow({
    width: 1280, height: 900,
    show: false,               // 既定で非表示。ログインのときだけ show_window で出す
    title: 'メルカリ（フリモーラ）',
    webPreferences: {
      partition: 'persist:mercari',   // フリモーラのセッションとは完全に分ける
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mercariWindow.on('closed', () => { mercariWindow = null; });
  return mercariWindow;
}

/**
 * 対象のウィンドウを返す。
 * @param {'furimora'|'mercari'} target
 * @param {{ create?: boolean }} [opts] mercari は必要になった時点で作る
 */
function requireWindow(target = 'furimora', { create = false } = {}) {
  if (target === 'mercari') {
    if ((!mercariWindow || mercariWindow.isDestroyed()) && create) return createMercariWindow();
    if (!mercariWindow || mercariWindow.isDestroyed()) throw new Error('メルカリのウィンドウが開いていません');
    return mercariWindow;
  }
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
      mercariWindowOpen: !!(mercariWindow && !mercariWindow.isDestroyed()),
    };
  },

  /**
   * localStorage のキーを読む（読み取りのみ）。
   * 値は生の文字列で返す。解釈は呼び出し側でやる。
   */
  async read_storage({ keys, target = 'furimora' }) {
    if (!Array.isArray(keys) || !keys.length) throw new Error('keys（配列）が必要です');
    const win = requireWindow(target);
    const script = `(() => {
      const out = {};
      for (const k of ${JSON.stringify(keys)}) {
        try { out[k] = localStorage.getItem(k); } catch (e) { out[k] = null; }
      }
      return { values: out, origin: location.origin };
    })()`;
    return win.webContents.executeJavaScript(script);
  },

  /**
   * ページの主世界で JS を評価する。
   *
   * ここまでの `read_storage` / `auth_state` は用途を絞った操作だったが、
   * フォームの駆動は「値を入れて → 非同期の取得を待って → 保存を押す」という
   * 手順そのものなので、narrow な op に割ると却って読めなくなる。
   * **どの画面をどう触るかは mcp/src/furimora-service.mjs に集約する**
   * （メルカリ側のセレクタを mercari-service.mjs に集めているのと同じ方針）。
   *
   * ソケットは 0600 のローカル専用で、叩けるのは既に信頼している MCP サーバーだけ。
   * BrowserService.evaluate が持っている権限と同じ。
   */
  async evaluate({ script, userGesture = true, target = 'furimora' }) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('script（文字列）が必要です');
    const win = requireWindow(target, { create: target === 'mercari' });
    return win.webContents.executeJavaScript(script, userGesture);
  },

  /**
   * ページを開く。
   * SPA のリダイレクトで loadURL が ERR_ABORTED を投げることがあるが、
   * URL が変わっていれば遷移自体は成功しているので握りつぶす（Playwright も同様に扱う）。
   */
  async open_page({ url, target = 'furimora', timeoutMs = 45000 }) {
    if (!url) throw new Error('url が必要です');
    const win = requireWindow(target, { create: target === 'mercari' });
    const wc = win.webContents;
    try {
      await Promise.race([
        wc.loadURL(url),
        new Promise((_r, rej) => setTimeout(() => rej(new Error(`読み込みがタイムアウトしました（${timeoutMs}ms）`)), timeoutMs)),
      ]);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!msg.includes('ERR_ABORTED')) throw e;
    }
    return { url: wc.getURL() };
  },

  async current_url({ target = 'furimora' }) {
    return { url: requireWindow(target).webContents.getURL() };
  },

  /**
   * input[type=file] にファイルを渡す。
   * DOM API では偽装できないので CDP の DOM.setFileInputFiles を使う。
   * **外部ブラウザではなく自分のプロセス内の CDP** なので、外部 Chrome の管理は増えない。
   */
  async set_input_files({ selector, files, target = 'mercari' }) {
    if (!selector) throw new Error('selector が必要です');
    if (!Array.isArray(files) || !files.length) throw new Error('files（配列）が必要です');
    const wc = requireWindow(target, { create: target === 'mercari' }).webContents;
    const attached = wc.debugger.isAttached();
    if (!attached) wc.debugger.attach('1.3');
    try {
      const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`要素が見つかりません: ${selector}`);
      await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
      return { ok: true, count: files.length };
    } finally {
      if (!attached) { try { wc.debugger.detach(); } catch { /* 既に外れている */ } }
    }
  },

  /** ログインなど人間の操作が要るときだけウィンドウを出す */
  async show_window({ target = 'mercari', show = true }) {
    const win = requireWindow(target, { create: target === 'mercari' });
    if (show) { win.show(); win.focus(); } else { win.hide(); }
    return { shown: show };
  },

  async close_window({ target }) {
    if (target !== 'mercari') throw new Error('閉じられるのは mercari のウィンドウだけです');
    if (mercariWindow && !mercariWindow.isDestroyed()) mercariWindow.destroy();
    mercariWindow = null;
    return { closed: true };
  },

  /** ログイン状態。UID もメールアドレスも中身は返さない */
  async auth_state() {
    const win = requireWindow('furimora');
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
