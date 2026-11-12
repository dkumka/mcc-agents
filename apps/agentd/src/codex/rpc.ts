import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { config } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('codex-rpc');
type Json = Record<string, any>;

/**
 * One long-lived `codex app-server` (JSON-RPC over stdio). Restarts itself on exit.
 * Events: 'notification' (method, params), 'request' (id, method, params), 'ready', 'exit'.
 */
export class AppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private waiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private starting: Promise<void> | null = null;
  private backoff = 1000;
  private stopped = false;
  ready = false;
  lastError?: string;

  start(): Promise<void> {
    // after stop() (daemon shutdown) a late request — e.g. the 10-second list refresh — must not respawn it
    if (this.stopped) return Promise.reject(new Error('codex app-server остановлен'));
    if (this.ready) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      log.info('spawn codex app-server');
      const child = spawn(config.codexBin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
        log.warn(`app-server exited code=${code}`);
        this.ready = false;
        this.child = null;
        this.starting = null;
        for (const w of this.waiters.values()) {
          clearTimeout(w.timer);
          w.reject(new Error('codex app-server exited'));
        }
        this.waiters.clear();
        this.emit('exit');
        reject(new Error('codex app-server exited'));
        if (!this.stopped) {
          setTimeout(() => this.start().catch(() => {}), this.backoff);
          this.backoff = Math.min(this.backoff * 2, 60_000);
        }
      });
      this.raw('initialize', { clientInfo: { name: config.codexClientName, title: 'mcc agents', version: config.version }, capabilities: null }, 30_000)
        .then(() => {
          this.notify('initialized');
          this.ready = true;
          this.backoff = 1000;
          this.lastError = undefined;
          this.emit('ready');
          resolve();
        })
        .catch((e) => {
          this.lastError = e.message;
          reject(e);
        });
    });
    this.starting.catch(() => {});
    return this.starting;
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
    if (m.id !== undefined && m.method) {
      this.emit('request', m.id, m.method, m.params ?? {});
      return;
    }
    if (m.id !== undefined) {
      const w = this.waiters.get(m.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiters.delete(m.id);
      if (m.error) w.reject(new Error(`${w.method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else w.resolve(m.result);
      return;
    }
    if (m.method) this.emit('notification', m.method, m.params ?? {});
  }

  private write(obj: Json) {
    if (!this.child) throw new Error('codex app-server не запущен');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private raw(method: string, params: Json, timeoutMs: number): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method}: timeout`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer, method });
      try {
        this.write({ method, id, params });
      } catch (e) {
        clearTimeout(timer);
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

  respondError(id: number | string, message: string) {
    this.write({ id, error: { code: -32000, message } });
  }
}
