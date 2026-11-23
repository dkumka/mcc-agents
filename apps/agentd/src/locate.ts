import fs from 'node:fs';
import path from 'node:path';
import { allowedPath } from './config.ts';

/** What the file viewer gets before it opens a path an agent mentioned. */
export interface Located {
  /** The path that was opened, or the one the panel tried when nothing was found. */
  path: string;
  status: 'ok' | 'choose' | 'not_found' | 'forbidden' | 'eacces' | 'not_file';
  size?: number;
  /** Files with the same name: the choice for 'choose', suggestions for 'not_found'. */
  matches: string[];
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'worktrees', '.next']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const MAX_MATCHES = 20;

function stat(p: string): Omit<Located, 'matches'> {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { path: p, status: code === 'EACCES' || code === 'EPERM' ? 'eacces' : 'not_found' };
  }
  if (!allowedPath(p)) return { path: p, status: 'forbidden' };
  if (!st.isFile()) return { path: p, status: 'not_file' };
  try {
    fs.accessSync(p, fs.constants.R_OK);
  } catch {
    return { path: p, status: 'eacces' };
  }
  return { path: p, status: 'ok', size: st.size };
}

/** Files called `name` under `root`, at most MAX_DEPTH folders down, skipping build output and dependencies. */
export function findByName(root: string, name: string): string[] {
  const out: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sub: string[] = [];
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || out.length >= MAX_MATCHES) return;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === name) out.push(full);
      else if (e.isDirectory() && !SKIP.has(e.name) && depth < MAX_DEPTH) sub.push(full);
    }
    // breadth first within a folder: closer files come first
    for (const d of sub) walk(d, depth + 1);
  };
  walk(root, 0);
  return out.filter((p) => allowedPath(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/**
 * Open `raw` (already absolute) if it exists. Otherwise look for a file with the same name: among paths seen in this
 * chat (`hints`), then in `cwd`. A bare name (`bare`) with a single match opens it; anything else only suggests.
 */
export function locate(raw: string, o: { cwd?: string; bare?: boolean; hints?: string[] } = {}): Located {
  const p = path.resolve(raw);
  const direct = stat(p);
  if (direct.status !== 'not_found') return { ...direct, matches: [] };
  const name = path.basename(p);
  const found = new Set<string>();
  for (const h of o.hints ?? []) {
    const hp = path.resolve(h);
    if (path.basename(hp) === name && stat(hp).status === 'ok') found.add(hp);
  }
  if (!(o.bare && found.size > 0) && o.cwd && allowedPath(o.cwd)) for (const f of findByName(path.resolve(o.cwd), name)) found.add(f);
  const matches = [...found].filter((m) => m !== p);
  if (o.bare && matches.length === 1) return { ...stat(matches[0]), matches: [] };
  if (o.bare && matches.length > 1) return { path: p, status: 'choose', matches };
  return { path: p, status: 'not_found', matches };
}
