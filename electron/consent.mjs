/**
 * Advanced を有効にするときの同意画面。**Advanced ビルドにしか含まれない。**
 *
 * ダイアログのチェックボックスではなくフレーズの打鍵を求めるのは、
 * 「インストーラや別プロセスが代行できない利用者本人の行為」にするため。
 * 設定ファイルや環境変数で有効化できる口は作らない。
 *
 * preload は使わない（本体の方針と同じ。ページに Node を渡さない）。
 * 画面から結果を受け取るのは、メインプロセス側からの executeJavaScript の
 * ポーリングで行う。本体が localStorage を読むのと同じ経路。
 */
import { BrowserWindow } from 'electron';
import { CONSENT_TEXT, CONFIRM_PHRASE } from './advanced-state.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function buildHtml() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; margin: 0; padding: 22px 24px;
         background: Canvas; color: CanvasText; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { font-size: 11px; opacity: .6; margin: 0 0 14px; }
  pre { white-space: pre-wrap; font-family: inherit; font-size: 12px; line-height: 1.75;
        background: color-mix(in srgb, CanvasText 6%, Canvas); border-radius: 10px;
        padding: 14px 16px; margin: 0 0 16px; max-height: 260px; overflow-y: auto; }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  code { background: color-mix(in srgb, CanvasText 10%, Canvas); padding: 1px 6px; border-radius: 4px; }
  input { width: 100%; box-sizing: border-box; font-size: 14px; padding: 9px 11px; border-radius: 8px;
          border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); background: Field; color: FieldText; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  button { font-size: 13px; font-weight: 700; padding: 9px 18px; border-radius: 8px; cursor: pointer;
           border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); background: Canvas; color: CanvasText; }
  button.primary { background: #b4462e; border-color: #b4462e; color: #fff; }
  button:disabled { opacity: .35; cursor: not-allowed; }
</style></head><body>
  <h1>自動操作を有効にしますか</h1>
  <p class="sub">この設定は既定で無効です。有効にできるのはこの画面からだけです。</p>
  <pre>${esc(CONSENT_TEXT)}</pre>
  <label for="p">続けるには <code>${esc(CONFIRM_PHRASE)}</code> と入力してください</label>
  <input id="p" type="text" autocomplete="off" spellcheck="false" autofocus>
  <div class="row">
    <button id="cancel">キャンセル</button>
    <button id="ok" class="primary" disabled>有効にする</button>
  </div>
<script>
  var input = document.getElementById('p');
  var ok = document.getElementById('ok');
  var PHRASE = ${JSON.stringify(CONFIRM_PHRASE)};
  function sync() { ok.disabled = input.value.trim() !== PHRASE; }
  input.addEventListener('input', sync);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !ok.disabled) ok.click(); });
  ok.addEventListener('click', function () { window.__furimoraConsent = { accepted: true, phrase: input.value.trim() }; });
  document.getElementById('cancel').addEventListener('click', function () { window.__furimoraConsent = { accepted: false }; });
  sync();
</script></body></html>`;
}

/**
 * 同意画面を開き、結果を返す。
 * 閉じられた場合は拒否として扱う（既定は常に「有効にしない」側）。
 * @returns {Promise<{accepted: boolean, reason?: string}>}
 */
export async function askConsent(parent) {
  const win = new BrowserWindow({
    width: 620,
    height: 680,
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    modal: !!(parent && !parent.isDestroyed()),
    title: '自動操作の有効化',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildHtml()));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    win.on('closed', () => finish({ accepted: false, reason: 'closed' }));
    const timer = setInterval(async () => {
      if (win.isDestroyed()) return finish({ accepted: false, reason: 'closed' });
      try {
        const r = await win.webContents.executeJavaScript('window.__furimoraConsent || null');
        if (!r) return;
        // フレーズはメインプロセス側でも照合する。画面側の判定だけを信用しない
        if (r.accepted && r.phrase === CONFIRM_PHRASE) return finish({ accepted: true });
        finish({ accepted: false, reason: r.accepted ? 'phrase_mismatch' : 'declined' });
      } catch {
        /* 読み込み中などは次の周回で拾う */
      }
    }, 200);
  });
}
