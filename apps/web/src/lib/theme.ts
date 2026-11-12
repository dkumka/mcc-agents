'use client';

import { useSyncExternalStore } from 'react';

/**
 * Two themes only (light by default, dark on demand). The choice lives in the `theme` cookie,
 * shared by all *.mcc.babochkin.com sites, so the server renders the right class — no flash.
 */
export type Theme = 'light' | 'dark';

const listeners = new Set<() => void>();

function current(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function setTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.style.colorScheme = t;
  const host = window.location.hostname;
  const domain = host.endsWith('.mcc.babochkin.com') || host === 'mcc.babochkin.com' ? '; domain=.mcc.babochkin.com' : '';
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `theme=${t}; path=/; max-age=31536000; samesite=lax${domain}${secure}`;
  for (const l of listeners) l();
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    () => 'light' as Theme,
  );
  return [t, setTheme];
}
