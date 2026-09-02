/**
 * MCP から Electron を叩くための制御チャネル。
 *
 * **Unix ドメインソケットのみ。ネットワークを一切 listen しない。**
 * mcp/server.mjs が stdio しか使わないのと同じ方針（HTTP ポートを開くより攻撃面が狭い）。
 *
 * プロトコル: 改行区切り JSON
 *   要求 { id, op, args }
 *   応答 { id, ok: true, result } / { id, ok: false, error: { code, message } }
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOCKET_PATH = path.join(os.homedir(), '.furimora', 'app.sock');

/**
 * 死んだソケットファイルが残っていたら消す。
 * 生きている相手がいれば false を返す（＝二重起動なので listen してはいけない）。
 */
async function clearStaleSocket() {
  if (!fs.existsSync(SOCKET_PATH)) return true;
  const alive = await new Promise((resolve) => {
    const probe = net.connect(SOCKET_PATH);
    const done = (v) => { probe.destroy(); resolve(v); };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    setTimeout(() => done(false), 500);
  });
  if (alive) return false;
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* 競合。次で落ちる */ }
  return true;
}

/**
 * @param {Record<string, (args:any)=>Promise<any>>} ops 実行できる操作
 */
export async function startControlServer(ops) {
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
  if (!(await clearStaleSocket())) {
    throw new Error(`既に別のフリモーラ Desktop が ${SOCKET_PATH} を使っています`);
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); }
        catch { sock.write(JSON.stringify({ id: null, ok: false, error: { code: 'BAD_JSON', message: '不正な JSON' } }) + '\n'); continue; }
        const reply = (body) => { try { sock.write(JSON.stringify({ id: req.id ?? null, ...body }) + '\n'); } catch { /* 切断済み */ } };
        const fn = ops[req.op];
        if (!fn) { reply({ ok: false, error: { code: 'UNKNOWN_OP', message: `未知の操作: ${req.op}` } }); continue; }
        try { reply({ ok: true, result: await fn(req.args || {}) }); }
        catch (e) { reply({ ok: false, error: { code: 'OP_FAILED', message: String((e && e.message) || e) } }); }
      }
    });
    sock.on('error', () => { /* 相手が黙って切っただけ */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, resolve);
  });
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch { /* 環境による */ }
  return {
    close: () => new Promise((r) => server.close(() => {
      try { fs.unlinkSync(SOCKET_PATH); } catch { /* 既に無い */ }
      r();
    })),
  };
}
