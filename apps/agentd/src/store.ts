import fs from 'node:fs';
import path from 'node:path';
import type { AgentLimits, ChatSettings } from '@mcc-agents/protocol';
import { config } from './config.ts';
import { logger } from './log.ts';

const log = logger('store');

/** UI-only metadata. The CLIs' own session files stay the source of truth for history. */
export interface ChatMeta {
  pinned?: boolean;
  title?: string;
  lastSeen?: number;
  settings?: ChatSettings;
  /** Created from this UI (Codex threads don't carry our entrypoint reliably). */
  web?: boolean;
}

interface StoreData {
  version: 1;
  meta: Record<string, ChatMeta>;
  limits: Record<string, AgentLimits>;
  /** model id → context window (learned from the CLI). */
  windows: Record<string, number>;
  /** Last settings used for a new chat, per agent. */
  lastSettings: Record<string, ChatSettings>;
}

const file = path.join(config.dataDir, 'state.json');
let data: StoreData = { version: 1, meta: {}, limits: {}, windows: {}, lastSettings: {} };
let timer: NodeJS.Timeout | null = null;

export function loadStore() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = { ...data, ...raw };
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
};
