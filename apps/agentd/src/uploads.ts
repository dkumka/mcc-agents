import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { AttachedFile, SendPayload } from '@mcc-agents/protocol';
import { config } from './config.ts';
import { logger } from './log.ts';
import { mimeOf } from './mime.ts';

const log = logger('uploads');

/**
 * Files the user attaches live here (not in the project, so git stays clean). Claude gets it via --add-dir.
 * Kept forever: nothing deletes them automatically (the user removes them by hand if needed).
 */
export const UPLOADS_DIR = path.join(config.dataDir, 'uploads');
export const MAX_UPLOAD = 50 * 1024 * 1024;

function safeName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f/]/g, '').trim();
  const clean = base.replace(/^\.+/, '') || 'file';
  if (clean.length <= 120) return clean;
  const ext = path.extname(clean).slice(0, 16);
  return clean.slice(0, 120 - ext.length) + ext;
}

/** POST /api/upload — raw body, name in X-File-Name (URI-encoded). Streams to disk with a size cap. */
export function handleUpload(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // only from our own pages (the session cookie is SameSite=Lax, this is a second fence)
  const origin = req.headers.origin;
  try {
    if (!origin || new URL(origin).host !== req.headers.host) return reply(403, { error: 'bad origin' });
  } catch {
    return reply(403, { error: 'bad origin' });
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD) return reply(413, { error: `Файл больше ${MAX_UPLOAD / 1024 / 1024} МБ` });
  let name = 'file';
  try {
    name = safeName(decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')));
  } catch {
    name = safeName(String(req.headers['x-file-name'] ?? 'file'));
  }
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(UPLOADS_DIR, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomUUID().slice(0, 8)}-${name}`);
  const out = fs.createWriteStream(file, { mode: 0o600 });
  let size = 0;
  let failed = false;
  const fail = (status: number, msg: string) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(file, { force: true }, () => {});
    reply(status, { error: msg });
    req.resume();
  };
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD) fail(413, `Файл больше ${MAX_UPLOAD / 1024 / 1024} МБ`);
  });
  req.on('error', () => fail(400, 'upload aborted'));
  out.on('error', (e) => fail(500, e.message));
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    const f: AttachedFile = { path: file, name, size, mediaType: contentType(req.headers['content-type'], name) };
    log.info(`upload ${name} ${size} B`);
    reply(200, f);
  });
}

/** Stored name is `<uuid8>-<original>`: show the original. */
export function displayName(p: string): string {
  const base = path.basename(p);
  if (path.resolve(p).startsWith(UPLOADS_DIR + '/')) {
    const m = base.match(/^[0-9a-f]{8}-(.+)$/);
    if (m) return m[1];
  }
  return base;
}

/** How much the uploads folder holds (for Settings). */
export function uploadsStats(): { dir: string; files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let list: fs.Dirent[] = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        try {
          bytes += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(UPLOADS_DIR);
  return { dir: UPLOADS_DIR, files, bytes };
}

function contentType(h: string | undefined, name: string): string {
  const t = String(h ?? '').split(';')[0].trim().toLowerCase();
  return t && t !== 'application/octet-stream' ? t : mimeOf(name);
}

function human(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

const OPEN = '<attached_files>';
const CLOSE = '</attached_files>';

/** Text the CLI receives: the user's text + a block with the paths of attached files. */
export function textWithFiles(p: SendPayload): string {
  const files = (p.files ?? []).filter((f) => path.resolve(f.path).startsWith(UPLOADS_DIR + '/') && fs.existsSync(f.path));
  if (!files.length) return p.text;
  const lines = files.map(
    (f) => `- ${f.path} — «${f.name}», ${human(f.size)}${/^image\//.test(f.mediaType ?? '') ? ' (оригинал картинки, она уже приложена к сообщению)' : ''}`,
  );
  return `${p.text}\n\n${OPEN}\nПользователь приложил файлы (они на диске; прочитай нужные сам — для .docx/.xlsx/.pdf и т.п. используй подходящие инструменты):\n${lines.join('\n')}\n${CLOSE}`;
}

/** Inverse for history: split the block off the text into AttachedFile entries. */
export function splitFiles(text: string): { text: string; files: AttachedFile[] } {
  const i = text.lastIndexOf(OPEN);
  const j = text.lastIndexOf(CLOSE);
  if (i < 0 || j < i) return { text, files: [] };
  const block = text.slice(i + OPEN.length, j);
  const files: AttachedFile[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/^- (\/\S.*?) — «(.+)», (.+)$/);
    if (!m) continue;
    let size = 0;
    try {
      size = fs.statSync(m[1]).size;
    } catch {}
    files.push({ path: m[1], name: m[2], size, mediaType: mimeOf(m[1]) });
  }
  return { text: (text.slice(0, i) + text.slice(j + CLOSE.length)).trim(), files };
}
