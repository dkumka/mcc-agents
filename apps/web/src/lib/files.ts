/** Files on the server: URLs for /api/raw and what kind of preview a file gets. */

import type { ChatItem } from '@mcc-agents/protocol';

export type FileKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'office' | 'other';

const EXT: Record<string, FileKind> = {};
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'heif']) EXT[e] = 'image';
for (const e of ['mp4', 'm4v', 'mov', 'webm']) EXT[e] = 'video';
for (const e of ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'opus', 'flac']) EXT[e] = 'audio';
for (const e of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key']) EXT[e] = 'office';
for (const e of ['zip', 'gz', 'tgz', 'tar', '7z', 'rar', 'bz2', 'xz', 'dmg', 'exe', 'bin', 'so', 'o', 'class', 'jar', 'woff', 'woff2', 'ttf', 'otf', 'sqlite', 'db', 'psd', 'sketch', 'fig'])
  EXT[e] = 'other';
EXT.pdf = 'pdf';

export function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

/** Unknown extensions are treated as text: the viewer falls back to "binary" if the server says so. */
export function fileKind(name: string, mediaType?: string): FileKind {
  const k = EXT[extOf(name)];
  if (k) return k;
  if (mediaType?.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType?.startsWith('video/')) return 'video';
  if (mediaType?.startsWith('audio/')) return 'audio';
  return 'text';
}

/** Images the browser can draw itself (HEIC only in Safari). */
export function browserImage(name: string): boolean {
  const e = extOf(name);
  if (e === 'heic' || e === 'heif') return isApple();
  return EXT[e] === 'image';
}

export function rawUrl(path: string, o: { dl?: boolean; thumb?: boolean; name?: string } = {}): string {
  const q = new URLSearchParams({ path });
  if (o.dl) q.set('dl', '1');
  if (o.thumb) q.set('thumb', '1');
  if (o.name) q.set('name', o.name);
  return `/api/raw?${q}`;
}

export function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p;
}

/** Stored uploads are `<uuid8>-<name>`. */
export function displayName(p: string): string {
  const b = baseName(p);
  return /\/mcc-agents\/uploads\//.test(p) ? b.replace(/^[0-9a-f]{8}-/, '') : b;
}

export function fmtSize(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

export function isApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Resolve a path an agent wrote in a message: absolute, ~/…, or relative to the chat folder.
 * Returns null for things that only look like paths (URLs, globs, flags).
 */
export function resolvePath(raw: string, cwd: string, home?: string): string | null {
  let p = raw.trim().replace(/^file:\/\//, '').replace(/:(\d+)(:\d+)?$/, '');
  if (!p || /[\s*?<>|"'`]/.test(p) || /^[a-z]+:\/\//i.test(p) || p.startsWith('-')) return null;
  if (p.startsWith('~/')) {
    const h = home ?? (cwd.match(/^\/home\/[^/]+/)?.[0] || cwd.match(/^\/Users\/[^/]+/)?.[0]);
    if (!h) return null;
    p = h + p.slice(1);
  } else if (!p.startsWith('/')) {
    p = `${cwd.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`;
  }
  // normalise ./ and ../
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

const DOMAIN = /^(www\.|[a-z0-9-]+\.)+(com|net|org|io|dev|app|ai|co|me|sh|ru|su|video|xyz|info|cloud|site|online|tech|pro|us|uk|de|eu)$/i;

/** A file name without any folder (`README.md`): it may live anywhere in the project. */
export function isBareName(s: string): boolean {
  const t = s.trim().replace(/^file:\/\//, '').replace(/:(\d+)(:\d+)?$/, '');
  return !!t && !t.includes('/');
}

/**
 * Absolute paths named `name` that this chat already touched: Read/Write/Edit inputs, diffs, tool titles and
 * paths written in messages. Used to find a file the agent later mentions by its bare name.
 */
export function pathsNamed(items: readonly ChatItem[], name: string, cwd: string): string[] {
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.includes(name)) return;
    const p = resolvePath(raw, cwd);
    if (p && baseName(p) === name) out.add(p);
  };
  for (const it of items) {
    if (it.kind === 'tool') {
      const input = it.input as Record<string, unknown> | null;
      if (input && typeof input === 'object') for (const k of ['file_path', 'path', 'notebook_path']) add(input[k]);
      for (const d of it.diffs ?? []) add(d.path);
      add(it.title);
    } else if (it.kind === 'assistant' || it.kind === 'user') {
      if (!it.text.includes(name)) continue;
      for (const m of it.text.matchAll(/(?:^|[\s(`'"[])((?:~|\/)[^\s()`'"<>[\]]+)/g)) add(m[1].replace(/[.,;:!?]+$/, ''));
    }
  }
  return [...out];
}

/** Does inline code / a link target look like a file path worth making clickable? */
export function looksLikeFile(s: string): boolean {
  const t = s.trim().replace(/:(\d+)(:\d+)?$/, '');
  if (t.length < 3 || t.length > 300 || /\s/.test(t) || (/^[a-z]+:\/\//i.test(t) && !t.startsWith('file://'))) return false;
  if (!/\.(?:[A-Za-z0-9]{1,8}|code-workspace)$/.test(t)) return false; // needs an extension
  if (/^(\/|~\/|\.\.?\/|file:\/\/)/.test(t)) return true;
  // a URL without a scheme: `github.com/x/README.md`, `www.site.ru/a.html`
  if (DOMAIN.test(t.split('/')[0])) return false;
  if (t.includes('/')) return /^[\w.@+-]+(\/[\w.@+ -]+)+$/.test(t);
  // a bare name: only for typical "here is your file" extensions (not `foo.bar()` or `v1.2`)
  return /^[\w.@+-]+\.(code-workspace|docx?|xlsx?|pptx?|pdf|csv|tsv|zip|tar|gz|png|jpe?g|gif|webp|svg|mp4|mov|mp3|wav|txt|md|json|html?|log)$/i.test(t);
}

export function isWorkspace(path: string): boolean {
  return /\.code-workspace$/i.test(path);
}

export function workspaceUrl(path: string): string {
  return `https://vscode.mcc.klemid.ru/?${new URLSearchParams({ workspace: path })}`;
}
