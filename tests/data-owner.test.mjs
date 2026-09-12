import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const fn = (name) => {
  const start = page.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が無い`);
  return page.slice(start, page.indexOf('\n}', start));
};

test('手元のデータに持ち主を記録している', () => {
  assert.match(page, /const FURIMORA_DATA_OWNER_KEY = 'furimora_data_owner_uid'/);
  assert.match(fn('furimoraGetDataOwner'), /getItem\(FURIMORA_DATA_OWNER_KEY\)/);
  assert.match(fn('furimoraSetDataOwner'), /setItem\(FURIMORA_DATA_OWNER_KEY/);
});

test('ログイン直後、クラウドへ触る前に持ち主を確認する', () => {
  const body = fn('furimoraSyncAfterLogin');
  const ownerCheck = body.indexOf('furimoraGetDataOwner()');
  const firstCloudRead = body.indexOf('furimoraFirestoreStateRef');
  assert.notEqual(ownerCheck, -1, '持ち主を確認していない');
  assert.ok(ownerCheck < firstCloudRead, '持ち主の確認がクラウド読み取りより後になっている');
});

test('別アカウントなら混ぜずに捨てる', () => {
  const body = fn('furimoraSyncAfterLogin');
  assert.match(body, /owner && owner !== user\.uid/);
  assert.match(body, /furimoraDiscardLocalDataForAccountSwitch\(\)/);
});

test('出自不明のデータは相手のクラウドへ push しない', () => {
  const body = fn('furimoraSyncAfterLogin');
  // クラウドが空のときの push は「持ち主が確かなとき」に限る
  assert.match(body, /if \(hasLocal && !unownedLocal\)/);
});

test('出自不明でもクラウドで強制置換しない（この版を入れた直後は全端末がこれに当たる）', () => {
  const body = fn('furimoraSyncAfterLogin');
  // 強制置換するとアップグレード直後に未送信の変更が消える。
  // 商品も下書きも 1 件ずつ時刻で突き合わせるので、通常の合流で正しく解決する
  assert.match(body, /furimoraApplyCloudSnapshot\(user\.uid, data, remoteUpdatedAt, true, ownerMismatch\)/,
    '強制置換の条件に unownedLocal が混ざっている');
  assert.doesNotMatch(body, /furimoraPullItemsFromCloud\(user\.uid, unownedLocal\)/,
    '出自不明で商品を強制置換している');
  assert.doesNotMatch(body, /furimoraPullDraftsFromCloud\(user\.uid, unownedLocal\)/,
    '出自不明で下書きを強制置換している');
});

test('強制置換はアカウント切替のときだけ（直前に手元を捨てている）', () => {
  const body = fn('furimoraSyncAfterLogin');
  const discard = body.indexOf('furimoraDiscardLocalDataForAccountSwitch()');
  const apply = body.indexOf('furimoraApplyCloudSnapshot(');
  assert.ok(discard !== -1 && discard < apply, '捨てる前に置換している');
});

test('切り替え時の掃除はオンボーディング以外の furimora_ を消す', () => {
  const body = fn('furimoraDiscardLocalDataForAccountSwitch');
  assert.match(body, /startsWith\('furimora_'\)/);
  assert.match(body, /!== FURIMORA_ONBOARDING_DONE_KEY/);
  assert.match(body, /removeItem\(key\)/);
});

test('実データの有無は商品と下書きで判定する（設定だけの端末は空扱い）', () => {
  const body = fn('furimoraHasLocalUserData');
  assert.match(body, /furimora_items/);
  assert.match(body, /furimora_drafts/);
});

test('ログアウトは持ち主の記録も消す', () => {
  // ログアウトは furimora_ で始まるキーを一括削除している
  assert.match(page, /k\.startsWith\('furimora_'\) \|\| k\.startsWith\('sb-'\)/);
  assert.match(page, /const FURIMORA_DATA_OWNER_KEY = 'furimora_data_owner_uid'/,
    '持ち主キーは furimora_ 始まりでなければ一括削除から漏れる');
});

test('リダイレクトの戻りを、認証状態の監視より前に回収する', () => {
  assert.match(page, /getRedirectResult\(\)/, 'リダイレクトの戻りを拾っていない');
  const init = page.slice(page.indexOf('async function furimoraInitFirebase'));
  const body = init.slice(0, init.indexOf('\nasync function ', 1));
  const redirect = body.indexOf('getRedirectResult()');
  const observer = body.indexOf('onAuthStateChanged');
  assert.ok(redirect !== -1 && redirect < observer, '回収が認証監視より後になっている');
});

test('ログインはポップアップを先に試す（動作中の PWA の経路を変えない）', () => {
  // 実機の PWA はログインできている。iOS だけ無条件にリダイレクトへ倒すと、
  // 認証画面が Safari で開いて PWA に戻らないことがある
  assert.doesNotMatch(page, /if \(isIOSDevice\(\)\) \{\s*await furimoraFirebaseAuth\.signInWithRedirect\(provider\);/,
    'iOS を無条件にリダイレクトへ倒している');
  const popup = page.indexOf('signInWithPopup(provider)');
  const redirectFallback = page.indexOf('signInWithRedirect(provider)', popup);
  assert.ok(popup !== -1 && redirectFallback > popup, 'ポップアップを先に試していない');
  assert.match(page, /auth\/cancelled-popup-request/, '塞がれた場合の取りこぼしが残っている');
});
