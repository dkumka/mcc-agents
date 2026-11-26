'use client';

import { useSyncExternalStore } from 'react';
import type { ChatMode } from '@mcc-agents/protocol';

export type PanelTab = 'changes' | 'files' | 'tasks';

/** A file opened in the full-screen viewer. */
export interface ViewerFile {
  path: string;
  name?: string;
  size?: number;
  mediaType?: string;
  /** Low-res copy we already have (data: URL of a just-sent image) — shown while the original loads. */
  preview?: string;
  /** Mentioned by an agent: if `path` is missing, look for the same name in this folder… */
  cwd?: string;
  /** …and, for a bare name (`README.md`), open the only match. */
  bare?: boolean;
  /** Paths with the same name this chat already touched. */
  hints?: string[];
  /** Paths the chat touched, newest first: their repositories are where a relative path is tried next. */
  touched?: string[];
  /** The path as written, when relative (`models/partner.js`). */
  rel?: string;
}

/** «Форк» dialog: branch `chatId` before the user message `beforeItemId` (whose text goes into the new chat's field). */
export interface ForkRequest {
  chatId: string;
  beforeItemId?: string;
  text?: string;
}

interface UiState {
  fork: ForkRequest | null;
  /** «Продолжить в другом агенте» for this chat; `project` — «Перенести в проект» (a conversation goes on in a project folder). */
  handoff: { chatId: string; project?: boolean } | null;
  panel: PanelTab | null;
  /** Wrap long lines in the side panel (files, diffs). */
  wrap: boolean;
  panelFile: string | null;
  viewer: ViewerFile | null;
  /** Show the agent's steps (thinking, commands) in full, per mode; off — each turn's steps fold into one line. */
  work: Record<ChatMode, boolean>;
}

let state: UiState = { fork: null, handoff: null, panel: null, wrap: true, panelFile: null, viewer: null, work: { chat: false, code: true } };
if (typeof window !== 'undefined') {
  state.wrap = localStorage.getItem('panelWrap') !== '0';
  try {
    state.work = { ...state.work, ...JSON.parse(localStorage.getItem('showWork') ?? '{}') };
  } catch {}
}
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
  toggleWork(mode: ChatMode) {
    ui.set({ work: { ...state.work, [mode]: !state.work[mode] } });
    try {
      localStorage.setItem('showWork', JSON.stringify(state.work));
    } catch {}
  },
  openFile(f: ViewerFile) {
    ui.set({ viewer: f });
  },
  previewFile(path: string) {
    ui.set({ panel: 'files', panelFile: path });
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
