'use client';

import { useSyncExternalStore } from 'react';

export type PanelTab = 'changes' | 'files' | 'tasks';

/** A file opened in the full-screen viewer. */
export interface ViewerFile {
  path: string;
  name?: string;
  size?: number;
  mediaType?: string;
  /** Low-res copy we already have (data: URL of a just-sent image) — shown while the original loads. */
  preview?: string;
}

/** «Форк» dialog: branch `chatId` before the user message `beforeItemId` (whose text goes into the new chat's field). */
export interface ForkRequest {
  chatId: string;
  beforeItemId?: string;
  text?: string;
}

interface UiState {
  fork: ForkRequest | null;
  panel: PanelTab | null;
  /** Wrap long lines in the side panel (files, diffs). */
  wrap: boolean;
  viewer: ViewerFile | null;
}

let state: UiState = { fork: null, panel: null, wrap: true, viewer: null };
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
  openFile(f: ViewerFile) {
    ui.set({ viewer: f });
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
