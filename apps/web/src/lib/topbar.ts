'use client';

import { useSyncExternalStore } from 'react';

/**
 * Experiment for the iOS home-screen app: iOS 26+/27 blurs the top edge over web content (Liquid Glass scroll edge
 * effect) and the blur reaches the header text. Which layout avoids it can only be checked on a real phone, so the
 * user picks a variant in Settings. Stored in the `mcc_topbar` cookie → <html data-topbar> is set by the server.
 *   flow  — as before (header in the page flow below the status bar)
 *   fixed — a fixed, opaque bar exactly under the status bar (Safari treats it as the page's own top bar)
 *   pad   — extra top padding so the header text sits below the blurred zone
 */
export type TopbarMode = 'flow' | 'fixed' | 'pad';

const listeners = new Set<() => void>();

function current(): TopbarMode {
  const v = document.documentElement.dataset.topbar;
  return v === 'fixed' || v === 'pad' ? v : 'flow';
}

export function setTopbar(m: TopbarMode) {
  document.documentElement.dataset.topbar = m;
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  document.cookie = `mcc_topbar=${m}; path=/; max-age=31536000; samesite=lax${secure}`;
  for (const l of listeners) l();
}

export function useTopbar(): [TopbarMode, (m: TopbarMode) => void] {
  const m = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
    () => 'flow' as TopbarMode,
  );
  return [m, setTopbar];
}
