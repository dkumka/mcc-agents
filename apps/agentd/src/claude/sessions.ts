import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ChatSummary } from '@mcc-agents/protocol';
import { config } from '../config.ts';
import { logger } from '../log.ts';
import type { Chat } from '../chat.ts';
import { ClaudeNormalizer } from './normalize.ts';

const log = logger('claude-sessions');

interface FileInfo {
  file: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
  offset: number;
  cwd?: string;
  firstPrompt?: string;
  aiTitle?: string;
  customTitle?: string;
  summary?: string;
  entrypoint?: string;
  createdAt?: number;
  /** Time of the last user/assistant message — the file mtime also moves when the CLI appends service lines on exit. */
  activityAt?: number;
  model?: string;
}

const cache = new Map<string, FileInfo>(); // sessionId → info
const reCwd = /"cwd":"((?:[^"\\]|\\.)*)"/;
const reEntry = /"entrypoint":"([^"]*)"/;
const reTs = /"timestamp":"([^"]+)"/;
const reModel = /"model":"(claude-[^"]+)"/;

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function promptOf(line: string): string | undefined {
  if (line.length > 300_000 || line.includes('"isMeta":true') || line.includes('"isSidechain":true')) return;
  try {
    const m = JSON.parse(line);
    if (m.type !== 'user' || m.isCompactSummary) return;
    const c = m.message?.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      if (c.some((b: { type?: string }) => b?.type === 'tool_result')) return;
      text = c.filter((b: { type?: string }) => b?.type === 'text').map((b: { text: string }) => b.text).join(' ');
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!text || text.startsWith('<') || text.startsWith('[Image') || text.startsWith('[Request interrupted')) return;
    return text;
  } catch {
    return;
  }
}

async function readFrom(info: FileInfo, size: number) {
  if (info.offset >= size) return;
  const stream = fs.createReadStream(info.file, { start: info.offset, end: size - 1, encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let consumed = info.offset;
  for await (const line of rl) {
    consumed += Buffer.byteLength(line) + 1;
    if (!line) continue;
    if (line.startsWith('{"type":"ai-title"')) {
      try {
        info.aiTitle = JSON.parse(line).aiTitle;
      } catch {}
      continue;
    }
    if (line.startsWith('{"type":"custom-title"')) {
      try {
        const j = JSON.parse(line);
        info.customTitle = j.customTitle ?? j.title;
      } catch {}
      continue;
    }
    if (line.startsWith('{"type":"summary"')) {
      try {
        info.summary = JSON.parse(line).summary;
      } catch {}
      continue;
    }
    if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"attachment"')) continue;
    if (!info.cwd) {
      const m = line.slice(0, 20_000).match(reCwd);
      if (m) info.cwd = unescapeJson(m[1]);
    }
    if (!info.entrypoint) {
      const m = line.slice(0, 20_000).match(reEntry);
      if (m) info.entrypoint = m[1];
    }
    if (!info.createdAt) {
      const m = line.slice(0, 2000).match(reTs);
      if (m) info.createdAt = Date.parse(m[1]);
    }
    if (!info.firstPrompt && line.includes('"type":"user"')) info.firstPrompt = promptOf(line);
    const assistant = line.includes('"type":"assistant"');
    if (assistant) {
      const m = line.slice(0, 4000).match(reModel);
      if (m) info.model = m[1];
    }
    if (assistant || line.includes('"type":"user"')) {
      // top-level "timestamp" comes after "message", near the end of the line
      const i = line.lastIndexOf('"timestamp":"');
      const t = i >= 0 ? Date.parse(line.slice(i + 13, i + 13 + 40).split('"')[0]) : NaN;
      if (t > (info.activityAt ?? 0)) info.activityAt = t;
    }
  }
  // the last line may be incomplete while the CLI writes: re-read it next time
  info.offset = Math.min(consumed, size);
}

function originOf(entry?: string): ChatSummary['origin'] {
  if (entry === config.claudeEntrypoint) return 'web';
  if (entry === 'cli') return 'terminal';
  return 'other';
}

export function toSummary(info: FileInfo): ChatSummary | null {
  if (!info.cwd || !info.firstPrompt) return null;
  const title = info.customTitle || info.aiTitle || info.summary || info.firstPrompt;
  return {
    id: `claude:${info.sessionId}`,
    agent: 'claude',
    nativeId: info.sessionId,
    cwd: info.cwd,
    title: title.replace(/\s+/g, ' ').slice(0, 140),
    createdAt: info.createdAt ?? info.mtimeMs,
    updatedAt: info.activityAt ? Math.min(info.activityAt, info.mtimeMs) : info.mtimeMs,
    status: 'idle',
    origin: originOf(info.entrypoint),
    model: info.model,
  };
}

/** Scan ~/.claude/projects/*\/*.jsonl incrementally (append-only reads by offset). */
export async function scanClaudeSessions(): Promise<ChatSummary[]> {
  const out: ChatSummary[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(config.claudeProjects);
  } catch {
    return out;
  }
  const seen = new Set<string>();
  for (const d of dirs) {
    const dir = path.join(config.claudeProjects, d);
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const sessionId = f.slice(0, -6);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      seen.add(sessionId);
      let info = cache.get(sessionId);
      if (!info || info.file !== file || st.size < info.size) {
        info = { file, sessionId, size: 0, mtimeMs: 0, offset: 0 };
        cache.set(sessionId, info);
      }
      if (st.size !== info.size || st.mtimeMs !== info.mtimeMs) {
        try {
          await readFrom(info, st.size);
        } catch (e) {
          log.warn(`scan ${file}`, e);
        }
        info.size = st.size;
        info.mtimeMs = st.mtimeMs;
      }
      const s = toSummary(info);
      if (s) out.push(s);
    }
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return out;
}

export function sessionFile(sessionId: string): string | undefined {
  return cache.get(sessionId)?.file;
}

/** Load the full transcript into the chat (silent: caller sends a snapshot afterwards). */
export async function loadClaudeHistory(chat: Chat, file: string): Promise<ClaudeNormalizer> {
  const norm = new ClaudeNormalizer(chat, true);
  chat.resetItems([]);
  chat.state.todos = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    if (line.startsWith('{"type":"') && !/^\{"type":"(user|assistant|system)"/.test(line)) continue;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.isSidechain) continue;
    const ts = m.timestamp ? Date.parse(m.timestamp) : undefined;
    if (m.type === 'assistant') norm.assistant(m, ts);
    else if (m.type === 'user') norm.user(m, ts);
    else if (m.type === 'system') {
      if (m.subtype === 'compact_boundary') chat.upsert({ kind: 'notice', id: m.uuid, ts, level: 'info', text: 'Контекст сжат (compact)' }, { silent: true });
      else if (m.subtype === 'local_command' && typeof m.content === 'string') norm.user({ uuid: m.uuid, message: { content: m.content } }, ts);
      else if (m.subtype === 'api_error' && m.level === 'error') chat.upsert({ kind: 'notice', id: m.uuid, ts, level: 'error', text: 'Ошибка API' }, { silent: true });
    }
  }
  // tools left "running" in history were never answered — the turn ended without them
  for (const it of chat.state.items) {
    if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending') && !it.backgroundTaskId) it.status = 'interrupted';
    if ((it.kind === 'assistant' || it.kind === 'thinking') && it.streaming) it.streaming = false;
  }
  return norm;
}

/**
 * Fork a session without the CLI: copy its .jsonl up to (not including) the user message `beforeUuid` under a new
 * session id — exactly what `claude --resume … --fork-session` keeps, but cut at any point and with no API call.
 * Lines are kept byte for byte except the `sessionId`; a `custom-title` line names the branch (also in `claude --resume`).
 */
export function forkSessionFile(sessionId: string, newId: string, title: string, beforeUuid?: string): string {
  const file = sessionFile(sessionId);
  if (!file) throw new Error('файл сессии не найден');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let end = lines.length;
  if (beforeUuid) {
    // `"uuid":"…"` (lower-case u) is the line's own id; `"parentUuid":"…"` does not match it
    end = lines.findIndex((l) => l.includes(`"uuid":"${beforeUuid}"`));
    if (end < 0) throw new Error('сообщение не найдено в истории Claude');
  }
  const kept = lines.slice(0, end);
  if (!kept.some((l) => l.includes('"type":"assistant"'))) throw new Error('до этого сообщения разговора ещё нет — начните новый чат');
  const out = kept.map((l) => l.split(`"sessionId":"${sessionId}"`).join(`"sessionId":"${newId}"`));
  out.push(JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: newId }));
  const dest = path.join(path.dirname(file), `${newId}.jsonl`);
  fs.writeFileSync(dest, out.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  return dest;
}
