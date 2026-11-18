import fs from 'node:fs';
import path from 'node:path';
import type { AgentLimits, ChatSettings, Prefs } from '@mcc-agents/protocol';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('store');

/** UI-only metadata. The CLIs' own session files stay the source of truth for history. */
export interface ChatMeta {
  pinned?: boolean;
  archived?: boolean;
  deleted?: boolean;
  taskStage?: 'in-progress' | 'done' | null;
  title?: string;
  lastSeen?: number;
  settings?: ChatSettings;
  /** Created from this UI (Codex threads don't carry our entrypoint reliably). */
  web?: boolean;
}

interface StoreData {
  version: 1;
  meta: Record<string, ChatMeta>;
  projects: Record<string, { archived?: boolean; deleted?: boolean }>;
  limits: Record<string, AgentLimits>;
  /** model id → context window (learned from the CLI). */
  windows: Record<string, number>;
  /** Last settings used for a new chat, per agent. */
  lastSettings: Record<string, ChatSettings>;
  prefs: Prefs;
  tgOffset: number;
  /** Approval messages sent to Telegram: short key → where it points and what was sent. */
  tgMessages: Record<string, TgMessage>;
}

export interface TgMessage {
  chatId: string;
  approvalId: string;
  messageId: number;
  html: string;
  sentAt: number;
}

const file = path.join(config.dataDir, 'state.json');
const DEFAULT_PREFS: Prefs = { telegramDelaySec: 60, voiceModel: 'microsoft/mai-transcribe-2', voiceAutoSend: false, voiceCleanup: true, voiceCleanupModel: 'google/gemini-3.1-flash-lite', voiceTranslate: false };
let data: StoreData = { version: 1, meta: {}, projects: {}, limits: {}, windows: {}, lastSettings: {}, prefs: { ...DEFAULT_PREFS }, tgOffset: 0, tgMessages: {} };
let timer: NodeJS.Timeout | null = null;

export function loadStore() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...data, ...raw, prefs: { ...DEFAULT_PREFS, ...(raw.prefs ?? {}) } };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('cannot read state', e);
  }
}

function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      log.error('cannot write state', e);
    }
  }, 500);
}

export function flushStore() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export const store = {
  project(cwd: string) {
    return data.projects[cwd] ?? {};
  },
  setProject(cwd: string, patch: { archived?: boolean; deleted?: boolean }) {
    data.projects[cwd] = { ...data.projects[cwd], ...patch };
    save();
  },
  meta(id: string): ChatMeta {
    return data.meta[id] ?? {};
  },
  setMeta(id: string, patch: Partial<ChatMeta>) {
    data.meta[id] = { ...data.meta[id], ...patch };
    save();
  },
  limits(): AgentLimits[] {
    return Object.values(data.limits);
  },
  setLimits(l: AgentLimits) {
    data.limits[l.agent] = l;
    save();
  },
  window(model: string | undefined): number | undefined {
    return model ? data.windows[model] : undefined;
  },
  setWindow(model: string, n: number) {
    if (data.windows[model] === n) return;
    data.windows[model] = n;
    save();
  },
  lastSettings(agent: string): ChatSettings {
    return data.lastSettings[agent] ?? {};
  },
  setLastSettings(agent: string, s: ChatSettings) {
    data.lastSettings[agent] = s;
    save();
  },
  prefs(): Prefs {
    return data.prefs;
  },
  setPrefs(p: Partial<Prefs>) {
    data.prefs = { ...data.prefs, ...p };
    save();
  },
  tgOffset(): number {
    return data.tgOffset ?? 0;
  },
  setTgOffset(n: number) {
    data.tgOffset = n;
    save();
  },
  tgMessages(): Record<string, TgMessage> {
    return (data.tgMessages ??= {});
  },
  setTgMessage(key: string, m: TgMessage | null) {
    data.tgMessages ??= {};
    if (m) data.tgMessages[key] = m;
    else delete data.tgMessages[key];
    save();
  },
};
