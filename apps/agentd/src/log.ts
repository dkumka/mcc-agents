/* Minimal structured logging to stdout (journald adds timestamps). */
type Level = 'debug' | 'info' | 'warn' | 'error';
const debugOn = process.env.AGENTD_DEBUG === '1';

function out(level: Level, scope: string, msg: string, extra?: unknown) {
  if (level === 'debug' && !debugOn) return;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.stack ?? extra.message : safe(extra));
  const line = `[${level}] ${scope}: ${msg}${tail}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function safe(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => out('debug', scope, m, e),
    info: (m: string, e?: unknown) => out('info', scope, m, e),
    warn: (m: string, e?: unknown) => out('warn', scope, m, e),
    error: (m: string, e?: unknown) => out('error', scope, m, e),
  };
}
