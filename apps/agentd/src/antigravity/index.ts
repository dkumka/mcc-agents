import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  AgentCapabilities,
  Approval,
  ApprovalDecision,
  ChatItem,
  ChatSettings,
  ChatSummary,
  FileDiff,
  LimitWindow,
  ModelInfo,
  PermissionModeInfo,
  SendPayload,
  SlashCommand,
  ToolCategory,
  ToolItem,
  ToolStatus,
} from '@mcc-agents/protocol';
import type { Adapter, Hub } from '../hub.ts';
import type { Chat } from '../chat.ts';
import { config } from '../config.ts';
import { logger } from '../log.ts';
import { store } from '../store.ts';
import { splitFiles } from '../uploads.ts';
import { AcpServer } from './acp.ts';

const log = logger('antigravity');
type Json = Record<string, any>;

const AGENT = 'antigravity' as const;
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Session modes of `agy acp`. `auto` is offered only where the CLI has its terminal sandbox (see docs/ARCHITECTURE.md). */
const MODE_TEXT: Record<string, { label: string; description: string }> = {
  auto: { label: 'Авто', description: 'Правки в папке и команды в песочнице — сразу, рискованное — с вопросом' },
  'accept-edits': { label: 'Правки без вопросов', description: 'Правки в папке проекта — сразу, команды — с подтверждением' },
  default: { label: 'Спрашивать', description: 'Подтверждать правки и команды' },
  plan: { label: 'План', description: 'Сначала план, потом работа' },
};
const STATIC_MODES = ['accept-edits', 'default', 'plan'];

/**
 * Before any session is opened the modes are unknown. agy offers Auto when its terminal sandbox works, i.e. when it may
 * create user namespaces: the Ubuntu restriction is off, or agy runs under its own AppArmor profile (/etc/apparmor.d/agy,
 * label «agy (unconfined)» instead of «unconfined»; see docs/ARCHITECTURE.md).
 */
function sandboxLikely(pid?: number): boolean {
  try {
    if (fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '0') return true;
  } catch {
    return true; // no such restriction on this system
  }
  try {
    return !!pid && fs.readFileSync(`/proc/${pid}/attr/current`, 'utf8').trim() !== 'unconfined';
  } catch {
    return false;
  }
}

function modeInfo(id: string, fallback?: Json): PermissionModeInfo {
  const t = MODE_TEXT[id];
  return { id, label: t?.label ?? String(fallback?.name ?? id), description: t?.description ?? String(fallback?.description ?? '') };
}

/** `gemini-4-neon-high` → base `gemini-4-neon` + effort `high`; names lose their « (High)». */
function splitModelId(id: string): { base: string; effort?: string } {
  const m = id.match(/^(.*)-(minimal|low|medium|high|xhigh|max)$/);
  return m ? { base: m[1], effort: m[2] } : { base: id };
}

function parseModels(list: { modelId: string; name: string }[], current?: string): ModelInfo[] {
  const out = new Map<string, ModelInfo>();
  for (const m of list) {
    const { base, effort } = splitModelId(String(m.modelId));
    let info = out.get(base);
    if (!info) {
      info = { id: base, label: effort ? String(m.name).replace(/\s*\([^)]*\)\s*$/, '') : String(m.name), efforts: [] };
      out.set(base, info);
    }
    if (effort && !info.efforts.includes(effort)) info.efforts.push(effort);
  }
  const cur = current ? splitModelId(current) : undefined;
  for (const info of out.values()) {
    info.efforts.sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
    info.defaultEffort = cur?.base === info.id && cur.effort ? cur.effort : info.efforts.includes('high') ? 'high' : info.efforts.at(-1);
    if (cur?.base === info.id) info.isDefault = true;
  }
  return [...out.values()];
}

function textOf(c: Json | undefined): string {
  if (!c) return '';
  if (c.type === 'text') return String(c.text ?? '');
  if (c.type === 'resource_link') return `@${c.name ?? c.uri ?? ''}`;
  if (c.type === 'resource') return c.resource?.uri ? `@${c.resource.uri}` : '';
  return '';
}

function categoryOf(tc: Json, diffs: FileDiff[]): ToolCategory {
  switch (tc.kind) {
    case 'execute':
      return 'bash';
    case 'edit':
      return diffs.length && diffs.every((d) => d.kind === 'add') ? 'write' : 'edit';
    case 'delete':
    case 'move':
      return 'edit';
    case 'read':
      return 'read';
    case 'search':
      return 'search';
    case 'fetch':
      return 'web';
    case 'switch_mode':
      return 'plan';
  }
  const name = String(tc.name ?? '');
  if (/browser|search_web|read_url/i.test(name)) return 'web';
  if (/subagent|invoke_agent|teamwork|swarm/i.test(name)) return 'task';
  if (/^mcp/i.test(name)) return 'mcp';
  return 'other';
}

/** Merged ACP tool call (tool_call + its tool_call_updates) → ToolItem. */
function toolItem(tc: Json, extra: { denied?: boolean; ts?: number; durationMs?: number | null }): ToolItem {
  const raw: Json = tc.rawInput ?? tc.args ?? {};
  const diffs: FileDiff[] = [];
  const texts: string[] = [];
  for (const c of (tc.content ?? []) as Json[]) {
    if (c.type === 'diff') {
      const path = String(c.path ?? '');
      if (c.oldText === null || c.oldText === undefined) diffs.push({ path, kind: 'add', newText: String(c.newText ?? '') });
      else diffs.push({ path, kind: 'update', oldText: String(c.oldText), newText: String(c.newText ?? '') });
    } else if (c.type === 'content') {
      const t = textOf(c.content);
      if (t) texts.push(t);
    }
  }
  let output = texts.join('\n') || (typeof tc.rawOutput?.output === 'string' ? tc.rawOutput.output : '');
  output = output.replace(/\r\n/g, '\n');
  const exitCode = typeof tc.rawOutput?.exit_code === 'number' ? tc.rawOutput.exit_code : undefined;
  if (tc.kind === 'execute') {
    // «Created At … Completed At … Command exited with code N. Command output:» — keep just the output
    const i = output.indexOf('Command output:\n');
    if (i >= 0) output = output.slice(i + 'Command output:\n'.length);
  }
  const category = categoryOf(tc, diffs);
  const path = tc.locations?.[0]?.path as string | undefined;
  const title =
    tc.kind === 'execute'
      ? String(raw.CommandLine ?? tc.title ?? '')
      : (category === 'edit' || category === 'write' || category === 'read') && path
        ? path
        : String(tc.title ?? tc.name ?? 'Инструмент');
  let status: ToolStatus;
  switch (tc.status) {
    case 'pending':
      status = 'pending';
      break;
    case 'in_progress':
      status = 'running';
      break;
    case 'failed':
      status = extra.denied ? 'denied' : 'error';
      break;
    case 'completed':
      status = exitCode ? 'error' : 'done';
      break;
    default:
      status = 'running';
  }
  return {
    kind: 'tool',
    id: String(tc.toolCallId),
    ts: extra.ts,
    tool: String(tc.name ?? tc.kind ?? 'tool'),
    category,
    title,
    subtitle: typeof raw.toolSummary === 'string' && raw.toolSummary !== title ? raw.toolSummary : undefined,
    input: raw,
    output: output || undefined,
    exitCode,
    diffs: diffs.length ? diffs : undefined,
    durationMs: extra.durationMs,
    status,
  };
}

interface Sess {
  /** session/prompt requests in flight: a prompt sent mid-turn steers it, the earlier one returns at once. */
  inflight: number;
  lastStop?: string;
  lastError?: string;
  lastEventAt: number;
  /** history replay of session/load: items go in silently. */
  replay: boolean;
  /** the text item being streamed into (consecutive chunks of one kind join). */
  cur?: { kind: 'assistant' | 'thinking' | 'user'; id: string; raw?: string };
  tools: Map<string, Json>;
  toolStart: Map<string, number>;
  denied: Set<string>;
  /** last time content arrived between turns (the agent woke up by itself). */
  wokeAt?: number;
  /** closes the streamed text of such a wake-up once the session is quiet (no prompt will end it). */
  quietTimer?: NodeJS.Timeout;
  /** what the session runs now (to skip redundant set_model / set_mode). */
  modelId?: string;
  mode?: string;
}

interface PendingReq {
  rpcId: number | string;
  sid: string;
  toolCallId?: string;
  options: { optionId: string; name: string; kind: string }[];
}

/**
 * Antigravity CLI (`agy`) through its official ACP server. History, titles and sessions are the CLI's own
 * (`agy --conversation <id>` in a terminal opens the same conversation).
 */
export class AntigravityAdapter implements Adapter {
  readonly agent = AGENT;
  private hub: Hub;
  acp = new AcpServer();
  private sessions = new Map<string, Sess>();
  private loaded = new Set<string>();
  private pending = new Map<string, PendingReq>();
  private models: ModelInfo[] = [];
  private modes: PermissionModeInfo[] = STATIC_MODES.map((m) => modeInfo(m));
  /** `modes` came from a real session (else: a guess, see sandboxLikely). */
  private modesKnown = false;
  private commands: SlashCommand[] = [];
  private defaultModelId?: string;
  private tier?: string;
  private capsCache: { at: number; caps: AgentCapabilities } | null = null;

  constructor(hub: Hub) {
    this.hub = hub;
    // limits at start, if none or older than an hour (no point earlier: the list refresh starts agy anyway)
    setTimeout(() => {
      if (this.usageStale()) this.refreshUsage();
    }, 20_000);
    this.acp.on('notification', (m: string, p: Json) => {
      try {
        if (m === 'session/update') this.onUpdate(String(p.sessionId), p.update ?? {});
      } catch (e) {
        log.error(`notification ${m}`, e);
      }
    });
    this.acp.on('request', (id: number | string, m: string, p: Json) => {
      try {
        this.onRequest(id, m, p);
      } catch (e) {
        log.error(`request ${m}`, e);
        this.acp.respondError(id, (e as Error).message, -32603);
      }
    });
    this.acp.on('exit', () => {
      for (const sid of this.loaded) {
        const chat = this.hub.peek(`${AGENT}:${sid}`);
        if (!chat) continue;
        chat.settleRunningTools('interrupted');
        chat.patch({ live: false, approvals: [] });
        chat.loaded = false;
      }
      this.loaded.clear();
      this.pending.clear();
    });
  }

  shutdown() {
    this.acp.stop();
  }

  isLive(chat: Chat) {
    return this.loaded.has(chat.nativeId);
  }

  private sess(sid: string): Sess {
    let s = this.sessions.get(sid);
    if (!s) {
      s = { inflight: 0, lastEventAt: Date.now(), replay: false, tools: new Map(), toolStart: new Map(), denied: new Set() };
      this.sessions.set(sid, s);
    }
    return s;
  }

  // ------------------------------------------------------------ listing

  async list(): Promise<ChatSummary[]> {
    const out: ChatSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r: Json = await this.acp.request('session/list', cursor ? { cursor } : {}, 30_000);
      for (const s of (r?.sessions ?? []) as Json[]) {
        const at = Date.parse(s.updatedAt ?? '') || 0;
        out.push({
          id: `${AGENT}:${s.sessionId}`,
          agent: AGENT,
          nativeId: String(s.sessionId),
          cwd: String(s.cwd ?? ''),
          title: String(s.title || 'Без названия').replace(/\s+/g, ' ').slice(0, 140),
          createdAt: at,
          updatedAt: at,
          status: 'idle',
          origin: 'terminal',
        });
      }
      cursor = r?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  }

  // ------------------------------------------------------------ session results (new / load)

  /** Models, modes, tier and the current model/mode from a session/new or session/load result. */
  private absorb(sid: string, r: Json) {
    const st = this.sess(sid);
    const models = r?.models;
    if (Array.isArray(models?.availableModels) && models.availableModels.length) {
      this.defaultModelId ??= models.currentModelId;
      this.models = parseModels(models.availableModels, this.defaultModelId);
    }
    if (models?.currentModelId) st.modelId = String(models.currentModelId);
    const modes = r?.modes;
    if (Array.isArray(modes?.availableModes) && modes.availableModes.length) {
      this.modes = (modes.availableModes as Json[]).map((m) => modeInfo(String(m.id), m));
      this.modesKnown = true;
    }
    if (modes?.currentModeId) st.mode = String(modes.currentModeId);
    const tier = r?._meta?.antigravity?.tier?.name;
    if (tier && tier !== this.tier) {
      this.tier = tier;
      this.publishLimits();
    }
    this.capsCache = null;
  }

  private settingsOf(st: Sess): ChatSettings {
    const { base, effort } = splitModelId(st.modelId ?? '');
    return { model: base || undefined, effort, permissionMode: st.mode };
  }

  private modelId(model?: string, effort?: string): string | undefined {
    if (!model) return undefined;
    const info = this.models.find((m) => m.id === model);
    if (!info) return model;
    if (!info.efforts.length) return model;
    const e = effort && info.efforts.includes(effort) ? effort : info.defaultEffort;
    return e ? `${model}-${e}` : model;
  }

  /** Send set_model / set_mode where the session differs from `s`. */
  private async apply(sid: string, s: ChatSettings) {
    const st = this.sess(sid);
    const mid = this.modelId(s.model, s.effort);
    if (mid && mid !== st.modelId) {
      await this.acp.request('session/set_model', { sessionId: sid, modelId: mid });
      st.modelId = mid;
    }
    if (s.permissionMode && s.permissionMode !== st.mode) {
      await this.acp.request('session/set_mode', { sessionId: sid, modeId: s.permissionMode });
      st.mode = s.permissionMode;
    }
  }

  // ------------------------------------------------------------ open / history

  async load(chat: Chat) {
    const sid = chat.nativeId;
    const st = this.sess(sid);
    st.replay = true;
    st.cur = undefined;
    st.tools.clear();
    st.toolStart.clear();
    chat.resetItems([]);
    let r: Json;
    try {
      r = await this.acp.request('session/load', { sessionId: sid, cwd: chat.cwd || config.home, mcpServers: [] }, 180_000);
      // the replay may go on after the answer (seen 2026-11-23: the last answer came ~0.3 s later, became a «live» item
      // stuck in «пишет…» and lifted the chat as unread) — stay in replay until the session has been quiet for a moment
      const until = Date.now() + 5000;
      while (Date.now() - st.lastEventAt < 600 && Date.now() < until) await new Promise((res) => setTimeout(res, 100));
    } finally {
      this.closeText(chat, st);
      st.replay = false;
    }
    this.absorb(sid, r);
    this.loaded.add(sid);
    // tools the history left open (the turn was cut off) are not running now
    if (!st.inflight)
      for (const it of chat.state.items)
        if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending')) chat.upsert({ ...it, status: 'interrupted' }, { silent: true });
    const meta = store.meta(chat.id);
    const cur = this.settingsOf(st);
    // mode not chosen here: «Авто» where agy offers it (as Claude / Codex), else what the session has
    const auto = this.modes.some((m) => m.id === 'auto') ? 'auto' : undefined;
    chat.state.settings = {
      model: meta.settings?.model ?? cur.model,
      effort: meta.settings?.effort ?? cur.effort,
      permissionMode: meta.settings?.permissionMode ?? auto ?? cur.permissionMode,
    };
    if (meta.settings || chat.state.settings.permissionMode !== cur.permissionMode)
      await this.apply(sid, chat.state.settings).catch((e) => log.warn(`apply settings ${sid}`, e));
    chat.state.live = true;
    chat.state.summary.status = st.inflight ? 'running' : 'idle';
  }

  // ------------------------------------------------------------ actions

  async prepare(cwd: string, settings: ChatSettings): Promise<string> {
    const r: Json = await this.acp.request('session/new', { cwd, mcpServers: [] }, 120_000);
    const sid = r?.sessionId;
    if (!sid) throw new Error('Antigravity не создал сессию');
    this.absorb(sid, r);
    this.loaded.add(sid);
    await this.apply(sid, settings);
    return String(sid);
  }

  async fork(): Promise<string> {
    // ACP has no fork / rewind; the CLI's own /fork is interactive only
    throw new Error('Antigravity пока не умеет форки и откаты из веба — только в терминале (/fork)');
  }

  private blocks(p: SendPayload): Json[] {
    const out: Json[] = [];
    if (p.text) out.push({ type: 'text', text: p.text });
    for (const img of p.images ?? []) out.push({ type: 'image', mimeType: img.mediaType, data: img.data });
    return out;
  }

  /** One session/prompt; the turn ends when the last prompt in flight returns. */
  private prompt(chat: Chat, blocks: Json[]) {
    const sid = chat.nativeId;
    const st = this.sess(sid);
    st.inflight++;
    st.lastEventAt = Date.now();
    chat.setStatus('running');
    this.acp
      .request('session/prompt', { sessionId: sid, prompt: blocks }, 0)
      .then((r: Json) => {
        st.lastStop = String(r?.stopReason ?? 'end_turn');
        st.lastError = undefined;
      })
      .catch((e: Error) => {
        st.lastStop = 'error';
        st.lastError = e.message;
      })
      .finally(() => {
        st.inflight = Math.max(0, st.inflight - 1);
        if (!st.inflight) this.finishTurn(chat, st);
      });
  }

  private finishTurn(chat: Chat, st: Sess) {
    st.inflight = 0;
    this.closeText(chat, st);
    let outcome: 'done' | 'error' | 'interrupted' = 'done';
    switch (st.lastStop) {
      case 'cancelled':
        outcome = 'interrupted';
        chat.notice('warn', 'Прервано');
        break;
      case 'error':
        outcome = 'error';
        chat.notice('error', st.lastError || 'Ход завершился с ошибкой');
        break;
      case 'refusal':
        chat.notice('warn', 'Модель отказалась отвечать');
        break;
      case 'max_tokens':
        chat.notice('warn', 'Ответ обрезан: лимит токенов');
        break;
      case 'max_turn_requests':
        chat.notice('warn', 'Достигнут лимит шагов за ход');
        break;
    }
    st.lastStop = undefined;
    for (const [id, req] of this.pending) if (req.sid === chat.nativeId) this.pending.delete(id);
    // agy moves long commands to the background and ends the turn while they run: they stay «running» until their
    // tool_call_update arrives; only a stop or a failure ends them here
    if (outcome !== 'done') chat.settleRunningTools('interrupted');
    chat.clearApprovals();
    chat.setStatus('idle');
    chat.finished(outcome);
    // what this turn cost: 5-hour / weekly limits (also after an error — it may be the limit itself)
    this.refreshUsage();
  }

  async send(chat: Chat, message: SendPayload) {
    if (!this.loaded.has(chat.nativeId)) await this.hubLoad(chat);
    this.prompt(chat, this.blocks(message));
  }

  /** Reload after the ACP process restarted (the chat object still says loaded). */
  private async hubLoad(chat: Chat) {
    chat.loaded = false;
    await this.hub.ensureLoaded(chat);
  }

  async interrupt(chat: Chat) {
    const sid = chat.nativeId;
    const st = this.sess(sid);
    if (!st.inflight) return;
    // pending permission requests must be answered «cancelled» (ACP)
    for (const [id, req] of this.pending) {
      if (req.sid !== sid) continue;
      this.acp.respond(req.rpcId, { outcome: { outcome: 'cancelled' } });
      this.pending.delete(id);
      chat.removeApproval(id);
    }
    const since = Date.now();
    this.acp.notify('session/cancel', { sessionId: sid });
    // the prompt should come back with stopReason «cancelled»; if the agent goes quiet instead, do not hang in «Работает»
    setTimeout(() => {
      if (st.inflight && st.lastEventAt <= since) {
        st.lastStop = 'cancelled';
        this.finishTurn(chat, st);
      }
    }, 8000);
  }

  async decide(chat: Chat, d: ApprovalDecision) {
    const req = this.pending.get(d.approvalId);
    if (!req) throw new Error('запрос уже неактуален');
    this.pending.delete(d.approvalId);
    const allow = d.decision === 'allow';
    const pick = (pred: (k: string) => boolean) => req.options.find((o) => pred(o.kind))?.optionId;
    let optionId: string | undefined;
    if (allow) optionId = (d.optionId && req.options.some((o) => o.optionId === d.optionId) ? d.optionId : undefined) ?? pick((k) => k === 'allow_once') ?? pick((k) => k.startsWith('allow'));
    else optionId = pick((k) => k === 'reject_once') ?? pick((k) => k.startsWith('reject'));
    this.acp.respond(req.rpcId, optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } });
    if (!allow && req.toolCallId) this.sess(req.sid).denied.add(req.toolCallId);
    chat.removeApproval(d.approvalId);
    // a comment to the refusal goes to the agent as a message in the same turn
    const msg = d.message?.trim();
    if (!allow && msg) {
      chat.upsert({ kind: 'user', id: randomUUID(), ts: Date.now(), text: msg });
      this.prompt(chat, [{ type: 'text', text: msg }]);
    }
  }

  async applySettings(chat: Chat, s: ChatSettings) {
    if (!this.loaded.has(chat.nativeId)) return; // applied on load (meta.settings)
    await this.apply(chat.nativeId, { ...chat.state.settings, ...s });
  }

  async stopTask() {
    throw new Error('Фоновые задачи Antigravity из веба не останавливаются');
  }

  async release(chat: Chat) {
    const sid = chat.nativeId;
    if (!this.loaded.has(sid) || this.sess(sid).inflight) return;
    this.loaded.delete(sid);
    chat.loaded = false;
    chat.patch({ live: false });
    await this.acp.request('session/close', { sessionId: sid }, 15_000).catch(() => {});
  }

  // ------------------------------------------------------------ events

  private closeText(chat: Chat, st: Sess) {
    const cur = st.cur;
    st.cur = undefined;
    if (!cur || cur.kind === 'user') return;
    const it = chat.get(cur.id);
    if (it && (it.kind === 'assistant' || it.kind === 'thinking') && it.streaming) chat.upsert({ ...it, streaming: false }, { silent: st.replay });
  }

  private appendText(chat: Chat, st: Sess, kind: 'assistant' | 'thinking', text: string) {
    if (!text) return;
    if (st.cur?.kind === kind) {
      const it = chat.get(st.cur.id);
      if (it && (it.kind === 'assistant' || it.kind === 'thinking')) {
        if (st.replay) it.text += text;
        else chat.delta(st.cur.id, text);
        return;
      }
    }
    this.closeText(chat, st);
    const id = `${kind}-${randomUUID()}`;
    st.cur = { kind, id };
    const ts = st.replay ? undefined : Date.now();
    const item: ChatItem = kind === 'assistant' ? { kind, id, ts, text, streaming: !st.replay } : { kind, id, ts, text, streaming: !st.replay };
    chat.upsert(item, { silent: st.replay });
  }

  /** History only: the user's messages (live ones are added by the hub when sent). */
  private appendUser(chat: Chat, st: Sess, c: Json) {
    if (st.cur?.kind !== 'user') {
      this.closeText(chat, st);
      st.cur = { kind: 'user', id: `user-${randomUUID()}`, raw: '' };
    }
    const cur = st.cur;
    const prev = chat.get(cur.id);
    const images = prev?.kind === 'user' ? [...(prev.images ?? [])] : [];
    if (c.type === 'image') images.push({ mediaType: String(c.mimeType ?? 'image/*'), name: 'image' });
    else cur.raw = (cur.raw ?? '') + textOf(c);
    const { text, files } = splitFiles(cur.raw ?? '');
    chat.upsert({ kind: 'user', id: cur.id, text, images: images.length ? images : undefined, files: files.length ? files : undefined }, { silent: true });
  }

  private upsertTool(chat: Chat, st: Sess, u: Json) {
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    const { sessionUpdate: _drop, ...rest } = u;
    const merged = { ...(st.tools.get(id) ?? {}), ...rest };
    st.tools.set(id, merged);
    let durationMs: number | null | undefined;
    if (!st.replay) {
      if (!st.toolStart.has(id)) st.toolStart.set(id, Date.now());
      if (merged.status === 'completed' || merged.status === 'failed') durationMs = Date.now() - st.toolStart.get(id)!;
    }
    const prev = chat.tool(id);
    const item = toolItem(merged, { denied: st.denied.has(id), ts: prev?.ts ?? (st.replay ? undefined : Date.now()), durationMs: durationMs ?? prev?.durationMs });
    chat.upsert(item, { silent: st.replay });
  }

  private onUpdate(sid: string, u: Json) {
    const chat = this.hub.peek(`${AGENT}:${sid}`);
    if (!chat) return;
    const st = this.sess(sid);
    st.lastEventAt = Date.now();
    // a finished background task / subagent wakes the agent between turns: new content → up the list, unread
    if (!st.replay && !st.inflight && /^(agent_message_chunk|tool_call)$/.test(String(u.sessionUpdate)) && Date.now() - (st.wokeAt ?? 0) > 5000) {
      st.wokeAt = Date.now();
      chat.setSummary({ updatedAt: Date.now() });
    }
    if (!st.replay && !st.inflight) {
      clearTimeout(st.quietTimer);
      st.quietTimer = setTimeout(() => {
        if (!st.inflight) this.closeText(chat, st);
      }, 3000);
    }
    switch (u.sessionUpdate) {
      case 'user_message_chunk':
        if (st.replay) this.appendUser(chat, st, u.content ?? {});
        return;
      case 'agent_message_chunk':
        this.appendText(chat, st, 'assistant', textOf(u.content));
        return;
      case 'agent_thought_chunk':
        this.appendText(chat, st, 'thinking', textOf(u.content));
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.closeText(chat, st);
        this.upsertTool(chat, st, u);
        return;
      case 'plan':
        chat.patch({
          todos: ((u.entries ?? []) as Json[]).map((e) => ({
            content: String(e.content ?? ''),
            status: e.status === 'in_progress' ? 'in_progress' : e.status === 'completed' ? 'completed' : 'pending',
          })),
        });
        return;
      case 'usage_update': {
        const used = Number(u.used ?? 0);
        const size = Number(u.size ?? 0);
        chat.setUsage({ contextTokens: used, contextWindow: size, percent: size ? Math.round((used / size) * 100) : 0 });
        return;
      }
      case 'session_info_update':
        if (u.title) chat.setSummary({ title: String(u.title).slice(0, 140) });
        return;
      case 'available_commands_update':
        this.commands = ((u.availableCommands ?? []) as Json[]).map((c) => ({
          name: String(c.name),
          description: c.description ? String(c.description) : undefined,
          argumentHint: c.input?.hint ? String(c.input.hint) : undefined,
        }));
        this.capsCache = null;
        return;
      case 'current_mode_update':
        if (u.currentModeId) {
          st.mode = String(u.currentModeId);
          if (chat.state.settings.permissionMode !== st.mode) chat.patch({ settings: { ...chat.state.settings, permissionMode: st.mode } });
        }
        return;
      case 'config_option_update': {
        const opts = (u.configOptions ?? []) as Json[];
        const model = opts.find((o) => o.id === 'model')?.currentValue;
        const effort = opts.find((o) => o.id === 'thought_level')?.currentValue;
        if (model) {
          const info = this.models.find((m) => m.id === model);
          st.modelId = info?.efforts.length && effort ? `${model}-${effort}` : String(model);
        }
        return;
      }
      default:
        return;
    }
  }

  private onRequest(id: number | string, method: string, p: Json) {
    if (method !== 'session/request_permission') {
      log.warn(`unsupported agent request ${method}`);
      this.acp.respondError(id, `not supported by this client: ${method}`);
      return;
    }
    const sid = String(p.sessionId ?? '');
    const chat = this.hub.peek(`${AGENT}:${sid}`);
    if (!chat) {
      this.acp.respond(id, { outcome: { outcome: 'cancelled' } });
      return;
    }
    const st = this.sess(sid);
    const call: Json = p.toolCall ?? {};
    if (call.toolCallId) this.upsertTool(chat, st, { ...call, status: 'pending' });
    const tc = { ...(st.tools.get(String(call.toolCallId)) ?? {}), ...call };
    const item = toolItem(tc, {});
    const options = ((p.options ?? []) as Json[]).map((o) => ({ optionId: String(o.optionId), name: String(o.name ?? o.optionId), kind: String(o.kind ?? '') }));
    const aid = String(id);
    this.pending.set(aid, { rpcId: id, sid, toolCallId: call.toolCallId ? String(call.toolCallId) : undefined, options });
    const a: Approval = { id: aid, kind: 'tool', tool: item.tool, title: item.title, toolItemId: item.id, createdAt: Date.now(), input: item.input };
    if (tc.kind === 'execute') {
      a.kind = 'command';
      a.command = item.title;
      a.detail = item.subtitle ?? (chat.cwd ? `в ${chat.cwd}` : undefined);
    } else if (item.category === 'edit' || item.category === 'write') {
      a.kind = 'fileChange';
      a.diffs = item.diffs;
      a.detail = item.subtitle;
    } else a.detail = item.subtitle;
    const always = options.filter((o) => o.kind === 'allow_always');
    if (always.length) a.options = always.map((o) => ({ id: o.optionId, label: o.name === 'Always Allow' || o.name === 'Always allow' ? 'Разрешать всегда' : o.name }));
    chat.addApproval(a);
  }

  // ------------------------------------------------------------ capabilities

  // ------------------------------------------------------------ limits

  /**
   * Limits come from `agy -p "/usage" --output-format json` — the CLI's own non-interactive answer to /usage: no agent
   * turn, no quota spent, ~3 s. Asked after every turn, at start and when the UI is opened if older than an hour; never
   * on a timer. One run at a time; a request during a run repeats it once afterwards.
   */
  private usageRun: Promise<void> | null = null;
  private usageAgain = false;

  private limitsNow() {
    return store.limits().find((l) => l.agent === AGENT);
  }

  private usageStale() {
    const l = this.limitsNow();
    return !l?.windows.length || Date.now() - l.updatedAt > 60 * 60_000;
  }

  /** Store plan + windows (absent windows: keep the last ones and their time). */
  private publishLimits(windows?: LimitWindow[]) {
    const prev = this.limitsNow();
    this.hub.setLimits({
      agent: AGENT,
      plan: this.tier ?? prev?.plan,
      windows: windows ?? prev?.windows ?? [],
      updatedAt: windows ? Date.now() : (prev?.updatedAt ?? 0),
    });
  }

  refreshUsage() {
    if (this.usageRun) {
      this.usageAgain = true;
      return;
    }
    this.usageRun = this.fetchUsage()
      .catch((e) => log.warn('usage', (e as Error).message))
      .finally(() => {
        this.usageRun = null;
        if (this.usageAgain) {
          this.usageAgain = false;
          setTimeout(() => this.refreshUsage(), 3000);
        }
      });
  }

  clientConnected() {
    if (!this.usageRun && this.usageStale()) this.refreshUsage();
  }

  private async fetchUsage() {
    if (!this.models.length) await this.listModels().catch(() => {});
    const out = await new Promise<string>((resolve, reject) =>
      execFile(config.agyBin, ['-p', '/usage', '--output-format', 'json'], { timeout: 60_000, cwd: config.home, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout)),
      ),
    );
    const j: Json = JSON.parse(out);
    const groups = (j?.command?.data?.groups ?? []) as Json[];
    if (j?.status !== 'SUCCESS' || !groups.length) throw new Error(`agy /usage: ${String(j?.error ?? j?.response ?? 'нет данных').slice(0, 200)}`);
    const windows: LimitWindow[] = [];
    for (const g of groups) {
      const name = String(g.name ?? '');
      const groupId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const group = name.replace(/ models$/i, '').replace(/^Claude and GPT$/i, 'Claude и GPT').replace(/^Gemini 4 /, '');
      const listed = String(g.description ?? '').match(/Models within this group:\s*(.+)$/);
      const labels = listed ? listed[1].replace(/\.$/, '').split(/,\s*/) : [name];
      const models = this.models.filter((m) => labels.includes(m.label)).map((m) => m.id);
      for (const b of (g.buckets ?? []) as Json[]) {
        const left = Number(b.remaining_fraction);
        if (!Number.isFinite(left)) continue;
        const reset = Date.parse(b.reset_time ?? '');
        windows.push({
          id: String(b.id ?? `${groupId}-${b.window}`),
          label: b.window === '5h' ? '5 часов' : b.window === 'weekly' ? 'Неделя' : String(b.name ?? b.window),
          usedPercent: Math.max(0, Math.min(100, Math.round((1 - left) * 100))),
          resetsAt: Number.isFinite(reset) ? Math.round(reset / 1000) : undefined,
          groupId,
          group,
          models,
        });
      }
    }
    if (!windows.length) throw new Error('agy /usage: нет окон');
    this.publishLimits(windows);
    log.info(`usage: ${windows.map((w) => `${w.group} ${w.label} ${w.usedPercent}%`).join(', ')}`);
  }

  /** `agy models` — the model list before any session was opened in this process. */
  private listModels(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(config.agyBin, ['models'], { timeout: 60_000, cwd: config.home }, (err, stdout) => {
        if (err) return reject(err);
        const list = stdout
          .split('\n')
          .map((l) => l.split('\t'))
          .filter((x) => x.length >= 2 && x[0].trim())
          .map(([modelId, name]) => ({ modelId: modelId.trim(), name: name.trim() }));
        if (!list.length) return reject(new Error('agy models: пустой список'));
        this.defaultModelId ??= list[0].modelId;
        this.models = parseModels(list, this.defaultModelId);
        resolve();
      });
    });
  }

  async capabilities(): Promise<AgentCapabilities> {
    if (this.capsCache && Date.now() - this.capsCache.at < 10 * 60_000) return this.capsCache.caps;
    try {
      await this.acp.start();
      if (!this.models.length) await this.listModels();
      if (!this.modesKnown) this.modes = (sandboxLikely(this.acp.pid) ? ['auto', ...STATIC_MODES] : STATIC_MODES).map((m) => modeInfo(m));
      const def = this.models.find((m) => m.isDefault) ?? this.models[0];
      const modes = this.modes;
      const caps: AgentCapabilities = {
        agent: AGENT,
        available: true,
        plan: this.tier,
        models: this.models,
        permissionModes: modes,
        defaults: { model: def?.id, effort: def?.defaultEffort, permissionMode: modes.some((m) => m.id === 'auto') ? 'auto' : 'accept-edits' },
        commands: this.commands,
      };
      this.capsCache = { at: Date.now(), caps };
      return caps;
    } catch (e) {
      return { agent: AGENT, available: false, error: (e as Error).message, models: [], permissionModes: this.modes, defaults: {}, commands: [] };
    }
  }
}
