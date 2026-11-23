import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { config } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('agy-acp');
type Json = Record<string, any>;

/**
 * One long-lived `agy acp` — the official Agent Client Protocol server of the Antigravity CLI (JSON-RPC 2.0, NDJSON over
 * stdio), the same thing editors (Zed, JetBrains) talk to. One process serves every session; restarts itself on exit.
 * Events: 'notification' (method, params), 'request' (id, method, params), 'ready' (initialize result), 'exit'.
 */
export class AcpServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private waiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string }>();
  private starting: Promise<void> | null = null;
  private backoff = 1000;
  private stopped = false;
  private everReady = false;
  ready = false;
  info: Json = {};
  lastError?: string;

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('agy acp остановлен'));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      log.info('spawn agy acp');
      const child = spawn(config.agyBin, ['acp'], { cwd: config.home, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
      this.child = child;
      child.stdin.on('error', () => {});
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => this.onLine(line));
      child.stderr.on('data', (b: Buffer) => log.debug('stderr', b.toString().slice(0, 500)));
      child.on('error', (e) => {
        this.lastError = e.message;
        log.error('spawn failed', e);
      });
      child.on('exit', (code) => {
        log.warn(`agy acp exited code=${code}`);
        this.ready = false;
        this.child = null;
        this.starting = null;
        for (const w of this.waiters.values()) {
          if (w.timer) clearTimeout(w.timer);
          w.reject(new Error('agy acp завершился'));
        }
        this.waiters.clear();
        this.emit('exit');
        reject(new Error('agy acp завершился'));
        if (!this.stopped && this.everReady) {
          // only respawn by itself after a crash of a working server; a failing start is retried by the next request
          setTimeout(() => this.start().catch(() => {}), this.backoff);
          this.backoff = Math.min(this.backoff * 2, 60_000);
        }
      });
      this.raw(
        'initialize',
        {
          protocolVersion: 1,
          // the agent reads/writes files and runs commands itself, as in the terminal
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: config.codexClientName, title: 'mcc agents', version: config.version },
        },
        60_000,
      )
        .then((r) => {
          this.info = r ?? {};
          this.ready = true;
          this.everReady = true;
          this.backoff = 1000;
          this.lastError = undefined;
          this.emit('ready', this.info);
          resolve();
        })
        .catch((e) => {
          this.lastError = e.message;
          child.kill('SIGTERM');
          reject(e);
        });
    });
    this.starting.catch(() => {});
    return this.starting;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  stop() {
    this.stopped = true;
    this.child?.kill('SIGTERM');
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.id !== null && m.method) {
      this.emit('request', m.id, m.method, m.params ?? {});
      return;
    }
    if (m.id !== undefined && m.id !== null) {
      const w = this.waiters.get(m.id);
      if (!w) return;
      if (w.timer) clearTimeout(w.timer);
      this.waiters.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else w.resolve(m.result);
      return;
    }
    if (m.method) this.emit('notification', m.method, m.params ?? {});
  }

  private write(obj: Json) {
    if (!this.child) throw new Error('agy acp не запущен');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  }

  /** timeoutMs 0 — no timeout (session/prompt lasts as long as the turn). */
  private raw(method: string, params: Json, timeoutMs: number): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.waiters.delete(id);
            reject(new Error(`${method}: timeout`));
          }, timeoutMs)
        : undefined;
      this.waiters.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (e) {
        if (timer) clearTimeout(timer);
        this.waiters.delete(id);
        reject(e as Error);
      }
    });
  }

  async request(method: string, params: Json = {}, timeoutMs = 60_000): Promise<any> {
    await this.start();
    return this.raw(method, params, timeoutMs);
  }

  notify(method: string, params?: Json) {
    this.write(params ? { method, params } : { method });
  }

  respond(id: number | string, result: Json) {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string, code = -32601) {
    this.write({ id, error: { code, message } });
  }
}
