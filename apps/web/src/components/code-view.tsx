'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type Token = { content: string; color?: string; htmlStyle?: Record<string, string> | string };

const MAX_HIGHLIGHT = 300_000; // bigger files are shown plain: highlighting would stall a phone

const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'make',
  '.env': 'dotenv',
  '.gitignore': 'gitignore',
  '.npmrc': 'ini',
  'nginx.conf': 'nginx',
};
const EXT_ALIAS: Record<string, string> = {
  mjs: 'js',
  cjs: 'js',
  mts: 'ts',
  cts: 'ts',
  conf: 'nginx',
  service: 'ini',
  timer: 'ini',
  env: 'dotenv',
  lock: 'json',
  txt: 'text',
  log: 'log',
};

export function langOf(path: string): string {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  if (NAMES[base]) return NAMES[base];
  if (base.startsWith('.env')) return 'dotenv';
  if (base.startsWith('dockerfile')) return 'dockerfile';
  if (path.includes('/nginx/sites-')) return 'nginx';
  const ext = base.includes('.') ? base.split('.').pop()! : '';
  return EXT_ALIAS[ext] ?? ext ?? 'text';
}

async function tokenize(code: string, lang: string): Promise<Token[][] | null> {
  const shiki = await import('shiki');
  const known = lang in shiki.bundledLanguages;
  if (!known) return null;
  const r = await shiki.codeToTokens(code, {
    lang: lang as never,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  return r.tokens as Token[][];
}

function styleOf(t: Token): React.CSSProperties | undefined {
  if (t.htmlStyle && typeof t.htmlStyle === 'object') return t.htmlStyle as React.CSSProperties;
  return t.color ? { color: t.color } : undefined;
}

/** Source view with line numbers, optional wrapping and Shiki highlighting (light/dark). */
export function CodeView({ code, path, wrap, className }: { code: string; path: string; wrap: boolean; className?: string }) {
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    setTokens(null);
    if (!code || code.length > MAX_HIGHLIGHT) return;
    let off = false;
    tokenize(code, langOf(path))
      .then((t) => !off && setTokens(t))
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [code, path]);

  const lines = tokens ?? code.split('\n').map((l) => [{ content: l }] as Token[]);
  return (
    <div className={cn('shiki-view font-mono text-[12px] leading-[1.6]', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="align-top">
              <td className="sticky left-0 w-0 select-none bg-background pl-3 pr-3 text-right text-[10.5px] leading-[1.83] text-muted-foreground/50 tabular">{i + 1}</td>
              <td className={cn('pr-3', wrap ? 'whitespace-pre-wrap break-anywhere' : 'whitespace-pre')}>
                {line.length ? line.map((t, j) => (
                  <span key={j} style={styleOf(t)}>
                    {t.content}
                  </span>
                )) : ' '}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
