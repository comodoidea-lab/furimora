#!/usr/bin/env node
/**
 * Vercel なしで localhost プレビュー（public + api の Edge ハンドラを Node で実行）
 * 使い方: npm run preview → http://127.0.0.1:3000
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.resolve(root, 'public');
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';

async function loadDotEnv() {
  try {
    const raw = await fs.readFile(path.join(root, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const key = s.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let val = s.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* .env なし */
  }
}
await loadDotEnv();

/** api/<name>.js の default export をキャッシュして再利用 */
const apiHandlerCache = new Map();

async function loadApiHandler(name) {
  if (apiHandlerCache.has(name)) return apiHandlerCache.get(name);
  if (!/^[a-z0-9_-]+$/i.test(name)) return null;
  try {
    const mod = await import(path.join(root, 'api', `${name}.js`));
    const h = mod.default;
    if (typeof h !== 'function') return null;
    apiHandlerCache.set(name, h);
    return h;
  } catch (e) {
    console.error('[preview] api load failed:', name, e);
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function safePublicPath(urlPathname) {
  const rel = urlPathname.replace(/^\/+/, '');
  if (rel.includes('\0')) return null;
  const resolved = path.resolve(publicDir, rel);
  if (!resolved.startsWith(publicDir + path.sep) && resolved !== publicDir) return null;
  return resolved;
}

async function sendWebResponse(nodeRes, webRes) {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    nodeRes.setHeader(key, value);
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  nodeRes.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  const apiSeg = url.pathname.match(/^\/api\/([^/?]+)/);
  if (apiSeg) {
    const handler = await loadApiHandler(apiSeg[1]);
    if (handler) {
      try {
        const webReq = new Request(url.href, { method: req.method, headers: req.headers });
        const webRes = await handler(webReq);
        await sendWebResponse(res, webRes);
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('API not found');
    return;
  }

  let filePath =
    url.pathname === '/' ? path.join(publicDir, 'index.html') : safePublicPath(url.pathname);
  if (!filePath) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.listen(port, host, () => {
  console.log(`フリモーラ: http://${host}:${port}`);
});
