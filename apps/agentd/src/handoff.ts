import fs from 'node:fs';
import path from 'node:path';
import type { ChatSummary } from '@mcc-agents/protocol';
import { sessionFile } from './claude/sessions.ts';
import { config } from './config.ts';

/** Codex keeps a thread as ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl. */
function codexRollout(threadId: string): string | undefined {
  const root = path.join(process.env.CODEX_HOME ?? path.join(config.home, '.codex'), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const walk = (dir: string, depth: number): string | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    // newest first: a recent chat is found without walking the whole history
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name.endsWith(suffix)) return p;
      if (e.isDirectory() && depth < 3) {
        const hit = walk(p, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(root, 0);
}

/**
 * GET /api/session-file?chatId= → where the CLI stores this chat's full history, for «Продолжить в другом агенте»:
 * the other agent reads the file itself (formats differ, so there is no real cross-agent fork).
 */
export function sessionFileOf(chat: ChatSummary): string | undefined {
  const file = chat.agent === 'claude' ? sessionFile(chat.nativeId) : codexRollout(chat.nativeId);
  return file && fs.existsSync(file) ? file : undefined;
}
