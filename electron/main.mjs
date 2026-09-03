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
import { app, BrowserWindow, Menu, shell, session, dialog } from 'electron';
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
/** メルカリ用ウィンドウのセッション。**フリモーラと同じにする**（理由は createMercariWindow の説明） */
const MERCARI_PARTITION = PARTITION;

/** 二重起動を許さない。書き手を 1 人に保つのがこのアプリの存在理由なので、ここは譲れない */
if (!app.requestSingleInstanceLock()) {
  console.error('[furimora-desktop] 既に起動しています。既存のウィンドウを使ってください');
  app.exit(0);
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/**
 * メルカリ専用の非表示ウィンドウ。
 * 外部 Chrome + Playwright を畳むための受け皿（~/.furimora/chrome-profile の置き換え）。
 * `show: false` で作るので、そもそも前面に出てくる概念が無い。
 *
 * **セッションはフリモーラと共有する（persist:furimora）。**
 * 当初は persist:mercari で分けていたが、値下げの経路は
 * 「在庫カードのクリックで開いたページ」を使うためフリモーラと同じセッションに
 * メルカリのログインが必要で、結果として**メルカリのログインが 2 つある状態**になっていた。
 * 片方が切れると値下げか下書きのどちらかだけが壊れる。1 つに寄せて維持対象を減らす。
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
    // **パーティションも URL も上書きしない**（別セッションへ移すと route provenance が消える）。
    // ただし **show: false で出す。** 日次で何十件も回すと 1 件ごとにウィンドウが前面へ出るため。
    // 見た目を変えているだけで、クリックの結果として開かれた窓であることは変わらない。
    // 失敗したときは capture_evidence で中身をログに残す（画面で見る代わり）。
    if (captureArmed) return { action: 'allow', overrideBrowserWindowOptions: { show: false } };
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
  return mainWindow;
}

/**
 * フリモーラのウィンドウを確実に用意する。
 *
 * **macOS ではウィンドウを閉じてもアプリは終了しない**（`window-all-closed` で quit しない）。
 * そのため「アプリは Dock にいるのに自動化だけ失敗する」という分かりにくい状態が起きうる。
 * 窓が無ければ作り直し、**読み込みが終わるまで待ってから**返す。
 * 待たないと、作った直後の空のページに対して evaluate してしまう。
 */
async function ensureMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const win = createWindow();
  if (win.webContents.isLoadingMainFrame()) {
    await new Promise((resolve) => {
      const done = () => resolve();
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', done);   // 失敗しても呼び出し側で判断させる
      setTimeout(done, 45000);
    });
  }
  return win;
}

/**
 * 対象のウィンドウを返す。フリモーラは閉じられていても作り直す。
 * @param {'furimora'|'mercari'|string} target
 */
async function resolveWindow(target = 'furimora', { create = false } = {}) {
  if (typeof target === 'string' && target.startsWith('captured:')) return requireWindow(target);
  if (target === 'mercari') return requireWindow(target, { create });
  return ensureMainWindow();
}

function createMercariWindow() {
  mercariWindow = new BrowserWindow({
    width: 1280, height: 900,
    show: false,               // 既定で非表示。ログインのときだけ show_window で出す
    title: 'メルカリ（フリモーラ）',
    webPreferences: {
      partition: MERCARI_PARTITION,
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

/* ─── Advanced（自動操作）の読み込みと有効化 ──────────────────────────────
 *
 * 標準ビルドには ops/advanced.mjs も advanced-state.mjs も **同梱しない**
 * （electron-builder の files で除外）。したがって下の import は失敗し、
 * ADVANCED_AVAILABLE は false のままになる。設定やフラグで生やす口は無い。
 *
 * Advanced ビルドに含まれていても、**インストール直後は登録しない。**
 * 成果物を取得したこと自体を上級者の資格として扱わない、という方針のため、
 * 同意画面を通して明示的に有効化されたときだけ ops テーブルへ載せる。
 */
let ADVANCED_AVAILABLE = false;
let advancedState = null;
let advancedFactory = null;
let askConsent = null;
let advancedRegistered = false;
/** メルカリのウィンドウを無操作で放置する上限。常駐を既定にしない */
const MERCARI_IDLE_MS = 10 * 60 * 1000;
let mercariIdleTimer = null;

async function loadAdvanced() {
  try {
    const [stateMod, opsMod, consentMod] = await Promise.all([
      import('./advanced-state.mjs'),
      import('./ops/advanced.mjs'),
      import('./consent.mjs'),
    ]);
    advancedState = stateMod;
    advancedFactory = opsMod.createAdvancedOps;
    askConsent = consentMod.askConsent;
    advancedState.initAdvancedState(USER_DATA_DIR);
    ADVANCED_AVAILABLE = true;
    if (advancedState.isEnabled()) registerAdvancedOps();
    console.log('[furimora-desktop] Advanced 版 / 自動操作:', advancedRegistered ? '有効' : '無効（既定）');
  } catch {
    ADVANCED_AVAILABLE = false;
    console.log('[furimora-desktop] 標準版 / 自動操作は含まれていません');
  }
}

function advancedContext() {
  return {
    resolveWindow, requireWindow, capturedWindows,
    getCaptureArmed: () => captureArmed,
    setCaptureArmed: (v) => { captureArmed = v; },
    getMercariWindow: () => mercariWindow,
    setMercariWindow: (v) => { mercariWindow = v; },
    getMainWindow: () => mainWindow,
    touchMercariActivity,
    userDataDir: USER_DATA_DIR,
    homeDir: app.getPath('home'),
  };
}

function registerAdvancedOps() {
  if (!ADVANCED_AVAILABLE || advancedRegistered) return;
  Object.assign(ops, advancedFactory(advancedContext()));
  advancedRegistered = true;
}

/** 能力をテーブルから外す。「弾く」ではなく「呼べなくする」 */
function unregisterAdvancedOps() {
  if (!advancedRegistered) return;
  for (const name of ADVANCED_OP_NAMES) delete ops[name];
  Object.assign(ops, CORE_OP_SNAPSHOT);   // 上書きされた evaluate 等を戻す
  advancedRegistered = false;
}

/** 無操作が続いたらメルカリのウィンドウを畳む */
function touchMercariActivity() {
  if (mercariIdleTimer) clearTimeout(mercariIdleTimer);
  mercariIdleTimer = setTimeout(() => {
    if (mercariWindow && !mercariWindow.isDestroyed()) {
      console.log('[furimora-desktop] 無操作のためメルカリのウィンドウを閉じます');
      mercariWindow.destroy();
    }
    mercariWindow = null;
  }, MERCARI_IDLE_MS);
}

/** メルカリの資格情報を捨てる。無効化＝能力とログインの両方を失う */
async function clearMercariCredentials() {
  try {
    const ses = session.fromPartition(PARTITION);
    const cookies = await ses.cookies.get({});
    let removed = 0;
    for (const c of cookies) {
      if (!String(c.domain || '').includes('mercari')) continue;
      const url = `http${c.secure ? 's' : ''}://${String(c.domain).replace(/^\./, '')}${c.path || '/'}`;
      try { await ses.cookies.remove(url, c.name); removed += 1; } catch { /* 個別の失敗は無視 */ }
    }
    await ses.clearStorageData({ origin: 'https://jp.mercari.com' });
    return { cookiesRemoved: removed };
  } catch (e) {
    return { cookiesRemoved: 0, error: String((e && e.message) || e) };
  }
}

/** 有効化。同意画面を必ず通す */
async function enableAdvanced() {
  if (!ADVANCED_AVAILABLE) throw new Error('この版には自動操作が含まれていません');
  const res = await askConsent(mainWindow);
  if (!res.accepted) return { enabled: false, reason: res.reason || 'declined' };
  advancedState.enable();
  registerAdvancedOps();
  advancedState.audit(USER_DATA_DIR, { op: 'advanced_enable', consentHash: advancedState.CONSENT_HASH });
  return { enabled: true };
}

/** 無効化。能力を外し、ウィンドウを畳み、資格情報を捨てる */
async function disableAdvanced() {
  if (!ADVANCED_AVAILABLE) throw new Error('この版には自動操作が含まれていません');
  unregisterAdvancedOps();
  if (mercariIdleTimer) { clearTimeout(mercariIdleTimer); mercariIdleTimer = null; }
  if (mercariWindow && !mercariWindow.isDestroyed()) mercariWindow.destroy();
  mercariWindow = null;
  for (const [id, w] of capturedWindows) { if (w && !w.isDestroyed()) w.destroy(); capturedWindows.delete(id); }
  const cleared = await clearMercariCredentials();
  advancedState.disable();
  advancedState.audit(USER_DATA_DIR, { op: 'advanced_disable', ...cleared });
  try { app.setLoginItemSettings({ openAtLogin: false }); } catch { /* 環境による */ }
  return { enabled: false, ...cleared };
}

/**
 * 標準版が触れてよい対象かを確かめる。
 *
 * **「弾く」ためではなく「標準版には無い」ことを明示するための境界。**
 * Advanced が有効なときは ops/advanced.mjs の実装がこれらを上書きするので、
 * ここに来るのは標準版か、Advanced が無効な Advanced 版だけ。
 */
function assertFurimoraTarget(target, opName) {
  if (target === 'furimora') return;
  const hint = ADVANCED_AVAILABLE
    ? '「自動操作を有効にする」を実行してください'
    : 'この版には自動操作は含まれていません（Advanced 版が必要です）';
  throw new Error(`${opName} が扱えるのは furimora のウィンドウだけです（target=${target}）。${hint}`);
}

/** フリモーラ自身のオリジンか。外部サイトを開く口を標準版に残さない */
function assertFurimoraOrigin(url) {
  let origin;
  try { origin = new URL(url).origin; } catch { throw new Error(`URL を解釈できません: ${url}`); }
  if (origin !== new URL(APP_URL).origin) {
    throw new Error(`標準版が開けるのは ${new URL(APP_URL).origin} だけです（指定: ${origin}）`);
  }
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
    assertFurimoraTarget(target, 'read_storage');
    const win = await resolveWindow(target);
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
    // 標準版が触れるのはフリモーラ自身の画面だけ。メルカリと捕捉ウィンドウは
    // Advanced の op（ops/advanced.mjs）が有効なときにこの実装を上書きする。
    assertFurimoraTarget(target, 'evaluate');
    const win = await resolveWindow(target);
    return win.webContents.executeJavaScript(script, userGesture);
  },

  /**
   * ページを開く。
   * SPA のリダイレクトで loadURL が ERR_ABORTED を投げることがあるが、
   * URL が変わっていれば遷移自体は成功しているので握りつぶす（Playwright も同様に扱う）。
   */
  async open_page({ url, target = 'furimora', timeoutMs = 45000 }) {
    if (!url) throw new Error('url が必要です');
    assertFurimoraTarget(target, 'open_page');
    assertFurimoraOrigin(url);
    const win = await resolveWindow(target);
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
    assertFurimoraTarget(target, 'current_url');
    return { url: (await resolveWindow(target)).webContents.getURL() };
  },

  /** ログイン状態。UID もメールアドレスも中身は返さない */
  async auth_state() {
    const win = await resolveWindow('furimora');
    return win.webContents.executeJavaScript(`(() => {
      try {
        const u = (typeof furimoraCurrentUser === 'function') ? furimoraCurrentUser() : null;
        if (!u) return { loggedIn: false };
        return { loggedIn: true, provider: (u.providerData && u.providerData[0] && u.providerData[0].providerId) || null };
      } catch (e) { return { loggedIn: false, error: String((e && e.message) || e) }; }
    })()`);
  },

  /**
   * 自動操作の状態。標準版は available:false を返す（存在しない）。
   * Advanced 版でも既定は enabled:false。
   */
  async advanced_status() {
    if (!ADVANCED_AVAILABLE) return { available: false, enabled: false, state: 'not_in_build' };
    return { ...advancedState.status(), opsRegistered: advancedRegistered };
  },

  /**
   * 自動操作を無効にする。**能力とメルカリの資格情報を同時に捨てる。**
   * 有効化は同意画面を通す必要があるので、ここからはできない（無効化のみ）。
   */
  async advanced_disable() {
    if (!ADVANCED_AVAILABLE) return { available: false, enabled: false, state: 'not_in_build' };
    const r = await disableAdvanced();
    return { ...r, opsRegistered: advancedRegistered };
  },
};

/** Advanced が上書きしうるコア op を控えておく（無効化時に戻すため） */
const CORE_OP_SNAPSHOT = Object.freeze({
  evaluate: ops.evaluate,
  open_page: ops.open_page,
  current_url: ops.current_url,
});
/** Advanced でしか存在しない op。無効化時に削除する */
const ADVANCED_OP_NAMES = Object.freeze([
  'set_input_files', 'click_and_capture', 'capture_evidence',
  'close_captured', 'list_captured', 'show_window', 'close_window',
]);

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
    // Advanced 版のときだけメニューに出す。標準版にはこの項目自体が無い
    ...(ADVANCED_AVAILABLE ? [{
      label: '詳細',
      submenu: [
        {
          label: advancedRegistered ? '自動操作を無効にする' : '自動操作を有効にする…',
          click: async () => {
            try {
              if (advancedRegistered) {
                const r = await disableAdvanced();
                dialog.showMessageBox({
                  type: 'info', message: '自動操作を無効にしました',
                  detail: `メルカリのログイン情報も破棄しました（Cookie ${r.cookiesRemoved} 件）。`,
                });
              } else {
                const r = await enableAdvanced();
                if (r.enabled) {
                  dialog.showMessageBox({
                    type: 'info', message: '自動操作を有効にしました',
                    detail: 'メニューの「詳細」からいつでも無効にできます。無効にすると能力とメルカリのログイン情報を破棄します。',
                  });
                }
              }
            } catch (e) {
              dialog.showErrorBox('自動操作の設定', String((e && e.message) || e));
            }
            buildAppMenu();   // ラベルを現在の状態に合わせ直す
          },
        },
        {
          label: 'ログイン時に起動する',
          type: 'checkbox',
          enabled: advancedRegistered,
          checked: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch { return false; } })(),
          click: (item) => {
            try { app.setLoginItemSettings({ openAtLogin: item.checked }); } catch { /* 環境による */ }
          },
        },
      ],
    }] : []),
  ]));
}

app.whenReady().then(async () => {
  await loadAdvanced();
  buildAppMenu();
  // ログイン時の自動起動は既定で登録しない。
  // 常駐する必要があるのは Advanced の定時ルーティンだけで、標準利用者には理由がない。
  // 有効化した利用者が自分で「ログイン時に起動」を選ぶ形にする。
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
