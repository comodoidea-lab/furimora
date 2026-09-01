import path from 'node:path';
import { BrowserService } from './src/browser-service.mjs';
import { startTestServer } from './src/testpage.mjs';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.resolve(ROOT, '../obscura-bin/obscura');

const t = await startTestServer();
const svc = new BrowserService({ binPath: BIN, port: 9335, stealth: true, allowPrivateNetwork: true });
await svc.startBrowser();
await svc.openPage(t.url);

const val = () => svc.evaluate(() => document.getElementById('name-input').value);
const clear = () => svc.evaluate(() => { document.getElementById('name-input').value = ''; });
const tryIt = async (name, fn) => {
  await clear();
  try { await fn(); console.log(`${name}: "${await val()}"`); }
  catch (e) { console.log(`${name}: ERR ${String(e.message).split('\n')[0].slice(0,90)}`); }
};

await tryIt('fill(force)', () => svc.page.fill('#name-input', 'あA1', { force: true, timeout: 6000 }));
await tryIt('type()', () => svc.page.type('#name-input', 'あA1', { timeout: 6000 }));
await tryIt('locator.pressSequentially', () => svc.page.locator('#name-input').pressSequentially('あA1', { timeout: 6000 }));
await tryIt('click+keyboard.type', async () => { await svc.page.click('#name-input', { timeout: 6000 }); await svc.page.keyboard.type('あA1'); });
await tryIt('evaluate+input event', () => svc.evaluate(() => {
  const el = document.getElementById('name-input');
  el.focus(); el.value = 'あA1';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}));

// boundingBox が取れるか（actionability チェックの根拠）
try {
  const bb = await svc.page.locator('#name-input').boundingBox({ timeout: 4000 });
  console.log('boundingBox:', JSON.stringify(bb));
} catch (e) { console.log('boundingBox: ERR', String(e.message).split('\n')[0].slice(0,90)); }
try {
  const vis = await svc.page.locator('#name-input').isVisible();
  const en = await svc.page.locator('#name-input').isEnabled();
  const ed = await svc.page.locator('#name-input').isEditable();
  console.log(`isVisible=${vis} isEnabled=${en} isEditable=${ed}`);
} catch (e) { console.log('state: ERR', String(e.message).split('\n')[0].slice(0,90)); }

await svc.stopBrowser(); t.close();
