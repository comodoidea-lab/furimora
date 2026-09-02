/**
 * フリモーラ Desktop（Electron）へ繋ぐクライアント。
 *
 * Electron が起動していれば、バックアップ JSON を手渡ししなくても
 * localStorage を直接読める。**起動していなければ何もせず null を返す**ので、
 * 呼び出し側は従来どおり backup_path へフォールバックできる。
 *
 * 接続先は Unix ドメインソケットのみ。ネットワークは使わない。
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SOCKET_PATH = path.join(os.homedir(), '.furimora', 'app.sock');

/** ソケットファイルの有無だけ見る。生きているかは繋いでみないと分からない */
export function appSocketExists() {
  try { return fs.existsSync(SOCKET_PATH); } catch { return false; }
}

/**
 * 1 回の要求で繋いで、返事をもらって切る。
 * 常駐接続を持たないのは、MCP サーバーが 1 コマンドごとに使い捨てられる前提だから。
 */
export function callApp(op, args = {}, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!appSocketExists()) {
      reject(Object.assign(new Error('フリモーラ Desktop が起動していません'), { code: 'APP_NOT_RUNNING' }));
      return;
    }
    const sock = net.connect(SOCKET_PATH);
    let buf = '';
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); fn(v); };
    const timer = setTimeout(
      () => finish(reject, Object.assign(new Error(`応答がありません（${timeoutMs}ms）`), { code: 'APP_TIMEOUT' })),
      timeoutMs
    );

    sock.on('connect', () => sock.write(JSON.stringify({ id: 1, op, args }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let res;
      try { res = JSON.parse(buf.slice(0, nl)); }
      catch (e) { finish(reject, Object.assign(new Error('応答が不正な JSON です'), { code: 'APP_BAD_RESPONSE' })); return; }
      if (res.ok) finish(resolve, res.result);
      else finish(reject, Object.assign(new Error(res.error?.message || '不明なエラー'), { code: res.error?.code || 'APP_ERROR' }));
    });
    sock.on('error', (e) => finish(
      reject,
      Object.assign(new Error(`フリモーラ Desktop に接続できません: ${e.message}`), { code: 'APP_NOT_RUNNING' })
    ));
  });
}

/** 起動しているか。繋いで確かめる（ソケットファイルが残骸のことがある） */
export async function appIsRunning() {
  try { await callApp('ping', {}, { timeoutMs: 2000 }); return true; }
  catch { return false; }
}

/**
 * localStorage のキーを配列として読む。
 * `furimora_drafts` / `furimora_items` はどちらも JSON 文字列で入っている。
 */
export async function readJsonArrayFromApp(key) {
  const { values } = await callApp('read_storage', { keys: [key] });
  const raw = values?.[key];
  if (raw == null) throw new Error(`${key} がありません（未ログイン、または同期前の可能性）`);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${key} が配列ではありません`);
  return parsed;
}
