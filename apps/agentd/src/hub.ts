import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentCapabilities,
  AgentKind,
  AgentLimits,
  Approval,
  ApprovalDecision,
  ChatSettings,
  ChatSummary,
  ClientMessage,
  ProjectInfo,
  SendPayload,
  ServerMessage,
  UserItem,
} from '@mcc-agents/protocol';
import { Chat, type ChatSink } from './chat.ts';
import { config } from './config.ts';
import { logger } from './log.ts';
import { store } from './store.ts';

const log = logger('hub');

export interface Adapter {
  readonly agent: AgentKind;
  list(): Promise<ChatSummary[]>;
  load(chat: Chat): Promise<void>;
  prepare(cwd: string, settings: ChatSettings): Promise<string>;
  send(chat: Chat, message: SendPayload, uuid: string, isNew: boolean): Promise<void>;
  interrupt(chat: Chat): Promise<void>;
  decide(chat: Chat, d: ApprovalDecision): Promise<void>;
  applySettings(chat: Chat, s: ChatSettings): Promise<void>;
  stopTask(chat: Chat, taskId: string): Promise<void>;
  release(chat: Chat): Promise<void>;
  capabilities(cwd: string): Promise<AgentCapabilities>;
  isLive(chat: Chat): boolean;
  shutdown(): void;
}

export interface Client {
  id: number;
  send(msg: ServerMessage): void;
  subs: Set<string>;
  visible: string | null;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

export class Hub implements ChatSink {
  adapters = {} as Record<AgentKind, Adapter>;
  private chats = new Map<string, Chat>();
  private clients = new Set<Client>();
  private pendingSummary = new Set<string>();
  private summaryTimer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshSoon: NodeJS.Timeout | null = null;
  private lastNotify = new Map<string, number>();
  private listErrors: Partial<Record<AgentKind, string>> = {};

  register(a: Adapter) {
    this.adapters[a.agent] = a;
  }

  peek(id: string): Chat | undefined {
    return this.chats.get(id);
  }

  // ------------------------------------------------------------ chat list

  private decorate(s: ChatSummary): ChatSummary {
    const meta = store.meta(s.id);
    const out = { ...s };
    if (meta.title) out.title = meta.title;
    out.pinned = !!meta.pinned;
    if (meta.web && out.origin !== 'web') out.origin = 'web';
    out.unread = meta.lastSeen !== undefined && out.updatedAt > meta.lastSeen + 3000 && out.status === 'idle';
    return out;
  }

  summaries(): ChatSummary[] {
    return [...this.chats.values()].map((c) => this.decorate(c.summary)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      for (const a of Object.values(this.adapters)) {
        let list: ChatSummary[];
        try {
          list = await a.list();
          delete this.listErrors[a.agent];
        } catch (e) {
          this.listErrors[a.agent] = (e as Error).message;
          log.warn(`list ${a.agent}`, e);
          continue;
        }
        const ids = new Set(list.map((s) => s.id));
        for (const s of list) {
          const chat = this.chats.get(s.id);
          if (!chat) {
            this.chats.set(s.id, new Chat(s, this));
            this.summaryChanged(this.chats.get(s.id)!);
            continue;
          }
          const live = a.isLive(chat);
          const p: Partial<ChatSummary> = { title: s.title, cwd: s.cwd || chat.summary.cwd, model: s.model ?? chat.summary.model };
          if (s.updatedAt > chat.summary.updatedAt) p.updatedAt = s.updatedAt;
          if (!live) p.status = s.status;
          if (chat.summary.origin !== 'web') p.origin = s.origin;
          chat.setSummary(p);
        }
        // chats that vanished from disk (deleted) and are not live
        for (const [id, chat] of this.chats) {
          if (chat.agent === a.agent && !ids.has(id) && !a.isLive(chat) && Date.now() - chat.summary.createdAt > 120_000) {
            this.chats.delete(id);
            this.broadcast({ t: 'chatRemoved', chatId: id });
          }
        }
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  scheduleRefresh() {
    if (this.refreshSoon) return;
    this.refreshSoon = setTimeout(() => {
      this.refreshSoon = null;
      this.refresh().catch(() => {});
    }, 1500);
  }

  projects(): ProjectInfo[] {
    const map = new Map<string, ProjectInfo>();
    const add = (p: string, at: number, count: number) => {
      const cur = map.get(p);
      if (cur) {
        cur.lastActivity = Math.max(cur.lastActivity, at);
        cur.chatCount += count;
      } else map.set(p, { path: p, name: path.basename(p) || p, lastActivity: at, chatCount: count, isGit: false });
    };
    for (const root of config.projectRoots) {
      try {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (d.isDirectory() && !d.name.startsWith('.')) add(path.join(root, d.name), 0, 0);
        }
      } catch {}
    }
    for (const c of this.chats.values()) if (c.cwd && fs.existsSync(c.cwd)) add(c.cwd, c.summary.updatedAt, 1);
    for (const p of map.values()) p.isGit = fs.existsSync(path.join(p.path, '.git'));
    return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
  }

  status() {
    let busy = 0;
    for (const c of this.chats.values()) {
      const s = c.summary.status;
      if (s === 'running' || s === 'waiting' || s === 'starting' || c.state.tasks.some((t) => t.status === 'running')) busy++;
    }
    return { listErrors: this.listErrors, chats: this.chats.size, clients: this.clients.size, busy };
  }

  // ------------------------------------------------------------ ChatSink

  toSubscribers(chat: Chat, msg: ServerMessage) {
    for (const c of this.clients) if (c.subs.has(chat.id)) c.send(msg);
  }

  summaryChanged(chat: Chat) {
    this.pendingSummary.add(chat.id);
    if (this.summaryTimer) return;
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = null;
      const ids = [...this.pendingSummary];
      this.pendingSummary.clear();
      for (const id of ids) {
        const c = this.chats.get(id);
        if (c) this.broadcast({ t: 'chat', chat: this.decorate(c.summary) });
      }
    }, 150);
  }

  private visibleTo(chat: Chat) {
    for (const c of this.clients) if (c.visible === chat.id) return true;
    return false;
  }

  turnFinished(chat: Chat, outcome: 'done' | 'error' | 'interrupted') {
    if (this.visibleTo(chat)) {
      store.setMeta(chat.id, { lastSeen: Date.now() + 5000 });
    } else if (outcome !== 'interrupted') {
      this.notify(chat, outcome === 'done' ? '✅ Готово' : '⚠️ Ошибка');
    }
    this.summaryChanged(chat);
  }

  approvalAdded(chat: Chat, a: Approval) {
    if (!this.visibleTo(chat)) this.notify(chat, `✋ Нужно подтверждение: ${a.title.slice(0, 120)}`);
  }

  private notify(chat: Chat, what: string) {
    if (!config.notify) return;
    const last = this.lastNotify.get(chat.id) ?? 0;
    if (Date.now() - last < 20_000) return;
    this.lastNotify.set(chat.id, Date.now());
    const text = `${what}\n${AGENT_LABEL[chat.agent]} · ${chat.summary.title.slice(0, 100)}\n${config.publicUrl}/?chat=${encodeURIComponent(chat.id)}`;
    try {
      const p = spawn(config.notifyBin, [text], { stdio: 'ignore' });
      p.on('error', (e) => log.warn('notify failed', e));
    } catch (e) {
      log.warn('notify failed', e);
    }
  }

  setLimits(l: AgentLimits) {
    store.setLimits(l);
    this.broadcast({ t: 'limits', limits: store.limits() });
  }

  // ------------------------------------------------------------ clients

  addClient(c: Client) {
    this.clients.add(c);
    c.send({ t: 'hello', version: config.version, host: process.env.HOSTNAME ?? 'mcc' });
    c.send({ t: 'chats', chats: this.summaries() });
    c.send({ t: 'limits', limits: store.limits() });
  }

  removeClient(c: Client) {
    this.clients.delete(c);
  }

  private broadcast(msg: ServerMessage) {
    for (const c of this.clients) c.send(msg);
  }

  async ensureLoaded(chat: Chat) {
    if (chat.loaded) return;
    if (!chat.loading) {
      chat.loading = this.adapters[chat.agent]
        .load(chat)
        .then(() => {
          chat.loaded = true;
        })
        .finally(() => {
          chat.loading = null;
        });
    }
    await chat.loading;
  }

  private need(id: string): Chat {
    const c = this.chats.get(id);
    if (!c) throw new Error('чат не найден');
    return c;
  }

  private userItem(id: string, m: SendPayload): UserItem {
    return {
      kind: 'user',
      id,
      ts: Date.now(),
      text: m.text,
      images: m.images?.length
        ? m.images.map((i) => ({ mediaType: i.mediaType, name: i.name, dataUrl: i.data.length < 600_000 ? `data:${i.mediaType};base64,${i.data}` : undefined }))
        : undefined,
    };
  }

  async handle(client: Client, msg: ClientMessage) {
    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong' });
        return;
      case 'subscribe': {
        const chat = this.need(msg.chatId);
        client.subs.add(chat.id);
        try {
          await this.ensureLoaded(chat);
        } catch (e) {
          chat.state.error = `Не удалось загрузить историю: ${(e as Error).message}`;
        }
        if (client.subs.has(chat.id)) client.send({ t: 'snapshot', chatId: chat.id, state: { ...chat.snapshot(), summary: this.decorate(chat.summary) } });
        return;
      }
      case 'unsubscribe':
        client.subs.delete(msg.chatId);
        return;
      case 'visible':
        client.visible = msg.chatId;
        if (msg.chatId && this.chats.has(msg.chatId)) this.seen(msg.chatId);
        return;
      case 'seen':
        this.seen(msg.chatId);
        return;
      case 'create': {
        const adapter = this.adapters[msg.agent];
        if (!adapter) throw new Error('неизвестный агент');
        if (!msg.cwd || !fs.existsSync(msg.cwd)) throw new Error(`папка не найдена: ${msg.cwd}`);
        const settings: ChatSettings = { ...msg.settings };
        const nativeId = await adapter.prepare(msg.cwd, settings);
        const id = `${msg.agent}:${nativeId}`;
        const now = Date.now();
        const firstLine = msg.message.text.trim().split('\n')[0] || 'Новый чат';
        const chat = new Chat(
          { id, agent: msg.agent, nativeId, cwd: msg.cwd, title: firstLine.slice(0, 100), createdAt: now, updatedAt: now, status: 'starting', origin: 'web', model: settings.model },
          this,
        );
        chat.loaded = true;
        chat.state.settings = settings;
        this.chats.set(id, chat);
        store.setMeta(id, { web: true, settings, lastSeen: now });
        store.setLastSettings(msg.agent, settings);
        client.subs.add(id);
        client.visible = id;
        this.summaryChanged(chat);
        client.send({ t: 'created', reqId: msg.reqId, chatId: id });
        client.send({ t: 'snapshot', chatId: id, state: { ...chat.snapshot(), summary: this.decorate(chat.summary) } });
        const uuid = randomUUID();
        chat.upsert(this.userItem(uuid, msg.message));
        try {
          await adapter.send(chat, msg.message, uuid, true);
        } catch (e) {
          chat.notice('error', (e as Error).message);
          chat.setStatus('error');
        }
        return;
      }
      case 'send': {
        const chat = this.need(msg.chatId);
        await this.ensureLoaded(chat);
        const uuid = randomUUID();
        chat.upsert(this.userItem(uuid, msg.message));
        this.seen(chat.id);
        try {
          await this.adapters[chat.agent].send(chat, msg.message, uuid, false);
        } catch (e) {
          chat.notice('error', (e as Error).message);
          if (chat.summary.status === 'starting' || chat.summary.status === 'running') chat.setStatus('idle');
        }
        return;
      }
      case 'interrupt':
        await this.adapters[this.need(msg.chatId).agent].interrupt(this.need(msg.chatId));
        return;
      case 'decide': {
        const chat = this.need(msg.chatId);
        await this.adapters[chat.agent].decide(chat, msg.decision);
        return;
      }
      case 'settings': {
        const chat = this.need(msg.chatId);
        const next = { ...chat.state.settings, ...msg.settings };
        await this.adapters[chat.agent].applySettings(chat, msg.settings);
        chat.patch({ settings: next });
        store.setMeta(chat.id, { settings: next });
        store.setLastSettings(chat.agent, next);
        return;
      }
      case 'stopTask': {
        const chat = this.need(msg.chatId);
        await this.adapters[chat.agent].stopTask(chat, msg.taskId);
        return;
      }
      case 'meta': {
        const chat = this.need(msg.chatId);
        const patch: { pinned?: boolean; title?: string } = {};
        if (msg.pinned !== undefined) patch.pinned = msg.pinned;
        if (msg.title !== undefined) patch.title = msg.title.trim() || undefined;
        store.setMeta(chat.id, patch);
        this.summaryChanged(chat);
        return;
      }
      case 'release': {
        const chat = this.need(msg.chatId);
        await this.adapters[chat.agent].release(chat);
        return;
      }
    }
  }

  private seen(id: string) {
    const chat = this.chats.get(id);
    if (!chat) return;
    const wasUnread = this.decorate(chat.summary).unread;
    store.setMeta(id, { lastSeen: Date.now() });
    if (wasUnread) this.summaryChanged(chat);
  }

  /** Free memory of chats nobody looks at; let idle Codex threads go. */
  sweep() {
    const now = Date.now();
    for (const chat of this.chats.values()) {
      if (!chat.loaded) continue;
      let watched = false;
      for (const c of this.clients) if (c.subs.has(chat.id)) watched = true;
      if (watched || now - chat.lastActivity < 10 * 60_000) continue;
      const a = this.adapters[chat.agent];
      if (chat.agent === 'codex' && a.isLive(chat) && chat.summary.status === 'idle') {
        a.release(chat).catch(() => {});
        continue;
      }
      if (!a.isLive(chat)) {
        chat.resetItems([]);
        chat.loaded = false;
      }
    }
  }

  shutdown() {
    for (const a of Object.values(this.adapters)) a.shutdown();
  }
}
