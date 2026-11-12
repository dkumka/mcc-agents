'use client';

import { useSyncExternalStore } from 'react';

export type PanelTab = 'changes' | 'files' | 'tasks';

interface UiState {
  panel: PanelTab | null;
  /** Wrap long lines in the side panel (files, diffs). */
  wrap: boolean;
}

let state: UiState = { panel: null, wrap: true };
if (typeof window !== 'undefined') state.wrap = localStorage.getItem('panelWrap') !== '0';
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(p: Partial<UiState>) {
    state = { ...state, ...p };
    for (const l of listeners) l();
  },
  toggleWrap() {
    ui.set({ wrap: !state.wrap });
    localStorage.setItem('panelWrap', state.wrap ? '1' : '0');
  },
  togglePanel(tab: PanelTab) {
    ui.set({ panel: state.panel === tab ? null : tab });
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useUi<T>(sel: (s: UiState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => sel(state), () => sel(state));
}
