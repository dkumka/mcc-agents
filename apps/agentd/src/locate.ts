import fs from 'node:fs';
import path from 'node:path';
import { allowedPath, config } from './config.ts';

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

/** Nearest folder at or above `p` with `.git` (a folder, or a file in a worktree); never the home folder itself. */
export function gitRoot(p: string): string | null {
  let d = path.resolve(p);
  while (d !== '/' && d !== config.home) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    d = path.dirname(d);
  }
  return null;
}

/** Git roots of the paths a chat touched (newest first), without repeats and outside-the-roots folders. */
export function gitRoots(touched: string[]): string[] {
  const out: string[] = [];
  for (const t of touched) {
    const r = gitRoot(t);
    if (r && !out.includes(r) && allowedPath(r)) out.push(r);
  }
  return out;
}

const isWorktree = (root: string) => {
  try {
    return fs.statSync(path.join(root, '.git')).isFile();
  } catch {
    return false;
  }
};

/** Repositories of a multi-repo folder: `cwd/<repo>` and `cwd/worktrees/<task>/<repo>`, plus the repo `cwd` is in. */
export function reposIn(cwd: string): string[] {
  const out: string[] = [];
  const own = gitRoot(cwd);
  if (own) out.push(own);
  const subdirs = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP.has(e.name)).map((e) => path.join(d, e.name)).sort();
    } catch {
      return [];
    }
  };
  for (const d of subdirs(cwd)) if (fs.existsSync(path.join(d, '.git'))) out.push(d);
  for (const task of subdirs(path.join(cwd, 'worktrees'))) for (const d of subdirs(task)) if (fs.existsSync(path.join(d, '.git'))) out.push(d);
  return out;
}

/** `rel` under `root`; when `rel` starts with the repo's own folder (`supa-nest/libs/…` for …/supa-nest), from its parent too. */
function under(root: string, rel: string): string[] {
  const out = [path.join(root, rel)];
  if (rel.split('/')[0] === path.basename(root)) out.push(path.join(path.dirname(root), rel));
  return out;
}

/** Readable files among `paths`, in order, one per real file. */
function existing(paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (stat(p).status !== 'ok') continue;
    const real = fs.realpathSync(p);
    if (!seen.has(real)) {
      seen.add(real);
      out.push(p);
    }
  }
  return out;
}

const COMPARE_MAX = 4 * 1024 * 1024;

function sameContent(a: string, b: string): boolean {
  try {
    if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
    const sa = fs.statSync(a).size;
    if (sa !== fs.statSync(b).size) return false;
    return sa > COMPARE_MAX || fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

/** Files from the repositories the chat touched go first, newest repository on top. */
function byRecency(paths: string[], roots: string[]): string[] {
  const rank = (p: string) => {
    const i = roots.findIndex((r) => p === r || p.startsWith(r + '/'));
    return i < 0 ? roots.length : i;
  };
  return paths.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}

export interface LocateOptions {
  /** Chat folder. */
  cwd?: string;
  /** Written as a bare file name (`README.md`): a single match elsewhere opens at once. */
  bare?: boolean;
  /** Paths with this file name the chat already touched. */
  hints?: string[];
  /** Paths the chat touched, newest first: their git roots are where relative paths are tried next. */
  touched?: string[];
  /** The path as the agent wrote it, when it was relative (`models/partner.js`). */
  rel?: string;
}

/**
 * Open `raw` (already resolved against the chat folder) if it exists. A relative path that is missing there is tried
 * from the git roots the chat touched, then from the repositories inside the chat folder, then matched by its tail.
 * A bare name is looked up among this chat's paths, in those roots, then by name in `cwd`. One match opens, several
 * give a choice; a file that also exists, with other content, in a worktree the chat worked in gives a choice too.
 */
export function locate(raw: string, o: LocateOptions = {}): Located {
  const p = path.resolve(raw);
  const direct = stat(p);
  const roots = gitRoots(o.touched ?? []);
  const rel = o.rel && !path.isAbsolute(o.rel) ? path.normalize(o.rel) : undefined;
  const relOk = !!rel && rel !== '.' && !rel.startsWith('..');
  const cwd = o.cwd && allowedPath(o.cwd) ? path.resolve(o.cwd) : undefined;
  const pick = (found: string[]): Located | null => {
    if (found.length === 1) return { ...stat(found[0]), matches: [] };
    if (found.length > 1) return { path: p, status: 'choose', matches: byRecency(found, roots).slice(0, MAX_MATCHES) };
    return null;
  };

  if (direct.status === 'ok') {
    // `supa-nest/libs/x.js` exists in the main checkout, but the agent was editing a worktree of it
    if (relOk && !o.bare) {
      const other = existing(roots.filter(isWorktree).flatMap((r) => under(r, rel))).filter((m) => !sameContent(m, p));
      if (other.length) return { path: p, status: 'choose', matches: [...other, p] };
    }
    return { ...direct, matches: [] };
  }
  if (direct.status !== 'not_found') return { ...direct, matches: [] };
  const name = path.basename(p);

  if (o.bare) {
    const near = existing([...(o.hints ?? []).map((h) => path.resolve(h)).filter((h) => path.basename(h) === name), ...roots.map((r) => path.join(r, name))]);
    const found = near.length || !cwd ? near : findByName(cwd, name);
    return pick(found.filter((m) => m !== p)) ?? { path: p, status: 'not_found', matches: [] };
  }

  if (relOk) {
    const recent = existing(roots.flatMap((r) => under(r, rel)));
    const hit = pick(recent.length || !cwd ? recent : existing(reposIn(cwd).flatMap((r) => under(r, rel))));
    if (hit) return hit;
  }
  // same name elsewhere; with a relative path, the ones whose path ends the same way are the answer
  const found = new Set<string>();
  for (const h of o.hints ?? []) {
    const hp = path.resolve(h);
    if (path.basename(hp) === name && stat(hp).status === 'ok') found.add(hp);
  }
  // a full walk per root: only the latest few repositories
  for (const r of [...roots.slice(0, 5), ...(cwd ? [cwd] : [])]) for (const f of findByName(r, name)) found.add(f);
  const matches = byRecency(existing([...found].filter((m) => m !== p)), roots);
  if (relOk && rel !== name) {
    const tail = matches.filter((m) => m.endsWith('/' + rel));
    const hit = pick(tail);
    if (hit) return hit;
  }
  return { path: p, status: 'not_found', matches };
}
