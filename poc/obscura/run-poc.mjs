/**
 * Obscura 適合性 PoC
 * 検証項目: 起動 / CDP接続 / ページを開く / DOM取得 / 入力 / クリック /
 *          Cookie保存 / プロセス終了 / 再起動後の Cookie 復元 / メルカリ商品ページ取得
 * ※ アカウント操作・出品操作は一切行わない（閲覧のみ）
 */
import fs from 'node:fs';
import path from 'node:path';
import { BrowserService } from './src/browser-service.mjs';
import { startTestServer } from './src/testpage.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.resolve(ROOT, '../obscura-bin/obscura');
const STORAGE = path.resolve(ROOT, '.obscura-storage');
const ITEM_URL = process.env.POC_ITEM_URL || 'https://jp.mercari.com/item/m15031621353';

const results = [];
const ok = (name, detail) => { results.push({ name, ok: true, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); };
const ng = (name, detail) => { results.push({ name, ok: false, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); };

async function step(name, fn) {
  try { const d = await fn(); ok(name, d); return true; }
  catch (e) { ng(name, String(e && e.message || e).split('\n')[0].slice(0, 160)); return false; }
}

async function main() {
  fs.rmSync(STORAGE, { recursive: true, force: true });

  // ── フェーズ1: 基本操作 ────────────────────────────────────────────
  console.log('\n── フェーズ1: 起動・接続・基本操作 ──');
  const test = await startTestServer();
  const svc = new BrowserService({ binPath: BIN, port: 9333, storageDir: STORAGE, stealth: true, allowPrivateNetwork: true });

  await step('1. Obscura 起動', async () => `pid あり / ${svc.process.cdpUrl}`);
  await step('2. CDP (Playwright connectOverCDP) 接続', async () => {
    const { cdpUrl } = await svc.startBrowser();
    return cdpUrl;
  });
  await step('3. 任意ページを開く', async () => await svc.openPage(test.url));
  await step('4. DOM 取得 (evaluate)', async () => {
    const h = await svc.evaluate(() => document.getElementById('heading')?.textContent);
    if (h !== 'こんにちは') throw new Error(`期待値と不一致: ${h}`);
    return `h1 = "${h}"`;
  });
  await step('4b. getPageHtml()', async () => {
    const html = await svc.getPageHtml();
    if (!html.includes('name-input')) throw new Error('HTML に想定要素なし');
    return `${html.length} bytes`;
  });
  await step('5. テキスト入力 (fill)', async () => {
    await svc.fill('#name-input', 'フリモーラ');
    const v = await svc.evaluate(() => document.getElementById('name-input').value);
    if (v !== 'フリモーラ') throw new Error(`入力値不一致: ${v}`);
    return `value = "${v}"`;
  });
  await step('6. クリック (click)', async () => {
    await svc.click('#submit-btn');
    const r = await svc.evaluate(() => document.getElementById('result').textContent);
    if (!r.includes('フリモーラ')) throw new Error(`クリック結果不一致: ${r}`);
    return r;
  });
  await step('6b. waitForSelector (非同期DOM追加)', async () => {
    const el = await svc.waitForSelector('#async-result', { timeout: 5000 });
    return await el.textContent();
  });

  // ── フェーズ2: Cookie / セッション永続 ──────────────────────────────
  console.log('\n── フェーズ2: Cookie とセッション永続 ──');
  let before = [];
  await step('7. メルカリを開いて Cookie 取得', async () => {
    await svc.openPage('https://jp.mercari.com/', { waitUntil: 'load' });
    before = await svc.getCookies();
    if (!before.length) throw new Error('Cookie が 0 件');
    return `${before.length} 件 / ${[...new Set(before.map(c => c.domain))].join(', ')}`;
  });
  await step('7b. setCookies() で任意 Cookie を投入', async () => {
    await svc.setCookies([{ name: 'furimora_poc', value: 'poc-value', domain: '.mercari.com', path: '/' }]);
    const after = await svc.getCookies();
    if (!after.some(c => c.name === 'furimora_poc')) throw new Error('投入した Cookie が見つからない');
    return 'furimora_poc を確認';
  });
  await step('8. プロセス終了 (SIGTERM) と storage-dir 書き出し', async () => {
    await svc.saveSession();
    const cookieFile = path.join(STORAGE, 'cookies.json');
    if (!fs.existsSync(cookieFile)) throw new Error(`${cookieFile} が生成されていない`);
    const n = JSON.parse(fs.readFileSync(cookieFile, 'utf8')).length;
    return `cookies.json = ${n} 件 / 残プロセス: ${svc.process.proc ? 'あり' : 'なし'}`;
  });

  const svc2 = new BrowserService({ binPath: BIN, port: 9334, storageDir: STORAGE, stealth: true, allowPrivateNetwork: true });
  await step('9. 再起動後に Cookie 復元', async () => {
    await svc2.restoreSession();
    await svc2.openPage('https://jp.mercari.com/', { waitUntil: 'load' });
    const restored = await svc2.getCookies();
    const found = restored.find(c => c.name === 'furimora_poc');
    if (!found) throw new Error(`復元されず（${restored.length} 件中に furimora_poc なし）`);
    return `${restored.length} 件復元 / furimora_poc の値長 ${String(found.value).length}`;
  });

  // ── フェーズ3: メルカリ商品ページ ────────────────────────────────
  console.log('\n── フェーズ3: メルカリ商品ページの取得（閲覧のみ）──');
  let probe = null;
  await step('10. 商品ページを開く', async () => await svc2.openPage(ITEM_URL, { waitUntil: 'load' }));
  await step('10b. 描画状態を測定', async () => {
    await new Promise(r => setTimeout(r, 12000));
    probe = await svc2.evaluate(() => {
      const meta = (k) => document.querySelector(`meta[property="${k}"]`)?.content
        || document.querySelector(`meta[name="${k}"]`)?.content || null;
      return {
        title: document.title,
        hasNextData: !!document.getElementById('__NEXT_DATA__'),
        nextF: (self.__next_f || []).length,
        mainTextLen: (document.getElementById('main')?.innerText || '').length,
        h1: document.querySelector('h1')?.textContent || null,
        priceTestid: document.querySelector('[data-testid="price"]')?.textContent || null,
        descTestid: document.querySelector('[data-testid="description"]')?.textContent || null,
        testids: [...document.querySelectorAll('[data-testid]')].map(e => e.dataset.testid).slice(0, 20),
        ogTitle: meta('og:title'), ogImage: meta('og:image'), ogUrl: meta('og:url'),
        imgCount: document.querySelectorAll('img').length,
      };
    });
    return `main本文 ${probe.mainTextLen} 文字 / h1=${probe.h1 ?? 'なし'} / __NEXT_DATA__=${probe.hasNextData}`;
  });
  await step('11. クローンに必要な項目が DOM から取れるか', async () => {
    const missing = [];
    if (!probe?.h1) missing.push('タイトル(h1)');
    if (!probe?.priceTestid) missing.push('価格');
    if (!probe?.descTestid) missing.push('説明文');
    if (!probe || probe.mainTextLen === 0) missing.push('本文全体');
    if (missing.length) throw new Error(`取得できない項目: ${missing.join(', ')}`);
    return '全項目取得';
  });

  // ── フェーズ4: Obscura で取れる分 vs 既存 /api/mercari の突き合わせ ──
  console.log('\n── フェーズ4: 既存 /api/mercari との比較 ──');
  const FIELDS = ['title', 'currentPrice', 'description', 'category', 'condition',
                  'shippingPayer', 'shippingMethod', 'shippingFrom', 'shippingDays', 'images'];
  let obscuraRec = null, apiRec = null;
  await step('12. Obscura ページから抽出できる範囲', async () => {
    obscuraRec = await svc2.evaluate(() => {
      const meta = (k) => document.querySelector(`meta[property="${k}"]`)?.content
        || document.querySelector(`meta[name="${k}"]`)?.content || null;
      const og = meta('og:title') || '';
      return {
        itemId: (location.pathname.match(/\/item\/(m\w+)/) || [])[1] || null,
        title: og.replace(/\s*by メルカリ$/, '') || null,
        currentPrice: null,
        description: null,
        category: null, condition: null,
        shippingPayer: null, shippingMethod: null, shippingFrom: null, shippingDays: null,
        images: meta('og:image') ? [meta('og:image').split('?')[0]] : [],
      };
    });
    const got = FIELDS.filter((f) => {
      const v = obscuraRec[f];
      return Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '';
    });
    return `${got.length}/${FIELDS.length} 項目: ${got.join(', ')}`;
  });
  await step('13. 既存 /api/mercari のベースライン', async () => {
    const res = await fetch(`https://furimora.vercel.app/api/mercari?url=${encodeURIComponent(ITEM_URL)}`);
    apiRec = await res.json();
    if (apiRec.error) throw new Error(apiRec.error);
    const got = FIELDS.filter((f) => {
      const v = apiRec[f];
      return Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '';
    });
    return `${got.length}/${FIELDS.length} 項目 (source=${apiRec.source}, 画像${apiRec.images?.length ?? 0}枚)`;
  });
  await step('14. Obscura 単体でクローン用データが揃うか', async () => {
    const lacking = FIELDS.filter((f) => {
      const v = obscuraRec?.[f];
      return Array.isArray(v) ? v.length === 0 : v == null || String(v).trim() === '';
    });
    if (lacking.length) throw new Error(`不足: ${lacking.join(', ')}`);
    return '揃う';
  });

  await svc2.stopBrowser();
  test.close();

  console.log('\n── 結果 ──');
  const pass = results.filter(r => r.ok).length;
  console.log(`${pass}/${results.length} 成功`);
  fs.writeFileSync(path.join(ROOT, 'poc-result.json'), JSON.stringify({ results, probe }, null, 2));
  console.log(`詳細: ${path.join(ROOT, 'poc-result.json')}`);
}

main().catch((e) => { console.error('PoC 異常終了:', e); process.exit(1); });
