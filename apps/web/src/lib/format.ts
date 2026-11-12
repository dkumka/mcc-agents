const HOME = '/home/serzhb';

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

export function duration(ms?: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} мс`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} с`;
  return `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с`;
}

export function terminalCommand(agent: 'claude' | 'codex', nativeId: string, cwd: string): string {
  return agent === 'claude' ? `cd ${cwd} && claude --resume ${nativeId}` : `cd ${cwd} && codex resume ${nativeId}`;
}
