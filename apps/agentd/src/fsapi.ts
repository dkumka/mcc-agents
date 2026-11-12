import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DirEntry, GitStatus } from '@mcc-agents/protocol';
import { allowedPath, config } from './config.ts';

function run(cmd: string, args: string[], cwd: string, maxBuffer = 8 * 1024 * 1024): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer, timeout: 20_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as unknown as number) || 1 : 0;
      resolve({ out: String(stdout ?? ''), code: typeof code === 'number' ? code : 1 });
    });
  });
}

export function check(p: string | null | undefined): string {
  if (!p) throw new HttpError(400, 'path required');
  const abs = path.resolve(p);
  if (!allowedPath(abs)) throw new HttpError(403, 'path not allowed');
  return abs;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- directory listing

const HIDDEN = new Set(['.git', '.DS_Store']);

export function listDir(p: string): DirEntry[] {
  const abs = check(p);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const e of entries) {
    if (HIDDEN.has(e.name)) continue;
    // the instructions link every conversation folder has (see chat-dirs.ts) — noise in the file list
    if (e.name === 'AGENTS.md' && e.isSymbolicLink() && abs.startsWith(path.resolve(config.chatRoot) + '/')) continue;
    const full = path.join(abs, e.name);
    let dir = e.isDirectory();
    let size: number | undefined;
    if (e.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        dir = st.isDirectory();
        size = st.size;
      } catch {}
    } else if (!dir) {
      try {
        size = fs.statSync(full).size;
      } catch {}
    }
    out.push({ name: e.name, path: full, dir, size });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

export function readFile(p: string): { path: string; content: string; size: number; truncated: boolean; binary: boolean } {
  const abs = check(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new HttpError(400, 'is a directory');
  const max = 1024 * 1024;
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(Math.min(st.size, max));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: abs, content: binary ? '' : buf.toString('utf8'), size: st.size, truncated: st.size > max, binary };
}

/** Tail of a background task output file (Claude writes them under /tmp/claude-<uid>/…). */
export function tailFile(p: string, max = 64 * 1024): string {
  const abs = check(p);
  const st = fs.statSync(abs);
  const start = Math.max(0, st.size - max);
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return (start > 0 ? '…\n' : '') + buf.toString('utf8');
}

// ---------------------------------------------------------------- file search for @-mentions

const fileCache = new Map<string, { at: number; files: string[] }>();

async function filesOf(cwd: string): Promise<string[]> {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.files;
  let r = await run('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], cwd, 32 * 1024 * 1024);
  if (r.code !== 0 && !r.out) r = await run('git', ['ls-files'], cwd);
  const files = r.out.split('\n').filter(Boolean).slice(0, 50_000);
  fileCache.set(cwd, { at: Date.now(), files });
  return files;
}

function score(file: string, q: string): number {
  const f = file.toLowerCase();
  const base = path.basename(f);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 800 - base.length;
  if (base.includes(q)) return 600 - base.length;
  if (f.includes(q)) return 400 - f.length;
  // subsequence
  let i = 0;
  for (const ch of f) if (ch === q[i]) i++;
  return i === q.length ? 100 - f.length : -1;
}

export async function searchFiles(cwdRaw: string, q: string): Promise<string[]> {
  const cwd = check(cwdRaw);
  const files = await filesOf(cwd);
  const query = q.toLowerCase().trim();
  if (!query) return files.slice(0, 50);
  return files
    .map((f) => [f, score(f, query)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([f]) => f);
}

// ---------------------------------------------------------------- git

export async function gitStatus(cwdRaw: string): Promise<GitStatus> {
  const cwd = check(cwdRaw);
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return { isRepo: false, files: [], diff: '' };
  const st = await run('git', ['status', '--porcelain=v1', '-b', '--untracked-files=all'], cwd);
  const lines = st.out.split('\n').filter(Boolean);
  let branch: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const files: GitStatus['files'] = [];
  for (const l of lines) {
    if (l.startsWith('## ')) {
      const m = l.slice(3).match(/^([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?,? ?(?:behind (\d+))?\])?/);
      branch = m?.[1];
      ahead = m?.[2] ? Number(m[2]) : undefined;
      behind = m?.[3] ? Number(m[3]) : undefined;
      continue;
    }
    const x = l[0];
    const y = l[1];
    const file = l.slice(3);
    files.push({ path: file, status: x === '?' ? '??' : (x !== ' ' ? x : y), staged: x !== ' ' && x !== '?' });
  }
  const max = 2 * 1024 * 1024;
  const d = await run('git', ['diff', 'HEAD', '--no-color', '--no-ext-diff'], cwd, max * 2);
  let diff = d.out;
  // untracked files as additions (small ones)
  for (const f of files.filter((f) => f.status === '??').slice(0, 30)) {
    try {
      const abs = path.join(top.out.trim(), f.path);
      const fileAbs = fs.existsSync(path.join(cwd, f.path)) ? path.join(cwd, f.path) : abs;
      const st2 = fs.statSync(fileAbs);
      if (st2.size > 200_000) continue;
      const text = fs.readFileSync(fileAbs, 'utf8');
      if (text.includes('\0')) continue;
      const body = text.split('\n').map((l) => '+' + l);
      diff += `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${body.length} @@\n${body.join('\n')}\n`;
    } catch {}
  }
  const truncated = diff.length > max;
  return { isRepo: true, branch, ahead, behind, files, diff: truncated ? diff.slice(0, max) : diff, truncated };
}
