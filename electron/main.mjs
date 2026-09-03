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
import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { startControlServer } from './control.mjs';

/**
 * **userData のパスを現在の値に固定する。ここを動かすと全部壊れる。**
 *
 * 既定では package.json の name（productName があればそちら）からパスが決まる。
 * つまり productName を「フリモーラ」にした瞬間に
 * `~/Library/Application Support/フリモーラ` へ移り、いま使っている
 *
 *   Partitions/furimora  … フリモーラとメルカリの**両方**のログイン
 *   Partitions/mercari   … MCP 経路のメルカリのログイン
 *
 * が参照されなくなる。**ログインが 3 つとも消える。**
 * 2026-09-03 に LIVE で通した値下げ経路（カードのクリック → 捕捉 → identity proof →
 * メルカリ保存 → フリモーラ記録）は、この Partitions/furimora のセッションに依存している。
 *
 * アプリ名やアイコンを変えても壊れないよう、名前とは切り離して明示的に固定する。
 * **移設したくなったら、先にディレクトリを移してからこの値を変えること。**
 */
const USER_DATA_DIR = path.join(app.getPath('appData'), 'furimora-desktop');
app.setPath('userData', USER_DATA_DIR);

/** Dock / メニュー / About に出る名前。package.json の productName と一致させる */
const APP_NAME = 'フリモーラ';
app.setName(APP_NAME);

/**
 * ログイン時に自動起動する。**初回の1回だけ登録する。**
 *
 * 毎回 setLoginItemSettings(true) を呼ぶと、システム設定で外しても次の起動で
 * 勝手に戻ってしまう。**利用者が外した選択を尊重する**ため、印を残して一度きりにする。
 *
 * `app.isPackaged` を見ているのは、`npm start`（開発用）で呼ぶと
 * **Electron.app 自体がログイン項目に登録されてしまう**ため。
 */
function registerLoginItemOnce() {
  if (!app.isPackaged) return;
  const marker = path.join(USER_DATA_DIR, '.login-item-registered');
  if (fs.existsSync(marker)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(marker, new Date().toISOString());
    console.log('[furimora-desktop] ログイン項目に登録しました（初回のみ）');
  } catch (e) {
    console.error('[furimora-desktop] ログイン項目に登録できません:', String((e && e.message) || e));
  }
}

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

/**
 * クリックの結果として開かれた子ウィンドウ。**route provenance の要。**
 *
 * mercari-relist-batch の安全規則は「在庫カードのクリックで開いたタブだけを使う」ことを
 * 求めている。URL を取り出して開き直すのも、別セッションへ移すのも禁止
 * （経路の証明が消えるため。実際にこの経路を破って 24 件を落としている）。
 *
 * Electron の setWindowOpenHandler は `action: 'allow'` のまま子ウィンドウを作れるので、
 * **URL を組み立てず、パーティションも上書きせず**に、開かれたウィンドウそのものを掴める。
 */
/** @type {Map<string, BrowserWindow>} */
const capturedWindows = new Map();
let captureArmed = null;
let captureSeq = 0;

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
    // 捕捉待ちのときは、そのまま開かせて掴む。
    // **パーティションを上書きしない**（別セッションへ移すと route provenance が消える）
    if (captureArmed) return { action: 'allow' };
    if (url.includes('/__/auth/')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 実際に生まれたウィンドウを受け取る。URL ではなくウィンドウ自体を掴むのが要点
  mainWindow.webContents.on('did-create-window', (child, details) => {
    if (!captureArmed) {
      // 捕捉していないのに開いた窓は放置しない（AI 認証の窓などはここに来る）
      return;
    }
    const id = `captured:${++captureSeq}`;
    capturedWindows.set(id, child);
    child.on('closed', () => capturedWindows.delete(id));
    const armed = captureArmed;
    captureArmed = null;
    armed.resolve({ id, url: details?.url || child.webContents.getURL() });
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
  if (typeof target === 'string' && target.startsWith('captured:')) {
    const w = capturedWindows.get(target);
    if (!w || w.isDestroyed()) throw new Error(`捕捉したウィンドウがありません: ${target}`);
    return w;
  }
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

  /**
   * ページ内でクリックし、**その操作の結果として開いたウィンドウ**を掴む。
   *
   * URL は一切組み立てない。パーティションも上書きしない。
   * 返す id を evaluate の target に渡すと、そのウィンドウを操作できる。
   *
   * **必ずクリックの前に構える。** 押してから待つと取りこぼす。
   * CDP 版が「クリック前に存在していたタブ」を除外していた対策
   * （前の商品のタブを即座に掴んで別商品を触る事故）は、ここでは不要になる。
   * did-create-window は**新しく生まれた窓でしか発火しない**ので、構造的に起きない。
   */
  async click_and_capture({ script, target = 'furimora', timeoutMs = 30000 }) {
    if (typeof script !== 'string' || !script.trim()) throw new Error('script（文字列）が必要です');
    if (captureArmed) throw new Error('既に捕捉待ちです。前の捕捉が終わっていません');
    const win = requireWindow(target);

    let settle;
    const waited = new Promise((resolve, reject) => {
      settle = { resolve, reject };
      captureArmed = settle;
      setTimeout(() => {
        if (captureArmed === settle) {
          captureArmed = null;
          reject(new Error(`クリックしましたが新しいウィンドウが開きませんでした（${timeoutMs}ms）`));
        }
      }, timeoutMs);
    });

    let clicked;
    try {
      clicked = await win.webContents.executeJavaScript(script, true);
    } catch (e) {
      if (captureArmed === settle) captureArmed = null;
      throw e;
    }
    const captured = await waited;
    return { ...captured, clicked };
  },

  /** 捕捉したウィンドウを閉じる。1 商品ごとに必ず閉じて次へ進む */
  async close_captured({ id }) {
    const w = capturedWindows.get(id);
    if (w && !w.isDestroyed()) w.destroy();
    capturedWindows.delete(id);
    return { closed: true };
  },

  async list_captured() {
    return {
      ids: [...capturedWindows.entries()]
        .filter(([, w]) => w && !w.isDestroyed())
        .map(([id, w]) => ({ id, url: w.webContents.getURL() })),
    };
  },

  /** ログインなど人間の操作が要るときだけウィンドウを出す */
  async show_window({ target = 'mercari', show = true }) {
    // 隠すだけならウィンドウを作らない（後始末で毎回作られてしまう）
    if (!show) {
      const w = target === 'mercari' ? mercariWindow : mainWindow;
      if (!w || w.isDestroyed()) return { shown: false, noWindow: true };
      w.hide();
      return { shown: false };
    }
    const win = requireWindow(target, { create: target === 'mercari' });
    win.show(); win.focus();
    return { shown: true };
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

/**
 * macOS のアプリメニュー。
 *
 * **既定のメニューを消してはいけない。** 編集メニューの役割（コピー・ペースト・
 * すべてを選択）が無いと、メルカリやフリモーラのログイン画面で貼り付けができなくなる。
 * role を使えば OS 標準の挙動がそのまま入る。
 */
function buildAppMenu() {
  if (process.platform !== 'darwin') return;
  app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `${APP_NAME}について` },
        { type: 'separator' },
        { role: 'hide', label: `${APP_NAME}を隠す` },
        { role: 'hideOthers', label: 'ほかを隠す' },
        { role: 'unhide', label: 'すべてを表示' },
        { type: 'separator' },
        { role: 'quit', label: `${APP_NAME}を終了` },
      ],
    },
    {
      label: '編集',
      submenu: [
        { role: 'undo', label: '取り消す' },
        { role: 'redo', label: 'やり直す' },
        { type: 'separator' },
        { role: 'cut', label: 'カット' },
        { role: 'copy', label: 'コピー' },
        { role: 'paste', label: 'ペースト' },
        { role: 'selectAll', label: 'すべてを選択' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { role: 'reload', label: '再読み込み' },
        { role: 'toggleDevTools', label: '開発者ツール' },
        { type: 'separator' },
        { role: 'resetZoom', label: '実際のサイズ' },
        { role: 'zoomIn', label: '拡大' },
        { role: 'zoomOut', label: '縮小' },
      ],
    },
    { role: 'windowMenu', label: 'ウィンドウ' },
  ]));
}

app.whenReady().then(async () => {
  buildAppMenu();
  registerLoginItemOnce();
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
