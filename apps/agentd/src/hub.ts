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
  PrefsState,
  ProjectInfo,
  SendPayload,
  ServerMessage,
  UserItem,
} from '@mcc-agents/protocol';
import { Chat, type ChatSink } from './chat.ts';
import { CHAT_ROOT, isChatDir, newChatDir } from './chat-dirs.ts';
import { config } from './config.ts';
import { logger } from './log.ts';
import { handoffFile, handoffMessage } from './handoff.ts';
import { store, type ChatMeta } from './store.ts';
import { TelegramBridge } from './telegram.ts';
import { TgApprovals } from './tg-approvals.ts';
import { textWithFiles } from './uploads.ts';
import { cleanupModel, openrouterKey, voiceModel } from './voice.ts';
import { CLEANUP_MODELS, VOICE_MODELS } from '@mcc-agents/protocol';

const log = logger('hub');

export interface Adapter {
  readonly agent: AgentKind;
  list(): Promise<ChatSummary[]>;
  load(chat: Chat): Promise<void>;
  prepare(cwd: string, settings: ChatSettings): Promise<string>;
  /** Copy the dialogue into a new session (up to, not including, the user message `beforeItemId`); returns its native id. */
  fork(chat: Chat, title: string, beforeItemId?: string): Promise<string>;
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

const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

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
  readonly tg = new TelegramBridge();
  readonly tga: TgApprovals;

  constructor() {
    this.tga = new TgApprovals(this.tg, {
      peek: (id) => this.chats.get(id),
      decideFrom: (chat, d) => this.adapters[chat.agent].decide(chat, d),
    });
  }

  /** Start the Telegram bridge (reads ~/secrets) and tidy messages left from a previous run. */
  startTelegram() {
    if (!config.telegram) return;
    this.tg.reload();
    this.tga.markStale().catch(() => {});
  }

  /** Called periodically: pick up a token added with secret-set without a restart. */
  tick() {
    if (!config.telegram) return;
    const before = this.tg.ready;
    this.tg.maybeReload();
    if (before !== this.tg.ready) this.broadcast({ t: 'prefs', prefs: this.prefsState() });
  }

  prefsState(): PrefsState {
    return { ...store.prefs(), voiceModel: voiceModel(), voiceCleanupModel: cleanupModel(), telegramReady: this.tg.ready, voiceReady: !!openrouterKey() };
  }

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
    out.mode = isChatDir(out.cwd) ? 'chat' : 'code';
    if (meta.web && out.origin !== 'web') out.origin = 'web';
    if (meta.forkOf) out.forkOf = meta.forkOf;
    if (meta.rewoundFrom) out.rewoundFrom = meta.rewoundFrom;
    if (meta.hidden) out.hidden = true;
    if (meta.archived) out.archived = true;
    if (meta.notifyDone) out.notifyDone = true;
    if (meta.handoffFrom) out.handoffFrom = meta.handoffFrom;
    if (meta.handoffTo) out.handoffTo = meta.handoffTo;
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
    // conversations (~/chat/…) are not projects
    for (const c of this.chats.values()) if (c.cwd && !isChatDir(c.cwd) && fs.existsSync(c.cwd)) add(c.cwd, c.summary.updatedAt, 1);
    map.delete(CHAT_ROOT);
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

  /**
   * No «Готово» in Telegram by default — only questions/approvals that wait for an answer (tg-approvals).
   * «Сообщить, когда закончит» (meta.notifyDone) asks for one message about the end of the turn; it switches off then.
   */
  turnFinished(chat: Chat, outcome: 'done' | 'error' | 'interrupted') {
    const asked = !!store.meta(chat.id).notifyDone;
    if (this.visibleTo(chat)) {
      store.setMeta(chat.id, { lastSeen: Date.now() + 5000 });
    } else if (asked && outcome !== 'interrupted') {
      this.notify(chat, outcome === 'done' ? '✅ Готово' : '⚠️ Ошибка', true);
    }
    if (asked && outcome !== 'interrupted') store.setMeta(chat.id, { notifyDone: undefined });
    this.summaryChanged(chat);
  }

  approvalAdded(chat: Chat, a: Approval) {
    // with the agents' bot: interactive message after the configured delay; without it — the old plain notice
    if (this.tga.active) this.tga.added(chat, a);
    else if (!this.visibleTo(chat)) this.notify(chat, `✋ Нужно подтверждение: ${a.title.slice(0, 120)}`);
  }

  approvalRemoved(chat: Chat, approvalId: string) {
    this.tga.removed(chat, approvalId);
  }

  private notify(chat: Chat, what: string, force = false) {
    if (!config.notify) return;
    const last = this.lastNotify.get(chat.id) ?? 0;
    if (!force && Date.now() - last < 20_000) return;
    this.lastNotify.set(chat.id, Date.now());
    log.info(`notify ${chat.id}: ${what}`);
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
    c.send({ t: 'prefs', prefs: this.prefsState() });
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
      files: m.files?.length ? m.files : undefined,
    };
  }

  /** A new chat: prepare the CLI session, show it, send the first message. Returns the chat id. */
  private async startChat(
    client: Client,
    o: { reqId: string; agent: AgentKind; cwd: string; settings: ChatSettings; message: SendPayload; title?: string; meta?: Partial<ChatMeta> },
  ): Promise<string> {
    const adapter = this.adapters[o.agent];
    const settings: ChatSettings = { ...o.settings };
    const nativeId = await adapter.prepare(o.cwd, settings);
    const id = `${o.agent}:${nativeId}`;
    const now = Date.now();
    const firstLine = o.message.text.trim().split('\n')[0] || 'Новый чат';
    const chat = new Chat(
      { id, agent: o.agent, nativeId, cwd: o.cwd, title: (o.title ?? firstLine).slice(0, 100), createdAt: now, updatedAt: now, status: 'starting', origin: 'web', model: settings.model },
      this,
    );
    chat.loaded = true;
    chat.state.settings = settings;
    this.chats.set(id, chat);
    store.setMeta(id, { web: true, settings, lastSeen: now, ...(o.title ? { title: o.title } : {}), ...o.meta });
    store.setLastSettings(o.agent, settings);
    client.subs.add(id);
    client.visible = id;
    this.summaryChanged(chat);
    client.send({ t: 'created', reqId: o.reqId, chatId: id });
    client.send({ t: 'snapshot', chatId: id, state: { ...chat.snapshot(), summary: this.decorate(chat.summary) } });
    const uuid = randomUUID();
    chat.upsert(this.userItem(uuid, o.message));
    try {
      await adapter.send(chat, { ...o.message, text: textWithFiles(o.message), files: undefined }, uuid, true);
    } catch (e) {
      chat.notice('error', (e as Error).message);
      chat.setStatus('error');
    }
    return id;
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
        if (msg.mode === 'chat') msg.cwd = newChatDir();
        else if (!msg.cwd || !fs.existsSync(msg.cwd)) throw new Error(`папка не найдена: ${msg.cwd}`);
        await this.startChat(client, { reqId: msg.reqId, agent: msg.agent, cwd: msg.cwd, settings: msg.settings, message: msg.message });
        return;
      }
      case 'handoff': {
        const src = this.need(msg.chatId);
        if (!this.adapters[msg.agent]) throw new Error('неизвестный агент');
        if (src.summary.status === 'running' || src.summary.status === 'starting' || src.summary.status === 'waiting')
          throw new Error('Агент ещё работает — дождитесь конца ответа или остановите его');
        if (!src.cwd || !fs.existsSync(src.cwd)) throw new Error(`папка чата не найдена: ${src.cwd}`);
        // the history comes from disk (Claude .jsonl / Codex turns / agy session/load): the old agent's limits are not spent
        await this.ensureLoaded(src);
        const title = this.decorate(src.summary).title;
        const file = await handoffFile(src, title);
        log.info(`handoff ${src.id} → ${msg.agent} (${src.state.items.length} items, ${file.size} B)`);
        const id = await this.startChat(client, {
          reqId: msg.reqId,
          agent: msg.agent,
          cwd: src.cwd, // a conversation (~/chat/…) goes on in its own folder too
          settings: msg.settings,
          message: { text: handoffMessage(src.agent, title, src.cwd, msg.note), files: [file] },
          title,
          meta: { handoffFrom: src.id },
        });
        store.setMeta(src.id, { handoffTo: id });
        this.summaryChanged(src);
        return;
      }
      case 'fork': {
        const src = this.need(msg.chatId);
        if (src.summary.status === 'running' || src.summary.status === 'starting' || src.summary.status === 'waiting')
          throw new Error('Агент ещё работает — дождитесь конца ответа или остановите его');
        const title = msg.title.trim().slice(0, 140) || src.summary.title;
        const nativeId = await this.adapters[src.agent].fork(src, title, msg.beforeItemId);
        const id = `${src.agent}:${nativeId}`;
        await this.refresh();
        if (!this.chats.has(id)) {
          // not listed yet (Codex may index a moment later): show it right away
          const now = Date.now();
          this.chats.set(id, new Chat({ ...src.summary, id, nativeId, title, createdAt: now, updatedAt: now, status: 'idle', origin: 'web' }, this));
        }
        const srcMeta = store.meta(src.id);
        store.setMeta(id, {
          web: true,
          title,
          settings: srcMeta.settings ?? src.state.settings,
          lastSeen: Date.now(),
          ...(msg.rewind ? { rewoundFrom: src.id } : { forkOf: src.id }),
        });
        if (msg.rewind) store.setMeta(src.id, { hidden: true });
        log.info(`${msg.rewind ? 'rewind' : 'fork'} ${src.id} → ${id}${msg.beforeItemId ? ` before ${msg.beforeItemId}` : ''}`);
        this.summaryChanged(this.chats.get(id)!);
        this.summaryChanged(src);
        client.send({ t: 'created', reqId: msg.reqId, chatId: id });
        return;
      }
      case 'unrewind': {
        const chat = this.need(msg.chatId);
        const orig = store.meta(chat.id).rewoundFrom;
        if (!orig || !this.chats.has(orig)) throw new Error('исходный чат не найден');
        store.setMeta(orig, { hidden: false });
        store.setMeta(chat.id, { hidden: true });
        log.info(`unrewind ${chat.id} → ${orig}`);
        this.summaryChanged(this.chats.get(orig)!);
        this.summaryChanged(chat);
        return;
      }
      case 'send': {
        const chat = this.need(msg.chatId);
        // writing to an archived chat brings it back to the list
        if (store.meta(chat.id).archived) {
          store.setMeta(chat.id, { archived: undefined });
          this.summaryChanged(chat);
        }
        await this.ensureLoaded(chat);
        const uuid = randomUUID();
        chat.upsert(this.userItem(uuid, msg.message));
        this.seen(chat.id);
        try {
          await this.adapters[chat.agent].send(chat, { ...msg.message, text: textWithFiles(msg.message), files: undefined }, uuid, false);
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
        const a = chat.state.approvals.find((x) => x.id === msg.decision.approvalId);
        this.tga.record(chat.id, msg.decision, 'web', a);
        await this.adapters[chat.agent].decide(chat, msg.decision);
        return;
      }
      case 'prefs': {
        const p = msg.prefs;
        if (p.telegramDelaySec !== undefined) {
          const n = Math.round(Number(p.telegramDelaySec));
          if (!Number.isFinite(n) || n < 0 || n > 24 * 3600) throw new Error('неверная задержка');
          store.setPrefs({ telegramDelaySec: n });
        }
        if (p.voiceModel !== undefined) {
          if (!VOICE_MODELS.some((v) => v.id === p.voiceModel)) throw new Error('неизвестная модель распознавания');
          store.setPrefs({ voiceModel: p.voiceModel });
        }
        if (p.voiceAutoSend !== undefined) store.setPrefs({ voiceAutoSend: !!p.voiceAutoSend });
        if (p.voiceCleanup !== undefined) store.setPrefs({ voiceCleanup: !!p.voiceCleanup });
        if (p.voiceTranslate !== undefined) store.setPrefs({ voiceTranslate: !!p.voiceTranslate });
        if (p.voiceCleanupModel !== undefined) {
          if (!CLEANUP_MODELS.some((v) => v.id === p.voiceCleanupModel)) throw new Error('неизвестная модель для исправления текста');
          store.setPrefs({ voiceCleanupModel: p.voiceCleanupModel });
        }
        this.broadcast({ t: 'prefs', prefs: this.prefsState() });
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
        const patch: { pinned?: boolean; title?: string; archived?: boolean; notifyDone?: boolean } = {};
        if (msg.pinned !== undefined) patch.pinned = msg.pinned;
        if (msg.title !== undefined) patch.title = msg.title.trim() || undefined;
        if (msg.notifyDone !== undefined) patch.notifyDone = msg.notifyDone || undefined;
        if (msg.archived !== undefined) {
          patch.archived = msg.archived || undefined;
          // an archived chat is out of the way: not pinned either
          if (msg.archived) patch.pinned = false;
        }
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
      // Codex only: closing an Antigravity session (session/close) also kills its background tasks (dev servers, long
      // commands) — seen in agy's log 2026-11-23 — so its sessions stay open
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
    this.tg.stop();
    for (const a of Object.values(this.adapters)) a.shutdown();
  }
}
