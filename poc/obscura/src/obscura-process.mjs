/**
 * Obscura プロセス管理（PoC）
 * - 子プロセスとして `obscura serve` を起動し、CDP エンドポイントが上がるまで待つ
 * - 終了時に確実に kill する（孤児プロセスを残さない）
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

export class ObscuraProcess {
  /**
   * @param {{binPath: string, port?: number, storageDir?: string, stealth?: boolean, verbose?: boolean}} opts
   */
  constructor(opts) {
    this.binPath = opts.binPath;
    this.port = opts.port ?? 9222;
    this.storageDir = opts.storageDir ?? null;
    this.stealth = opts.stealth ?? true;
    this.verbose = opts.verbose ?? false;
    this.allowPrivateNetwork = opts.allowPrivateNetwork ?? false;
    this.proc = null;
    this.logs = [];
  }

  get cdpUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (this.proc) return;
    const args = ['serve', '--port', String(this.port), '--host', '127.0.0.1'];
    if (this.storageDir) args.push('--storage-dir', this.storageDir);
    if (this.stealth) args.push('--stealth');
    if (this.allowPrivateNetwork) args.push('--allow-private-network');
    if (!this.verbose) args.push('--quiet');

    this.proc = spawn(this.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = (buf) => {
      const s = String(buf);
      this.logs.push(s);
      if (this.logs.length > 500) this.logs.shift();
      if (this.verbose) process.stderr.write(`[obscura] ${s}`);
    };
    this.proc.stdout.on('data', capture);
    this.proc.stderr.on('data', capture);

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.verbose) process.stderr.write(`[obscura] exited code=${code} signal=${signal}\n`);
    });

    // アプリ終了時に子プロセスを残さない
    this._onExit = () => this.stop();
    process.on('exit', this._onExit);
    process.on('SIGINT', () => { this.stop(); process.exit(130); });
    process.on('SIGTERM', () => { this.stop(); process.exit(143); });

    await waitForPort('127.0.0.1', this.port, 15000);
  }

  /** SIGTERM を送る（Obscura は clean exit 時に cookies/localStorage を書き出す） */
  async stop({ timeoutMs = 8000 } = {}) {
    const p = this.proc;
    if (!p) return;
    const exited = new Promise((resolve) => p.once('exit', resolve));
    p.kill('SIGTERM');
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    await exited.catch(() => {});
    clearTimeout(timer);
    this.proc = null;
    if (this._onExit) process.off('exit', this._onExit);
  }
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host, port });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`obscura の CDP ポート ${port} が ${timeoutMs}ms 以内に開きませんでした`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}
