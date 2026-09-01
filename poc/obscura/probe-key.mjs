import path from 'node:path';
import { BrowserService } from './src/browser-service.mjs';
import { startTestServer } from './src/testpage.mjs';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.resolve(ROOT, '../obscura-bin/obscura');
const t = await startTestServer();
const svc = new BrowserService({ binPath: BIN, port: 9336, stealth: true, allowPrivateNetwork: true });
await svc.startBrowser();
await svc.openPage(t.url);
const val = () => svc.evaluate(() => document.getElementById('name-input').value);
const clear = () => svc.evaluate(() => { document.getElementById('name-input').value = ''; });

await svc.page.click('#name-input');
await clear();
try { await svc.page.keyboard.press('a'); console.log('keyboard.press("a") ->', JSON.stringify(await val())); }
catch (e) { console.log('keyboard.press ERR:', String(e.message).split('\n')[0].slice(0,100)); }

const cdp = await svc.context.newCDPSession(svc.page);
await clear();
try {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'X', key: 'X', code: 'KeyX' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'X', code: 'KeyX' });
  console.log('Input.dispatchKeyEvent ->', JSON.stringify(await val()));
} catch (e) { console.log('dispatchKeyEvent ERR:', String(e.message).split('\n')[0].slice(0,100)); }

// CDP で使えるドメインの粗い確認
for (const m of ['DOM.getDocument','Runtime.evaluate','Network.getAllCookies','Page.getFrameTree','Emulation.setDeviceMetricsOverride','Input.dispatchMouseEvent']) {
  const [d, f] = m.split('.');
  try { await cdp.send(m, m==='Runtime.evaluate'?{expression:'1'}: m==='Input.dispatchMouseEvent'?{type:'mouseMoved',x:1,y:1}: m==='Emulation.setDeviceMetricsOverride'?{width:800,height:600,deviceScaleFactor:1,mobile:false}:{}); console.log(`${m}: OK`); }
  catch (e) { console.log(`${m}: ${String(e.message).split('\n')[0].slice(0,70)}`); }
}
await svc.stopBrowser(); t.close();
