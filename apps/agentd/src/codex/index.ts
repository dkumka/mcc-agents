import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentCapabilities,
  AgentLimits,
  Approval,
  ApprovalDecision,
  ChatItem,
  ChatSettings,
  ChatSummary,
  FileDiff,
  LimitWindow,
  PermissionModeInfo,
  SendPayload,
  ToolStatus,
} from '@mcc-agents/protocol';
import type { Adapter, Hub } from '../hub.ts';
import type { Chat } from '../chat.ts';
import { config } from '../config.ts';
import { logger } from '../log.ts';
import { store } from '../store.ts';
import { unwrapShell } from '../tools.ts';
import { AppServer } from './rpc.ts';
import { splitFiles } from '../uploads.ts';

const log = logger('codex');
type Json = Record<string, any>;

export const CODEX_MODES: PermissionModeInfo[] = [
  { id: 'on-request', label: 'Спрашивать', description: 'Запрашивать разрешение на выход за рамки проекта' },
];

function durationLabel(mins?: number | null) {
  if (!mins) return 'Лимит';
  if (mins === 300) return '5 часов';
  if (mins === 10080) return 'Неделя';
  if (mins % 1440 === 0) return `${mins / 1440} дн.`;
  return `${Math.round(mins / 60)} ч`;
}

function mapStatus(s: string | undefined, exitCode?: number | null): ToolStatus {
  switch (s) {
    case 'inProgress':
      return 'running';
    case 'completed':
      return exitCode && exitCode !== 0 ? 'error' : 'done';
    case 'failed':
      return 'error';
    case 'declined':
      return 'denied';
    default:
      return 'done';
  }
}

function diffsOf(changes: Json[] = []): FileDiff[] {
  return changes.map((c) => {
    const kind = c.kind?.type ?? 'update';
    if (kind === 'add') return { path: c.path, kind: 'add', newText: c.diff };
    if (kind === 'delete') return { path: c.path, kind: 'delete', oldText: c.diff };
    return { path: c.kind?.move_path ?? c.path, kind: 'update', unified: c.diff };
  });
}

function textOfUser(content: Json[] = []): { text: string; images: { mediaType: string; name?: string }[] } {
  const parts: string[] = [];
  const images: { mediaType: string; name?: string }[] = [];
  for (const c of content) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'localImage') images.push({ mediaType: 'image/*', name: path.basename(c.path ?? '') });
    else if (c.type === 'image') images.push({ mediaType: 'image/*', name: 'image' });
    else if (c.type === 'mention' || c.type === 'skill') parts.push(`@${c.name}`);
  }
  return { text: parts.join('\n'), images };
}

/** Codex ThreadItem → ChatItem (null = not shown). */
export function codexItem(it: Json): ChatItem | null {
  const ts = it.startedAtMs ?? undefined;
  switch (it.type) {
    case 'userMessage': {
      const { text: raw, images } = textOfUser(it.content);
      const { text, files } = splitFiles(raw);
      return { kind: 'user', id: it.clientId ?? it.id, ts, text, images: images.length ? images : undefined, files: files.length ? files : undefined };
    }
    case 'agentMessage':
      return { kind: 'assistant', id: it.id, ts, text: it.text ?? '' };
    case 'reasoning': {
      const text = (it.summary ?? []).join('\n\n') || (it.content ?? []).join('\n\n');
      return { kind: 'thinking', id: it.id, ts, text };
    }
    case 'commandExecution':
      return {
        kind: 'tool',
        id: it.id,
        ts,
        tool: 'commandExecution',
        category: 'bash',
        title: unwrapShell(String(it.command ?? '')),
        subtitle: it.cwd && it.cwd !== '' ? undefined : undefined,
        input: { command: it.command, cwd: it.cwd },
        output: it.aggregatedOutput ?? '',
        exitCode: it.exitCode,
        durationMs: it.durationMs,
        status: mapStatus(it.status, it.exitCode),
      };
    case 'fileChange': {
      const diffs = diffsOf(it.changes);
      return {
        kind: 'tool',
        id: it.id,
        ts,
        tool: 'fileChange',
        category: diffs.length === 1 && diffs[0].kind === 'add' ? 'write' : 'edit',
        title: diffs.map((d) => d.path).join(', '),
        input: { changes: it.changes },
        diffs,
        status: mapStatus(it.status),
      };
    }
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id: it.id,
        ts,
        tool: `${it.server}.${it.tool}`,
        category: 'mcp',
        title: `${it.server} · ${it.tool}`,
        input: it.arguments,
        output: it.error ? String(it.error.message ?? JSON.stringify(it.error)) : it.result ? JSON.stringify(it.result.content ?? it.result, null, 2) : undefined,
        durationMs: it.durationMs,
        status: it.error ? 'error' : mapStatus(it.status),
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool',
        id: it.id,
        ts,
        tool: it.tool,
        category: 'other',
        title: it.tool,
        input: it.arguments,
        output: (it.contentItems ?? []).map((c: Json) => c.text ?? '').join('\n') || undefined,
        status: it.success === false ? 'error' : mapStatus(it.status),
      };
    case 'webSearch':
      return { kind: 'tool', id: it.id, ts, tool: 'webSearch', category: 'web', title: String(it.query ?? it.action?.query ?? 'Поиск в интернете'), input: it, status: 'done' };
    case 'imageView':
      return { kind: 'tool', id: it.id, ts, tool: 'imageView', category: 'read', title: String(it.path ?? ''), input: it, status: 'done' };
    case 'plan':
      return { kind: 'tool', id: it.id, ts, tool: 'plan', category: 'plan', title: 'План', input: { plan: it.text }, status: 'done' };
    case 'collabAgentToolCall':
      return {
        kind: 'tool',
        id: it.id,
        ts,
        tool: String(it.tool),
        category: 'task',
        title: (it.prompt ?? String(it.tool)).slice(0, 120),
        subtitle: it.model ?? undefined,
        input: it,
        status: mapStatus(it.status),
      };
    case 'contextCompaction':
      return { kind: 'notice', id: it.id, ts, level: 'info', text: 'Контекст сжат (compact)' };
    case 'enteredReviewMode':
      return { kind: 'notice', id: it.id, ts, level: 'info', text: 'Режим ревью' };
    case 'exitedReviewMode':
      return { kind: 'notice', id: it.id, ts, level: 'info', text: 'Ревью завершено' };
    default:
      return null;
  }
}

interface PendingReq {
  rpcId: number | string;
  method: string;
  params: Json;
  threadId: string;
}

export class CodexAdapter implements Adapter {
  readonly agent = 'codex' as const;
  private hub: Hub;
  rpc = new AppServer();
  private activeTurn = new Map<string, string>(); // threadId → turnId
  private loaded = new Set<string>(); // threads resumed in this app-server
  private pending = new Map<string, PendingReq>(); // approval id → request
  private capsCache: { at: number; caps: AgentCapabilities } | null = null;
  private plan?: string;

  constructor(hub: Hub) {
    this.hub = hub;
    this.rpc.on('notification', (m: string, p: Json) => {
      try {
        this.onNotification(m, p);
      } catch (e) {
        log.error(`notification ${m}`, e);
      }
    });
    this.rpc.on('request', (id: number, m: string, p: Json) => {
      try {
        this.onRequest(id, m, p);
      } catch (e) {
        log.error(`request ${m}`, e);
      }
    });
    this.rpc.on('ready', () => this.onReady());
    this.rpc.on('exit', () => {
      // threads must be resumed again on the new process
      for (const tid of this.loaded) {
        const chat = this.hub.peek(`codex:${tid}`);
        if (chat) {
          chat.settleRunningTools('interrupted');
          chat.patch({ live: false, approvals: [] });
          if (chat.summary.status !== 'idle') chat.setStatus('idle');
          chat.loaded = false;
        }
      }
      this.loaded.clear();
      this.activeTurn.clear();
      this.pending.clear();
    });
  }

  private async onReady() {
    try {
      const acc = await this.rpc.request('account/read', {});
      this.plan = acc?.account?.planType;
    } catch (e) {
      log.warn('account/read', e);
    }
    try {
      const rl = await this.rpc.request('account/rateLimits/read', {});
      if (rl?.rateLimits) this.limits(rl.rateLimits);
    } catch (e) {
      log.warn('rateLimits/read', e);
    }
  }

  start() {
    this.rpc.start().catch((e) => log.warn('app-server start', e));
  }

  shutdown() {
    this.rpc.stop();
  }

  isLive(chat: Chat) {
    return this.loaded.has(chat.nativeId);
  }

  // ------------------------------------------------------------ listing

  async list(): Promise<ChatSummary[]> {
    const out: ChatSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const r: Json = await this.rpc.request('thread/list', { limit: 100, cursor, sortKey: 'updated_at' }, 30_000);
      for (const t of (r?.data ?? []) as Json[]) {
        if (t.ephemeral || t.parentThreadId) continue;
        out.push({
          id: `codex:${t.id}`,
          agent: 'codex',
          nativeId: t.id,
          cwd: t.cwd ?? '',
          title: String(t.name || t.preview || 'Без названия').replace(/\s+/g, ' ').slice(0, 140),
          createdAt: (t.createdAt ?? 0) * 1000,
          updatedAt: (t.updatedAt ?? t.createdAt ?? 0) * 1000,
          status: t.status?.type === 'active' ? 'running' : 'idle',
          origin: t.originator === config.codexClientName ? 'web' : t.source === 'cli' || /codex_cli/.test(t.originator ?? '') ? 'terminal' : 'other',
          model: t.model ?? undefined,
        });
      }
      cursor = r?.nextCursor ?? null;
      if (!cursor) break;
    }
    return out;
  }

  // ------------------------------------------------------------ open / history

  async load(chat: Chat) {
    const tid = chat.nativeId;
    const r: Json = await this.rpc.request('thread/resume', { threadId: tid, excludeTurns: true, sandbox: 'workspace-write', approvalPolicy: 'on-request' }, 60_000);
    this.loaded.add(tid);
    const meta = store.meta(chat.id);
    chat.state.settings = {
      model: meta.settings?.model ?? r?.model ?? undefined,
      effort: meta.settings?.effort ?? r?.reasoningEffort ?? undefined,
      permissionMode: meta.settings?.permissionMode ?? (typeof r?.approvalPolicy === 'string' ? r.approvalPolicy : undefined),
    };
    const items: ChatItem[] = [];
    let cursor: string | null = null;
    let lastActive: string | undefined;
    for (let page = 0; page < 60; page++) {
      const t: Json = await this.rpc.request('thread/turns/list', { threadId: tid, itemsView: 'full', sortDirection: 'asc', limit: 30, cursor }, 60_000);
      for (const turn of (t?.data ?? []) as Json[]) {
        for (const it of (turn.items ?? []) as Json[]) {
          const ci = codexItem(it);
          if (ci) items.push(ci);
        }
        if (turn.status === 'interrupted') items.push({ kind: 'notice', id: `int-${turn.id}`, level: 'warn', text: 'Прервано' });
        if (turn.status === 'failed' && turn.error) items.push({ kind: 'notice', id: `err-${turn.id}`, level: 'error', text: String(turn.error.message ?? 'Ошибка') });
        if (turn.status === 'inProgress') lastActive = turn.id;
      }
      cursor = t?.nextCursor ?? null;
      if (!cursor) break;
    }
    // de-duplicate (a user item may be keyed by clientId)
    const seen = new Set<string>();
    chat.resetItems(items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true))));
    if (lastActive) this.activeTurn.set(tid, lastActive);
    chat.state.live = true;
    chat.state.summary.status = lastActive ? 'running' : 'idle';
  }

  // ------------------------------------------------------------ actions

  async prepare(cwd: string, settings: ChatSettings): Promise<string> {
    const r: Json = await this.rpc.request('thread/start', {
      cwd,
      model: settings.model || null,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });
    const tid = r?.thread?.id;
    if (!tid) throw new Error('codex не создал тред');
    this.loaded.add(tid);
    return tid;
  }

  private async input(p: SendPayload): Promise<Json[]> {
    const input: Json[] = [];
    if (p.text) input.push({ type: 'text', text: p.text, text_elements: [] });
    if (p.images?.length) {
      const dir = path.join(config.dataDir, 'uploads');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const img of p.images) {
        const ext = (img.mediaType.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        const file = path.join(dir, `${randomUUID()}.${ext}`);
        fs.writeFileSync(file, Buffer.from(img.data, 'base64'), { mode: 0o600 });
        input.push({ type: 'localImage', path: file });
      }
    }
    return input;
  }

  async send(chat: Chat, message: SendPayload, uuid: string) {
    const tid = chat.nativeId;
    if (!this.loaded.has(tid)) await this.load(chat);
    if (message.text.trim() === '/compact' && !message.images?.length) {
      await this.rpc.request('thread/compact/start', { threadId: tid });
      chat.notice('info', 'Сжимаю контекст…');
      return;
    }
    const input = await this.input(message);
    const active = this.activeTurn.get(tid);
    if (active) {
      await this.rpc.request('turn/steer', { threadId: tid, input, expectedTurnId: active, clientUserMessageId: uuid });
      return;
    }
    const s = chat.state.settings;
    chat.setStatus('running');
    const r: Json = await this.rpc.request('turn/start', {
      threadId: tid,
      input,
      clientUserMessageId: uuid,
      model: s.model || null,
      effort: s.effort || null,
      approvalPolicy: 'on-request',
    });
    if (r?.turn?.id) this.activeTurn.set(tid, r.turn.id);
  }

  async interrupt(chat: Chat) {
    const turnId = this.activeTurn.get(chat.nativeId);
    if (!turnId) return;
    await this.rpc.request('turn/interrupt', { threadId: chat.nativeId, turnId }, 15_000);
  }

  async decide(chat: Chat, d: ApprovalDecision) {
    const req = this.pending.get(d.approvalId);
    if (!req) throw new Error('запрос уже неактуален');
    this.pending.delete(d.approvalId);
    const allow = d.decision === 'allow';
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        let decision: unknown = allow ? 'accept' : 'decline';
        if (allow && d.optionId === 'acceptForSession') decision = 'acceptForSession';
        if (allow && d.optionId === 'execpolicy' && req.params.proposedExecpolicyAmendment)
          decision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: req.params.proposedExecpolicyAmendment } };
        this.rpc.respond(req.rpcId, { decision });
        break;
      }
      case 'item/fileChange/requestApproval':
        this.rpc.respond(req.rpcId, { decision: allow ? (d.optionId === 'acceptForSession' ? 'acceptForSession' : 'accept') : 'decline' });
        break;
      case 'item/tool/requestUserInput': {
        const answers: Json = {};
        for (const q of (req.params.questions ?? []) as Json[]) {
          const a = d.answers?.[q.question];
          if (a !== undefined) answers[q.id] = { answers: a.split(', ').filter(Boolean) };
        }
        this.rpc.respond(req.rpcId, { answers });
        break;
      }
      case 'item/permissions/requestApproval':
        if (allow) this.rpc.respond(req.rpcId, { permissions: req.params.permissions, scope: 'turn' });
        else this.rpc.respondError(req.rpcId, 'declined by user');
        break;
      case 'execCommandApproval':
      case 'applyPatchApproval':
        this.rpc.respond(req.rpcId, { decision: allow ? 'approved' : 'denied' });
        break;
      default:
        this.rpc.respondError(req.rpcId, 'unsupported');
    }
    chat.removeApproval(d.approvalId);
  }

  async applySettings(_chat: Chat, _s: ChatSettings) {
    // model / effort / approval policy are sent with every turn/start
  }

  async stopTask() {
    throw new Error('У Codex нет фоновых задач');
  }

  async release(chat: Chat) {
    if (!this.loaded.has(chat.nativeId) || this.activeTurn.has(chat.nativeId)) return;
    this.loaded.delete(chat.nativeId);
    chat.loaded = false;
    chat.patch({ live: false });
    await this.rpc.request('thread/unsubscribe', { threadId: chat.nativeId }).catch(() => {});
  }

  // ------------------------------------------------------------ events

  private chatFor(p: Json): Chat | undefined {
    const tid = p.threadId ?? p.thread?.id;
    if (!tid) return;
    const chat = this.hub.peek(`codex:${tid}`);
    if (!chat || !chat.loaded) return;
    return chat;
  }

  private onNotification(method: string, p: Json) {
    if (method === 'account/rateLimits/updated') {
      if (p.rateLimits) this.limits(p.rateLimits);
      return;
    }
    if (method === 'account/updated') {
      if (p.planType) this.plan = p.planType;
      return;
    }
    if (method === 'thread/started') {
      this.hub.scheduleRefresh();
      return;
    }
    if (method === 'thread/status/changed') {
      const chat = this.hub.peek(`codex:${p.threadId}`);
      if (!chat) return;
      const st = p.status ?? {};
      if (st.type === 'active') chat.setStatus((st.activeFlags ?? []).includes('waitingOnApproval') ? 'waiting' : 'running');
      return;
    }
    const chat = this.chatFor(p);
    if (!chat) return;
    switch (method) {
      case 'turn/started':
        if (p.turn?.id) this.activeTurn.set(chat.nativeId, p.turn.id);
        chat.setStatus('running');
        return;
      case 'turn/completed': {
        this.activeTurn.delete(chat.nativeId);
        const st = p.turn?.status;
        let outcome: 'done' | 'error' | 'interrupted' = 'done';
        if (st === 'interrupted') {
          outcome = 'interrupted';
          chat.notice('warn', 'Прервано');
        } else if (st === 'failed') {
          outcome = 'error';
          chat.notice('error', String(p.turn?.error?.message ?? 'Ход завершился с ошибкой'));
        }
        chat.settleRunningTools('interrupted');
        chat.clearApprovals();
        chat.setStatus('idle');
        chat.finished(outcome);
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const ci = codexItem(p.item ?? {});
        if (!ci) return;
        if (method === 'item/started' && (ci.kind === 'assistant' || ci.kind === 'thinking')) ci.streaming = true;
        const prev = chat.get(ci.id);
        // keep streamed output if the completed item carries none
        if (prev?.kind === 'tool' && ci.kind === 'tool' && !ci.output && prev.output) ci.output = prev.output;
        if (prev?.kind === 'thinking' && ci.kind === 'thinking' && !ci.text && prev.text) ci.text = prev.text;
        chat.upsert(ci);
        return;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta':
        chat.delta(p.itemId, String(p.delta ?? ''));
        return;
      case 'item/reasoning/summaryPartAdded':
        chat.delta(p.itemId, '\n\n');
        return;
      case 'turn/plan/updated':
        chat.patch({
          todos: (p.plan ?? []).map((s: Json) => ({
            content: String(s.step),
            status: s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending',
          })),
        });
        return;
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {};
        const ctx = u.last?.totalTokens ?? 0;
        const win = u.modelContextWindow ?? 0;
        chat.setUsage({ contextTokens: ctx, contextWindow: win, percent: win ? Math.round((ctx / win) * 100) : 0 });
        return;
      }
      case 'thread/name/updated':
        if (p.threadName || p.name) chat.setSummary({ title: String(p.threadName ?? p.name) });
        return;
      case 'thread/compacted':
        chat.notice('info', 'Контекст сжат (compact)');
        return;
      case 'serverRequest/resolved': {
        const id = String(p.requestId);
        this.pending.delete(id);
        chat.removeApproval(id);
        return;
      }
      case 'model/rerouted':
        chat.notice('warn', `Модель переключена: ${p.toModel ?? p.model ?? ''}`.trim());
        return;
      case 'error':
        if (p.error?.message) chat.notice(p.willRetry ? 'warn' : 'error', String(p.error.message));
        return;
      default:
        return;
    }
  }

  private onRequest(id: number | string, method: string, p: Json) {
    const tid = p.threadId ?? p.conversationId;
    const chat = tid ? this.hub.peek(`codex:${tid}`) : undefined;
    const supported = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'item/permissions/requestApproval',
      'execCommandApproval',
      'applyPatchApproval',
    ];
    if (!supported.includes(method) || !chat) {
      log.warn(`unsupported server request ${method}`);
      this.rpc.respondError(id, `unsupported: ${method}`);
      return;
    }
    const aid = String(id);
    this.pending.set(aid, { rpcId: id, method, params: p, threadId: tid });
    const a: Approval = { id: aid, kind: 'tool', tool: method, title: '', toolItemId: p.itemId, createdAt: Date.now() };
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const cmd = Array.isArray(p.command) ? p.command.join(' ') : String(p.command ?? '');
      a.kind = 'command';
      a.command = unwrapShell(cmd);
      a.title = a.command;
      a.detail = p.reason ?? (p.cwd ? `в ${p.cwd}` : undefined);
      a.options = [{ id: 'acceptForSession', label: 'Разрешить до конца сессии' }];
      if (p.proposedExecpolicyAmendment) a.options.push({ id: 'execpolicy', label: 'Всегда разрешать такие команды' });
    } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const t = p.itemId ? chat.tool(p.itemId) : undefined;
      a.kind = 'fileChange';
      a.title = t?.title || 'Изменение файлов';
      a.diffs = t?.diffs;
      a.detail = p.reason ?? undefined;
      a.options = [{ id: 'acceptForSession', label: 'Разрешить правки до конца сессии' }];
    } else if (method === 'item/tool/requestUserInput') {
      a.kind = 'question';
      a.title = 'Codex задаёт вопрос';
      a.questions = (p.questions ?? []).map((q: Json) => ({ question: q.question, header: q.header, options: q.options ?? [] }));
    } else {
      a.title = 'Codex просит расширенные права';
      a.detail = p.reason ?? undefined;
      a.input = p.permissions;
    }
    chat.addApproval(a);
  }

  private limits(snap: Json) {
    const windows: LimitWindow[] = [];
    for (const key of ['primary', 'secondary'] as const) {
      const w = snap[key];
      if (w && typeof w.usedPercent === 'number')
        windows.push({ id: key, label: durationLabel(w.windowDurationMins), usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt ?? undefined });
    }
    const l: AgentLimits = { agent: 'codex', plan: snap.planType ?? this.plan, windows, updatedAt: Date.now() };
    this.hub.setLimits(l);
  }

  // ------------------------------------------------------------ capabilities

  async capabilities(): Promise<AgentCapabilities> {
    if (this.capsCache && Date.now() - this.capsCache.at < 10 * 60_000) return this.capsCache.caps;
    try {
      const r: Json = await this.rpc.request('model/list', {}, 30_000);
      const models = ((r?.data ?? []) as Json[])
        .filter((m) => !m.hidden)
        .map((m) => ({
          id: String(m.model ?? m.id),
          label: String(m.displayName ?? m.model),
          description: m.description,
          efforts: (m.supportedReasoningEfforts ?? []).map((e: Json) => String(e.reasoningEffort)),
          defaultEffort: m.defaultReasoningEffort ?? undefined,
          isDefault: !!m.isDefault,
        }));
      let approval = 'on-request';
      try {
        const c: Json = await this.rpc.request('config/read', {}, 15_000);
        const v = c?.config?.approval_policy ?? c?.config?.approvalPolicy;
        if (typeof v === 'string') approval = v;
      } catch {}
      const def = models.find((m) => m.isDefault) ?? models[0];
      const caps: AgentCapabilities = {
        agent: 'codex',
        available: true,
        plan: this.plan,
        models,
        permissionModes: CODEX_MODES,
        defaults: { model: def?.id, effort: def?.defaultEffort, permissionMode: approval },
        commands: [{ name: 'compact', description: 'Сжать контекст треда' }],
      };
      this.capsCache = { at: Date.now(), caps };
      return caps;
    } catch (e) {
      return {
        agent: 'codex',
        available: false,
        error: (e as Error).message,
        models: [],
        permissionModes: CODEX_MODES,
        defaults: {},
        commands: [],
      };
    }
  }
}
