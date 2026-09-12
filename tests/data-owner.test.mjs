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
  // 出自不明・アカウント切替では商品も下書きもクラウドで完全置換する
  assert.match(body, /furimoraPullItemsFromCloud\(user\.uid, unownedLocal\)/);
  assert.match(body, /furimoraPullDraftsFromCloud\(user\.uid, unownedLocal\)/);
  assert.match(body, /unownedLocal \|\| ownerMismatch\)/);
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

test('iOS はリダイレクトでログインし、戻りを回収する', () => {
  assert.match(page, /getRedirectResult\(\)/, 'リダイレクトの戻りを拾っていない');
  // 初期化の中で、認証状態の監視より前に回収する
  const init = page.slice(page.indexOf('async function furimoraInitFirebase'));
  const body = init.slice(0, init.indexOf('\nasync function ', 1));
  const redirect = body.indexOf('getRedirectResult()');
  const observer = body.indexOf('onAuthStateChanged');
  assert.ok(redirect !== -1 && redirect < observer, '回収が認証監視より後になっている');
  // iOS はポップアップを試さず最初からリダイレクト
  assert.match(page, /if \(isIOSDevice\(\)\) \{\s*await furimoraFirebaseAuth\.signInWithRedirect\(provider\);/);
});
