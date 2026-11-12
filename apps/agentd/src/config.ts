import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const config = {
  version: '0.1.0',
  home,
  /** nginx → agentd (API + WebSocket). Group codeweb, 660. */
  socket: process.env.AGENTD_SOCKET ?? '/run/mcc-agents/agentd.sock',
  /** Owner-only socket for an `ssh -L` tunnel: serves API/WS and proxies the rest to Next. */
  localSocket: process.env.AGENTD_LOCAL_SOCKET ?? '/run/mcc-agents/local.sock',
  /** Optional TCP listener (host:port) — dev only. */
  tcp: process.env.AGENTD_TCP ?? '',
  nextUrl: process.env.AGENTD_NEXT_URL ?? 'http://127.0.0.1:3110',
  dataDir: process.env.AGENTD_DATA ?? path.join(home, '.local/share/mcc-agents'),
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  codexBin: process.env.CODEX_BIN ?? 'codex',
  claudeProjects: path.join(home, '.claude/projects'),
  /** Folders whose sub-folders are offered as projects. */
  projectRoots: (process.env.AGENTD_PROJECT_ROOTS ?? path.join(home, 'dev')).split(':'),
  /** Close an idle Claude process after this long (no turn, no approvals, no background tasks). */
  claudeIdleMs: Number(process.env.AGENTD_CLAUDE_IDLE_MS ?? 20 * 60_000),
  /** Telegram via /usr/local/bin/notify when a chat finishes / needs approval and nobody is looking. */
  notify: process.env.AGENTD_NOTIFY !== '0',
  notifyBin: process.env.AGENTD_NOTIFY_BIN ?? 'notify',
  publicUrl: process.env.AGENTD_PUBLIC_URL ?? 'https://agents.mcc.babochkin.com',
  /** Entrypoint tag written into Claude sessions (makes them visible in `claude --resume`). */
  claudeEntrypoint: 'mcc-agents',
  codexClientName: 'mcc_agents',
  /** Max chars of a tool output sent over the wire inline (full output via /api/output). */
  inlineOutputMax: 24_000,
};

/** Paths the file API may read. */
export function allowedPath(p: string): boolean {
  const abs = path.resolve(p);
  return abs === home || abs.startsWith(home + '/') || abs.startsWith('/tmp/');
}
