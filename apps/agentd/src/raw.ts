import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { config } from './config.ts';
import { check, HttpError } from './fsapi.ts';
import { logger } from './log.ts';
import { mimeOf } from './mime.ts';
import { displayName, UPLOADS_DIR } from './uploads.ts';

const log = logger('raw');

/** Shown in the browser as is. Everything else (html, office, archives…) is a download or plain text. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml|heic|heif)|application\/pdf|audio\/|video\/)/;
/** Never let a served file run script on our origin; PDF is exempt (Chrome refuses to render it sandboxed). */
const SANDBOX = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self'; style-src 'unsafe-inline'";

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------- thumbnails (Pillow on the server)

const THUMBS = path.join(config.dataDir, 'thumbs');
const THUMB_PX = 640;
const THUMBABLE = /^image\/(png|jpeg|gif|webp|bmp)$/;
const PY = `
import sys
from PIL import Image, ImageOps
im = Image.open(sys.argv[1])
im = ImageOps.exif_transpose(im)
im.thumbnail((int(sys.argv[3]), int(sys.argv[3])))
if im.mode in ('RGBA', 'LA', 'P'):
    im = im.convert('RGBA')
    bg = Image.new('RGB', im.size, (255, 255, 255))
    bg.paste(im, mask=im.split()[3])
    im = bg
elif im.mode != 'RGB':
    im = im.convert('RGB')
im.save(sys.argv[2], 'JPEG', quality=80, optimize=True)
`;
const inflight = new Map<string, Promise<string | null>>();

/** Cached JPEG preview of a big image; null → serve the original. */
function thumbnail(abs: string, st: fs.Stats): Promise<string | null> {
  if (!THUMBABLE.test(mimeOf(abs)) || st.size < 150_000) return Promise.resolve(null);
  const key = createHash('sha1').update(`${abs}|${st.size}|${st.mtimeMs}|${THUMB_PX}`).digest('hex');
  const out = path.join(THUMBS, `${key}.jpg`);
  if (fs.existsSync(out)) return Promise.resolve(out);
  const running = inflight.get(key);
  if (running) return running;
  const p = new Promise<string | null>((resolve) => {
    fs.mkdirSync(THUMBS, { recursive: true, mode: 0o700 });
    const tmp = `${out}.${process.pid}.tmp`;
    execFile('python3', ['-I', '-c', PY, abs, tmp, String(THUMB_PX)], { timeout: 20_000 }, (err) => {
      if (err) {
        fs.rm(tmp, { force: true }, () => {});
        log.warn(`thumbnail failed for ${abs}: ${String(err.message).split('\n').slice(-2).join(' ')}`);
        return resolve(null);
      }
      fs.renameSync(tmp, out);
      resolve(out);
    });
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---------------------------------------------------------------- GET/HEAD /api/raw?path=…[&dl=1][&thumb=1][&name=…]

export async function serveRaw(req: http.IncomingMessage, res: http.ServerResponse, q: URLSearchParams) {
  const abs = check(q.get('path'));
  let st = fs.statSync(abs);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  let file = abs;
  let type = mimeOf(abs);
  if (q.has('thumb')) {
    const t = await thumbnail(abs, st);
    if (t) {
      file = t;
      st = fs.statSync(t);
      type = 'image/jpeg';
    }
  }
  const name = q.get('name') || displayName(abs);
  const download = q.has('dl');
  const inline = !download && (INLINE.test(type) || type.startsWith('text/') || type === 'application/json');
  // text of any kind is shown as plain text: an .html from the project must not become a page on our origin
  const sentType = inline && (type.startsWith('text/') || type === 'application/json') ? 'text/plain; charset=utf-8' : type;
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers: http.OutgoingHttpHeaders = {
    'content-type': sentType,
    'content-disposition': disposition(inline ? 'inline' : 'attachment', file === abs ? name : name.replace(/\.[^.]+$/, '') + '.jpg'),
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'accept-ranges': 'bytes',
    'last-modified': st.mtime.toUTCString(),
    etag,
    // uploads never change (unique names); project files do
    'cache-control': abs.startsWith(UPLOADS_DIR + '/') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  };
  if (type !== 'application/pdf') headers['content-security-policy'] = SANDBOX;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = String(req.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && st.size > 0 && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    } else {
      start = Math.max(0, st.size - Number(range[2]));
    }
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['content-length'] = st.size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || st.size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
