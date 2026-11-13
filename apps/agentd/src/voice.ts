import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { DEFAULT_VOICE_MODEL, VOICE_MODELS, type TranscribeResult } from '@mcc-agents/protocol';
import { config } from './config.ts';
import { logger } from './log.ts';
import { store } from './store.ts';

const log = logger('voice');

/** Shared server key (see SERVER.md, «Секреты»). Read on every call: `secret-set openrouter` works without a restart. */
const KEY_FILE = path.join(config.home, 'secrets/openrouter.env');
const API = 'https://openrouter.ai/api/v1/audio/transcriptions';
/** ~5 min of Opus/AAC voice is 2–5 MB; OpenRouter's inline cap is 25 MB. */
const MAX_AUDIO = 20 * 1024 * 1024;

export function openrouterKey(): string | null {
  try {
    const m = fs.readFileSync(KEY_FILE, 'utf8').match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function voiceModel(): string {
  const m = store.prefs().voiceModel;
  return VOICE_MODELS.some((v) => v.id === m) ? m : DEFAULT_VOICE_MODEL;
}

/** MediaRecorder type → OpenRouter `input_audio.format` (Chrome/Firefox: webm, Safari: mp4). */
function formatOf(type: string): string | null {
  const t = type.toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('wav')) return 'wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('flac')) return 'flac';
  return null;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_AUDIO) {
        reject(Object.assign(new Error('Запись слишком длинная'), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** POST /api/transcribe — raw audio body (Content-Type from MediaRecorder) → { text }. The key never leaves the server. */
export async function handleTranscribe(req: http.IncomingMessage, res: http.ServerResponse) {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  // only from our own pages, like /api/upload
  try {
    if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) return reply(403, { error: 'bad origin' });
  } catch {
    return reply(403, { error: 'bad origin' });
  }
  const format = formatOf(String(req.headers['content-type'] ?? ''));
  if (!format) return reply(415, { error: `Формат записи не поддерживается: ${req.headers['content-type'] ?? '—'}` });
  const key = openrouterKey();
  if (!key) return reply(503, { error: 'Нет ключа OpenRouter на сервере (secret-set openrouter)' });
  let audio: Buffer;
  try {
    audio = await readBody(req);
  } catch (e) {
    return reply((e as { status?: number }).status ?? 400, { error: (e as Error).message });
  }
  if (audio.length < 1000) return reply(400, { error: 'Пустая запись' });
  const model = voiceModel();
  const t0 = Date.now();
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-title': 'mcc agents' },
      // no `language`: auto-detect handles Russian speech with English words better than a forced "ru"
      body: JSON.stringify({ model, input_audio: { data: audio.toString('base64'), format }, temperature: 0 }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await r.json().catch(() => ({}))) as { text?: string; error?: { message?: string } | string };
    const ms = Date.now() - t0;
    if (!r.ok) {
      const msg = typeof body.error === 'string' ? body.error : (body.error?.message ?? `HTTP ${r.status}`);
      log.warn(`transcribe ${model} ${format} ${audio.length} B → ${r.status}: ${msg}`);
      return reply(502, { error: `OpenRouter (${model}): ${msg}` });
    }
    const text = String(body.text ?? '').trim();
    log.info(`transcribe ${model} ${format} ${audio.length} B → ${text.length} chars, ${ms} ms`);
    const out: TranscribeResult = { text, model, ms };
    reply(200, out);
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    log.warn(`transcribe ${model}`, e);
    reply(504, { error: timeout ? 'OpenRouter не ответил за 90 секунд' : `Нет связи с OpenRouter: ${(e as Error).message}` });
  }
}
