/**
 * Advanced（自動操作）の有効化状態と同意記録。
 *
 * このファイルは **Advanced ビルドにしか含まれない。**
 * 標準ビルドでは ops/advanced.mjs ごと存在しないため、能力は「無効」ではなく「不在」になる。
 *
 * 設計の前提:
 * - **インストール直後は必ず無効。** 成果物を取得したこと自体を上級者の資格として扱わない
 * - 有効化は利用者がアプリ内で行う明示的な操作に限る。環境変数・設定ファイル・
 *   インストーラのオプションでは有効にならない（第三者が代行できてしまうため）
 * - 状態は userData にのみ置き、**同期しない**。クラウド経由で別端末へ伝播させない
 * - 同意した文面のハッシュを残す。能力の範囲が広がったら再同意を要求する
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

/** 同意を求める文面。**変えたらハッシュが変わり、再同意が必要になる。** */
export const CONSENT_TEXT = [
  'この設定を有効にすると、フリモーラはあなたのログイン済みメルカリセッションを',
  'プログラムから操作できるようになります。具体的には次のことが可能になります。',
  '',
  '・メルカリのページを開き、ページ内で JavaScript を実行する',
  '・出品フォームへ入力し、画像ファイルを添付する',
  '・出品中の商品の価格を変更する',
  '・メルカリの下書きを作成・保存する',
  '',
  '実行しないこと（コード上で禁止しています）:',
  '・「出品する」「削除する」ボタンは押しません',
  '・1回の呼び出しで複数商品をまとめて変更しません',
  '・設定した最低価格を下回る変更はしません',
  '',
  'メルカリの利用規約は、自動化された操作を名指しで禁止も許可もしていません。',
  '許容されるかどうかはメルカリの判断によります。アカウントの利用制限を含む',
  '結果は、この設定を有効にしたあなたの責任になります。',
  '',
  'いつでも無効にできます。無効にすると能力は失われ、この端末に保存された',
  'メルカリのログイン情報も破棄されます。',
].join('\n');

/** 有効化のときに打鍵させるフレーズ。クリックだけで通らないようにする */
export const CONFIRM_PHRASE = '自動操作を有効にする';

export const CONSENT_HASH = crypto.createHash('sha256').update(CONSENT_TEXT).digest('hex').slice(0, 16);

let stateFile = null;

export function initAdvancedState(userDataDir) {
  stateFile = path.join(userDataDir, 'advanced-state.json');
}

function read() {
  if (!stateFile) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 有効か。
 * **保存された同意ハッシュが現在の文面と一致しない場合は無効として扱う**
 * （能力の範囲が広がったのに古い同意で動き続けるのを防ぐ）。
 */
export function isEnabled() {
  const s = read();
  return !!(s && s.enabled === true && s.consentHash === CONSENT_HASH);
}

/** 同意はしているが文面が変わって再同意待ちか */
export function needsReconsent() {
  const s = read();
  return !!(s && s.enabled === true && s.consentHash !== CONSENT_HASH);
}

export function status() {
  const s = read();
  if (!s) return { available: true, enabled: false, state: 'never_enabled' };
  if (s.enabled !== true) return { available: true, enabled: false, state: 'disabled', disabledAt: s.disabledAt || null };
  if (s.consentHash !== CONSENT_HASH) return { available: true, enabled: false, state: 'needs_reconsent', enabledAt: s.enabledAt || null };
  return { available: true, enabled: true, state: 'enabled', enabledAt: s.enabledAt || null, consentHash: s.consentHash };
}

/** 有効化。呼び出し側が同意フローを通していることが前提 */
export function enable() {
  if (!stateFile) throw new Error('advanced-state が初期化されていません');
  const payload = {
    enabled: true,
    enabledAt: new Date().toISOString(),
    consentHash: CONSENT_HASH,
    consentPhrase: CONFIRM_PHRASE,
  };
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
  return payload;
}

export function disable() {
  if (!stateFile) throw new Error('advanced-state が初期化されていません');
  const prev = read() || {};
  const payload = {
    enabled: false,
    disabledAt: new Date().toISOString(),
    previouslyEnabledAt: prev.enabledAt || null,
  };
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
  return payload;
}

/**
 * 書き込みを伴う操作の監査ログ。追記のみ。
 * 何をしたかを後から確認できるようにする（消せる形にはしない）。
 */
export function audit(userDataDir, entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(userDataDir, 'advanced-audit.log'), line);
  } catch {
    /* 監査に失敗しても操作自体は止めない */
  }
}
