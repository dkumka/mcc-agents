import { toLogin } from '@/lib/auth';
import type { AgentCapabilities, AgentKind, DirEntry, GitStatus, ProjectInfo } from '@mcc-agents/protocol';

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const r = await fetch(`/api/${path}${q.size ? `?${q}` : ''}`, { cache: 'no-store' });
  if (r.status === 401) toLogin();
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body as T;
}

export const api = {
  projects: () => get<ProjectInfo[]>('projects'),
  caps: (agent: AgentKind, cwd?: string) => get<AgentCapabilities>('caps', { agent, cwd }),
  files: (cwd: string, q: string) => get<string[]>('files', { cwd, q }),
  ls: (path: string) => get<DirEntry[]>('ls', { path }),
  file: (path: string) => get<{ path: string; content: string; size: number; truncated: boolean; binary: boolean }>('file', { path }),
  git: (cwd: string) => get<GitStatus>('git', { cwd }),
  output: (chatId: string, itemId: string) => get<{ output: string }>('output', { chatId, itemId }),
  taskOutput: (chatId: string, taskId: string) => get<{ output: string; file: string }>('task-output', { chatId, taskId }),
};

const capsCache = new Map<string, { at: number; p: Promise<AgentCapabilities> }>();
export function capsCached(agent: AgentKind, cwd?: string) {
  const key = `${agent}|${cwd ?? ''}`;
  const hit = capsCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p;
  const p = api.caps(agent, cwd);
  p.catch(() => capsCache.delete(key));
  capsCache.set(key, { at: Date.now(), p });
  return p;
}
