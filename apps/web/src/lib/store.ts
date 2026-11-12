'use client';

import { useSyncExternalStore } from 'react';
import type {
  AgentKind,
  AgentLimits,
  ApprovalDecision,
  ChatItem,
  ChatSettings,
  ChatState,
  ChatSummary,
  ClientMessage,
  Prefs,
  PrefsState,
  SendPayload,
  ServerMessage,
} from '@mcc-agents/protocol';

export type Route = { kind: 'chat'; chatId: string } | { kind: 'new'; cwd?: string; agent?: AgentKind } | { kind: 'home' };

interface State {
  connected: boolean;
  everConnected: boolean;
  chats: Record<string, ChatSummary>;
  limits: AgentLimits[];
  states: Record<string, ChatState>;
  route: Route;
  prefs: PrefsState | null;
}

type Listener = () => void;

function routeFromUrl(): Route {
  if (typeof window === 'undefined') return { kind: 'home' };
  const u = new URL(window.location.href);
  const chat = u.searchParams.get('chat');
  if (chat) return { kind: 'chat', chatId: chat };
  if (u.searchParams.has('new')) return { kind: 'new', cwd: u.searchParams.get('cwd') ?? undefined, agent: (u.searchParams.get('agent') as AgentKind) ?? undefined };
  return { kind: 'home' };
}

function urlFor(r: Route): string {
  if (r.kind === 'chat') return `/?chat=${encodeURIComponent(r.chatId)}`;
  if (r.kind === 'new') {
    const p = new URLSearchParams({ new: '1' });
    if (r.cwd) p.set('cwd', r.cwd);
    if (r.agent) p.set('agent', r.agent);
    return `/?${p}`;
  }
  return '/';
}

class Store {
  state: State = { connected: false, everConnected: false, chats: {}, limits: [], states: {}, route: { kind: 'home' }, prefs: null };
  private listeners = new Set<Listener>();
  private ws: WebSocket | null = null;
  private retry = 500;
  private subs = new Set<string>();
  private idx: Record<string, Map<string, number>> = {};
  private waitingCreate = new Map<string, (chatId: string | null, err?: string) => void>();
  private pendingDeltas = new Map<string, Map<string, string>>();
  private raf = 0;
  private started = false;
  private visibleChat: string | null = null;
  errorHandler: ((m: string) => void) | null = null;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    this.applyRoute(routeFromUrl(), false);
    window.addEventListener('popstate', () => this.applyRoute(routeFromUrl(), false));
    document.addEventListener('visibilitychange', () => this.sendVisible());
    window.addEventListener('focus', () => this.sendVisible());
    this.connect();
  }

  // ------------------------------------------------------------ routing

  navigate(r: Route, opts: { replace?: boolean } = {}) {
    const url = urlFor(r);
    if (opts.replace) window.history.replaceState(null, '', url);
    else if (window.location.pathname + window.location.search !== url) window.history.pushState(null, '', url);
    this.applyRoute(r, true);
  }

  private applyRoute(r: Route, _push: boolean) {
    const prev = this.state.route;
    if (prev.kind === 'chat' && (r.kind !== 'chat' || r.chatId !== prev.chatId)) this.unsubscribeChat(prev.chatId);
    this.set({ route: r });
    if (r.kind === 'chat') this.subscribeChat(r.chatId);
    this.sendVisible();
  }

  private sendVisible() {
    const r = this.state.route;
    const v = r.kind === 'chat' && document.visibilityState === 'visible' ? r.chatId : null;
    this.visibleChat = v;
    this.send({ t: 'visible', chatId: v });
  }

  // ------------------------------------------------------------ socket

  private connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.set({ connected: true, everConnected: true });
      for (const id of this.subs) this.raw({ t: 'subscribe', chatId: id });
      this.sendVisible();
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('bad message', err);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.set({ connected: false });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
    ws.onerror = () => ws.close();
    // keep the socket from idling out behind proxies; also detect dead links on mobile
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(ping);
      this.raw({ t: 'ping' });
    }, 20_000);
  }

  /** Mobile Safari often keeps a dead socket after sleep — force a reconnect when coming back. */
  wake() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.raw({ t: 'ping' });
    else if (!this.ws) this.connect();
  }

  private raw(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  send(m: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'chats': {
        const chats: Record<string, ChatSummary> = {};
        for (const c of m.chats) chats[c.id] = c;
        this.set({ chats });
        return;
      }
      case 'chat': {
        this.set({ chats: { ...this.state.chats, [m.chat.id]: m.chat } });
        const st = this.state.states[m.chat.id];
        if (st) this.setChatState(m.chat.id, { ...st, summary: m.chat });
        return;
      }
      case 'chatRemoved': {
        const chats = { ...this.state.chats };
        delete chats[m.chatId];
        this.set({ chats });
        return;
      }
      case 'limits':
        this.set({ limits: m.limits });
        return;
      case 'prefs':
        this.set({ prefs: m.prefs });
        return;
      case 'snapshot': {
        const map = new Map<string, number>();
        m.state.items.forEach((it, i) => map.set(it.id, i));
        this.idx[m.chatId] = map;
        this.pendingDeltas.delete(m.chatId);
        this.setChatState(m.chatId, m.state);
        return;
      }
      case 'item':
        this.flushDeltas();
        this.applyItem(m.chatId, m.item);
        return;
      case 'delta': {
        let per = this.pendingDeltas.get(m.chatId);
        if (!per) this.pendingDeltas.set(m.chatId, (per = new Map()));
        per.set(m.itemId, (per.get(m.itemId) ?? '') + m.text);
        if (!this.raf) this.raf = requestAnimationFrame(() => this.flushDeltas());
        return;
      }
      case 'state': {
        const st = this.state.states[m.chatId];
        if (st) this.setChatState(m.chatId, { ...st, ...m.patch });
        return;
      }
      case 'created': {
        const cb = this.waitingCreate.get(m.reqId);
        this.waitingCreate.delete(m.reqId);
        cb?.(m.chatId);
        return;
      }
      case 'error': {
        if (m.reqId && this.waitingCreate.has(m.reqId)) {
          this.waitingCreate.get(m.reqId)?.(null, m.message);
          this.waitingCreate.delete(m.reqId);
          return;
        }
        this.errorHandler?.(m.message);
        return;
      }
      default:
        return;
    }
  }

  private setChatState(id: string, st: ChatState) {
    this.set({ states: { ...this.state.states, [id]: st } });
  }

  private applyItem(chatId: string, item: ChatItem) {
    const st = this.state.states[chatId];
    if (!st) return;
    const map = (this.idx[chatId] ??= new Map());
    const items = st.items.slice();
    const i = map.get(item.id);
    if (i === undefined) {
      map.set(item.id, items.length);
      items.push(item);
    } else items[i] = item;
    this.setChatState(chatId, { ...st, items });
  }

  private flushDeltas() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.pendingDeltas.size) return;
    let states = this.state.states;
    for (const [chatId, per] of this.pendingDeltas) {
      const st = states[chatId];
      const map = this.idx[chatId];
      if (!st || !map) continue;
      const items = st.items.slice();
      for (const [itemId, text] of per) {
        const i = map.get(itemId);
        if (i === undefined) continue;
        const it = items[i];
        if (it.kind === 'assistant' || it.kind === 'thinking') items[i] = { ...it, text: it.text + text };
        else if (it.kind === 'tool') items[i] = { ...it, output: (it.output ?? '') + text };
      }
      states = { ...states, [chatId]: { ...st, items } };
    }
    this.pendingDeltas.clear();
    this.set({ states });
  }

  // ------------------------------------------------------------ actions

  subscribeChat(id: string) {
    this.subs.add(id);
    this.send({ t: 'subscribe', chatId: id });
  }

  unsubscribeChat(id: string) {
    this.subs.delete(id);
    this.send({ t: 'unsubscribe', chatId: id });
    // keep the state cached for instant back-navigation, but drop very large ones
    const st = this.state.states[id];
    if (st && st.items.length > 400) {
      const states = { ...this.state.states };
      delete states[id];
      delete this.idx[id];
      this.set({ states });
    }
  }

  create(agent: AgentKind, cwd: string, settings: ChatSettings, message: SendPayload): Promise<string> {
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      if (!this.send({ t: 'create', reqId, agent, cwd, settings, message })) return reject(new Error('Нет соединения с сервером'));
      const timer = setTimeout(() => {
        this.waitingCreate.delete(reqId);
        reject(new Error('Сервер не ответил'));
      }, 60_000);
      this.waitingCreate.set(reqId, (id, err) => {
        clearTimeout(timer);
        if (id) {
          this.subs.add(id);
          resolve(id);
        } else reject(new Error(err ?? 'Не удалось создать чат'));
      });
    });
  }

  sendMessage(chatId: string, message: SendPayload) {
    return this.send({ t: 'send', chatId, message });
  }

  interrupt(chatId: string) {
    this.send({ t: 'interrupt', chatId });
  }

  decide(chatId: string, decision: ApprovalDecision) {
    // optimistic: hide the card right away
    const st = this.state.states[chatId];
    if (st) this.setChatState(chatId, { ...st, approvals: st.approvals.filter((a) => a.id !== decision.approvalId) });
    this.send({ t: 'decide', chatId, decision });
  }

  setSettings(chatId: string, settings: ChatSettings) {
    const st = this.state.states[chatId];
    if (st) this.setChatState(chatId, { ...st, settings: { ...st.settings, ...settings } });
    this.send({ t: 'settings', chatId, settings });
  }

  stopTask(chatId: string, taskId: string) {
    this.send({ t: 'stopTask', chatId, taskId });
  }

  setPrefs(p: Partial<Prefs>) {
    if (this.state.prefs) this.set({ prefs: { ...this.state.prefs, ...p } });
    this.send({ t: 'prefs', prefs: p });
  }

  meta(chatId: string, m: { pinned?: boolean; title?: string }) {
    this.send({ t: 'meta', chatId, ...m });
  }

  get visible() {
    return this.visibleChat;
  }
}

export const store = new Store();

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => sel(store.state),
    () => sel(store.state),
  );
}
