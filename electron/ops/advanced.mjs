/**
 * 自動操作（Advanced）の op 群。
 *
 * **このファイルは標準ビルドの成果物に含まれない。**
 * electron-builder の files から ops/ を外してあるので、標準版では
 * main.mjs の動的 import が失敗し、能力は「無効」ではなく「存在しない」状態になる。
 * 標準版を配布したまま設定やフラグで自動操作を生やすことはできない。
 *
 * Advanced ビルドに含まれていても、既定では登録されない。
 * advanced-state が有効を返したときだけ ops テーブルへ載る（main.mjs 側で制御）。
 *
 * ウィンドウの実体は main.mjs が持っているので、ここでは ctx 経由で借りる。
 * メルカリ側のセレクタ知識は依然として mcp/src/mercari-service.mjs にあり、
 * ここにあるのは「どう触るか」ではなく「触れる口」だけ。
 */
import path from 'node:path';
import fs from 'node:fs';
import { audit } from '../advanced-state.mjs';

/**
 * @param {object} ctx main.mjs から渡す実体
 * @param {Function} ctx.resolveWindow
 * @param {Function} ctx.requireWindow
 * @param {Map} ctx.capturedWindows
 * @param {Function} ctx.getCaptureArmed
 * @param {Function} ctx.setCaptureArmed
 * @param {Function} ctx.getMercariWindow
 * @param {Function} ctx.setMercariWindow
 * @param {Function} ctx.getMainWindow
 * @param {Function} ctx.touchMercariActivity  無操作タイマーを延長する
 * @param {string}   ctx.userDataDir
 * @param {string}   ctx.homeDir
 */
export function createAdvancedOps(ctx) {
  const {
    resolveWindow, requireWindow, capturedWindows,
    getCaptureArmed, setCaptureArmed,
    getMercariWindow, setMercariWindow, getMainWindow,
    touchMercariActivity, userDataDir, homeDir,
  } = ctx;

  return {
    /**
     * ページの主世界で JS を評価する。
     * 標準版の evaluate は furimora のウィンドウしか触れない。
     * メルカリと捕捉ウィンドウを対象にできるのはこちらだけ。
     */
    async evaluate({ script, userGesture = true, target = 'furimora' }) {
      if (typeof script !== 'string' || !script.trim()) throw new Error('script（文字列）が必要です');
      const win = await resolveWindow(target, { create: target === 'mercari' });
      if (target !== 'furimora') touchMercariActivity();
      return win.webContents.executeJavaScript(script, userGesture);
    },

    /** ページを開く。外部オリジンを開けるのは Advanced だけ */
    async open_page({ url, target = 'furimora', timeoutMs = 45000 }) {
      if (!url) throw new Error('url が必要です');
      const win = await resolveWindow(target, { create: target === 'mercari' });
      if (target !== 'furimora') touchMercariActivity();
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
      audit(userDataDir, { op: 'open_page', target, url: wc.getURL() });
      return { url: wc.getURL() };
    },

    async current_url({ target = 'furimora' }) {
      return { url: (await resolveWindow(target)).webContents.getURL() };
    },

    /**
     * input[type=file] にファイルを渡す。
     * DOM API では偽装できないので CDP の DOM.setFileInputFiles を使う。
     * **外部ブラウザではなく自分のプロセス内の CDP** なので、外部 Chrome の管理は増えない。
     */
    async set_input_files({ selector, files, target = 'mercari' }) {
      if (!selector) throw new Error('selector が必要です');
      if (!Array.isArray(files) || !files.length) throw new Error('files（配列）が必要です');
      const wc = (await resolveWindow(target, { create: target === 'mercari' })).webContents;
      touchMercariActivity();
      const attached = wc.debugger.isAttached();
      if (!attached) wc.debugger.attach('1.3');
      try {
        const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
        const { nodeId } = await wc.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`要素が見つかりません: ${selector}`);
        await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files });
        audit(userDataDir, { op: 'set_input_files', selector, count: files.length });
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
     */
    async click_and_capture({ script, target = 'furimora', timeoutMs = 30000 }) {
      if (typeof script !== 'string' || !script.trim()) throw new Error('script（文字列）が必要です');
      if (getCaptureArmed()) throw new Error('既に捕捉待ちです。前の捕捉が終わっていません');
      const win = await resolveWindow(target);
      touchMercariActivity();

      let settle;
      const waited = new Promise((resolve, reject) => {
        settle = { resolve, reject };
        setCaptureArmed(settle);
        setTimeout(() => {
          if (getCaptureArmed() === settle) {
            setCaptureArmed(null);
            reject(new Error(`クリックしましたが新しいウィンドウが開きませんでした（${timeoutMs}ms）`));
          }
        }, timeoutMs);
      });

      let clicked;
      try {
        clicked = await win.webContents.executeJavaScript(script, true);
      } catch (e) {
        if (getCaptureArmed() === settle) setCaptureArmed(null);
        throw e;
      }
      const captured = await waited;
      return { ...captured, clicked };
    },

    /** 捕捉したウィンドウの中身を証拠として残す。**読み取りのみ。** */
    async capture_evidence({ id, dir }) {
      const win = requireWindow(id);
      const info = await win.webContents.executeJavaScript(`(() => ({
        url: location.href,
        title: document.title,
        h1: (document.querySelector('h1')?.innerText || '').trim().slice(0, 120),
        bodyHead: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
      }))()`);
      const outDir = dir || path.join(homeDir, '.furimora', 'evidence');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(outDir, `${stamp}-${String(id).replace(/[^\w-]/g, '_')}.png`);
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(file, img.toPNG());
        return { ...info, screenshot: file };
      } catch (e) {
        return { ...info, screenshot: null, screenshotError: String((e && e.message) || e) };
      }
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
      if (!show) {
        const w = target === 'mercari' ? getMercariWindow() : getMainWindow();
        if (!w || w.isDestroyed()) return { shown: false, noWindow: true };
        w.hide();
        return { shown: false };
      }
      const win = await resolveWindow(target, { create: target === 'mercari' });
      if (target !== 'furimora') touchMercariActivity();
      win.show(); win.focus();
      return { shown: true };
    },

    async close_window({ target }) {
      if (target !== 'mercari') throw new Error('閉じられるのは mercari のウィンドウだけです');
      const w = getMercariWindow();
      if (w && !w.isDestroyed()) w.destroy();
      setMercariWindow(null);
      return { closed: true };
    },
  };
}
