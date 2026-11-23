import type { AgentKind } from '@mcc-agents/protocol';

const HOME = '/home/serzhb';

/** Fork / rewind from the web: Claude and Codex; Antigravity's ACP has neither. */
export function canBranch(chatId: string): boolean {
  return !chatId.startsWith('antigravity:');
}

export function shortPath(p: string, cwd?: string): string {
  if (!p) return '';
  if (cwd && (p === cwd || p.startsWith(cwd + '/'))) return p === cwd ? '.' : p.slice(cwd.length + 1);
  if (p === HOME || p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

export function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'сейчас';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} д`;
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function resetIn(unixSec?: number): string {
  if (!unixSec) return '';
  const ms = unixSec * 1000 - Date.now();
  if (ms <= 0) return 'скоро';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 48) return `через ${Math.round(h / 24)} д`;
  if (h > 0) return `через ${h} ч ${m} мин`;
  return `через ${m} мин`;
}

/** Wall-clock moment of a reset: «сегодня в 15:40», «завтра в 09:00», «пн, 18 нояб., 15:40». */
export function resetAt(unixSec?: number): string {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86_400_000);
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  return `${d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
}

export function duration(ms?: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} мс`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} с`;
  return `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`;
}

export function terminalCommand(agent: AgentKind, nativeId: string, cwd: string): string {
  if (agent === 'antigravity') return `cd ${cwd} && agy --conversation ${nativeId}`;
  return agent === 'claude' ? `cd ${cwd} && claude --resume ${nativeId}` : `cd ${cwd} && codex resume ${nativeId}`;
}

/**
 * The CLI's model entry for a settings value. History gives full ids (`claude-opus-5-5`) while the menu has aliases
 * (`opus` = «Opus 5.5») and older versions (`claude-opus-5` = «Opus 5»): match the exact id, then the label
 * («Opus 5.5» ↔ `opus-5-5`), never «contains» — `claude-opus-5-5` would pick «Opus 5».
 */
export function matchModel<T extends { id: string; label: string; isDefault?: boolean }>(models: T[], id?: string): T | undefined {
  if (!id) return undefined;
  const exact = models.find((m) => m.id === id);
  if (exact) return exact;
  const slug = (s: string) => s.toLowerCase().replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/[\s.]+/g, '-');
  const want = slug(id);
  return models.find((m) => m.id !== 'default' && (slug(m.label) === want || slug(m.id) === want));
}
