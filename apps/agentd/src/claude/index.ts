import { TASK_PROMPT_INSTRUCTIONS } from '../task-prompt.ts';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';
import type {
  AgentCapabilities,
  AgentLimits,
  Approval,
  ApprovalDecision,
  ApprovalOption,
  ChatSettings,
  LimitWindow,
  PermissionModeInfo,
  SendPayload,
} from '@mcc-agents/protocol';
import type { Adapter, Hub } from '../hub.ts';
import type { Chat } from '../chat.ts';
import { config } from '../config.ts';
import { logger } from '../log.ts';
import { store } from '../store.ts';
import { classifyClaudeTool } from '../tools.ts';
import { ClaudeNormalizer } from './normalize.ts';
import { loadClaudeHistory, scanClaudeSessions, sessionFile } from './sessions.ts';
import { UPLOADS_DIR } from '../uploads.ts';

const log = logger('claude');
type Json = Record<string, any>;

export const CLAUDE_MODES: PermissionModeInfo[] = [
  { id: 'default', label: 'Спрашивать', description: 'Подтверждать команды и правки' },
  { id: 'acceptEdits', label: 'Принимать правки', description: 'Правки файлов без вопросов, команды — с подтверждением' },
  { id: 'plan', label: 'План', description: 'Только читает код и предлагает план' },
  { id: 'auto', label: 'Авто', description: 'Claude сам решает, что безопасно' },
  { id: 'bypassPermissions', label: 'Полный доступ', description: 'Команды и файлы без подтверждений, в пределах прав пользователя Linux' },
];

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5 часов',
  seven_day: 'Неделя',
  seven_day_opus: 'Неделя · Opus',
  seven_day_sonnet: 'Неделя · Sonnet',
  seven_day_oauth_apps: 'Неделя · приложения',
};

function destLabel(d?: string) {
  switch (d) {
    case 'session':
      return 'до конца сессии';
    case 'localSettings':
      return 'в этом проекте';
    case 'projectSettings':
      return 'в проекте (общие настройки)';
    case 'userSettings':
      return 'везде';
    default:
      return '';
  }
}

function suggestionLabel(s: Json): string {
  if (s.type === 'addRules' || s.type === 'replaceRules') {
    const rules = (s.rules ?? []).map((r: Json) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return `${s.behavior === 'deny' ? 'Всегда запрещать' : 'Всегда разрешать'} ${rules} ${destLabel(s.destination)}`.trim();
  }
  if (s.type === 'setMode') {
    const m = CLAUDE_MODES.find((x) => x.id === s.mode);
    return s.mode === 'acceptEdits' ? `Принимать правки ${destLabel(s.destination)}`.trim() : `Режим «${m?.label ?? s.mode}»`;
  }
  if (s.type === 'addDirectories') return `Доступ к ${(s.directories ?? []).join(', ')} ${destLabel(s.destination)}`.trim();
  return 'Разрешить и запомнить';
}

/** Is another (non-agentd) process running this session? Returns its pid. */
function foreignProcess(sessionId: string, own: Set<number>): number | undefined {
  let pids: string[] = [];
  try {
    pids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return;
  }
  for (const p of pids) {
    const pid = Number(p);
    if (own.has(pid) || pid === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${p}/cmdline`, 'utf8');
      if (cmd.includes(sessionId) && /claude/.test(cmd)) return pid;
    } catch {
      /* gone */
    }
  }
}

function cliEnv() {
  return { ...process.env, CLAUDE_CODE_ENTRYPOINT: config.claudeEntrypoint };
}

const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

// ====================================================================== process per chat

class ClaudeProc {
  chat: Chat;
  child: ChildProcessWithoutNullStreams;
  norm: ClaudeNormalizer;
  private adapter: ClaudeAdapter;
  private seq = 0;
  private waiters = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private requests = new Map<string, Json>(); // approval id → can_use_tool request
  private stderrTail: string[] = [];
  pendingTurns = 0;
  exited = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastRetryNotice = 0;

  constructor(adapter: ClaudeAdapter, chat: Chat, settings: ChatSettings, resume: boolean) {
    this.adapter = adapter;
    this.chat = chat;
    this.norm = new ClaudeNormalizer(chat, false);
    const args = [
      ...BASE_ARGS,
      '--allow-dangerously-skip-permissions',
      '--append-system-prompt', TASK_PROMPT_INSTRUCTIONS,
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
      // attached files live outside the project
      '--add-dir',
      UPLOADS_DIR,
      ...(resume ? ['--resume', chat.nativeId] : ['--session-id', chat.nativeId]),
    ];
    if (settings.model && settings.model !== 'default') args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    const permissionMode = CLAUDE_MODES.find((mode) => mode.id === settings.permissionMode)?.id;
    args.push('--permission-mode', permissionMode && permissionMode !== 'default' ? permissionMode : 'manual');
    log.info(`spawn ${chat.id} resume=${resume} cwd=${chat.cwd}`);
    this.child = spawn(config.claudeBin, args, { cwd: chat.cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let ev: Json;
      try {
        ev = JSON.parse(line);
      } catch {
        log.debug('non-json stdout', line.slice(0, 200));
        return;
      }
      try {
        this.handle(ev);
      } catch (e) {
        log.error('handle event', e);
      }
    });
    this.child.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      log.debug(`stderr ${chat.id}`, s.slice(0, 500));
    });
    this.child.on('error', (e) => {
      log.error(`spawn failed ${chat.id}`, e);
      this.onExit(-1);
    });
    this.child.on('exit', (code) => this.onExit(code ?? -1));
    this.child.stdin.on('error', () => {});
    chat.patch({ live: true, busyElsewhere: undefined, error: undefined });
    this.ctrl('initialize', { hooks: null })
      .then((r) => this.adapter.learnInit(chat.cwd, r))
      .catch((e) => log.warn(`initialize ${chat.id}`, e));
    this.bumpIdle();
  }

  get pid() {
    return this.child.pid ?? -1;
  }

  private write(obj: Json) {
    if (this.exited) throw new Error('процесс claude уже завершён');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  ctrl(subtype: string, extra: Json = {}, timeoutMs = 30_000): Promise<Json> {
    const id = `agentd_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`control ${subtype} timeout`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      try {
        this.write({ type: 'control_request', request_id: id, request: { subtype, ...extra } });
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(id);
        reject(e as Error);
      }
    });
  }

  sendUser(p: SendPayload, uuid: string) {
    const content: Json[] = [];
    if (p.text) content.push({ type: 'text', text: p.text });
    for (const img of p.images ?? []) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    this.write({
      type: 'user',
      uuid,
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: content.length === 1 && content[0].type === 'text' ? p.text : content },
    });
    this.pendingTurns++;
    this.chat.setStatus('running');
    this.bumpIdle();
  }

  private bumpIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.maybeIdleClose(), config.claudeIdleMs);
  }

  private maybeIdleClose() {
    const busy =
      this.pendingTurns > 0 || this.chat.state.approvals.length > 0 || this.chat.state.tasks.some((t) => t.status === 'running');
    if (busy) return this.bumpIdle();
    log.info(`idle close ${this.chat.id}`);
    this.close();
  }

  close() {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {}
    setTimeout(() => {
      if (!this.exited) this.child.kill('SIGTERM');
    }, 5000);
  }

  private onExit(code: number) {
    if (this.exited) return;
    this.exited = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('claude exited'));
    }
    this.waiters.clear();
    const chat = this.chat;
    log.info(`exit ${chat.id} code=${code}`);
    const wasBusy = this.pendingTurns > 0;
    chat.settleRunningTools('interrupted');
    for (const t of chat.state.tasks) if (t.status === 'running') chat.upsertTask({ id: t.id, status: 'stopped', endedAt: Date.now() });
    const tail = this.stderrTail.join('').trim().split('\n').slice(-3).join('\n');
    const patch: Json = { live: false, approvals: [] };
    if (code !== 0 && code !== 143 && (wasBusy || tail)) {
      patch.error = `claude завершился (код ${code})${tail ? ': ' + tail.slice(0, 400) : ''}`;
      chat.notice('error', patch.error);
    }
    chat.patch(patch);
    chat.setStatus(code !== 0 && wasBusy ? 'error' : 'idle');
    if (wasBusy) chat.finished(code === 0 ? 'done' : 'error');
    this.adapter.procExited(this);
  }

  // ------------------------------------------------------------ events

  private handle(ev: Json) {
    this.chat.touch();
    switch (ev.type) {
      case 'stream_event':
        this.norm.stream(ev);
        return;
      case 'assistant':
        this.norm.assistant(ev, Date.now());
        if (!ev.parent_tool_use_id && ev.message?.usage) this.usageFrom(ev.message.usage, ev.message.model);
        return;
      case 'user':
        if (ev.isReplay && typeof ev.message?.content === 'string' && !ev.message.content.includes('<local-command')) return;
        this.norm.user(ev, Date.now());
        return;
      case 'system':
        this.system(ev);
        return;
      case 'result':
        this.result(ev);
        return;
      case 'rate_limit_event':
        this.adapter.rateLimit(ev.rate_limit_info);
        return;
      case 'control_request':
        this.controlRequest(ev);
        return;
      case 'control_cancel_request':
        this.requests.delete(ev.request_id);
        this.chat.removeApproval(ev.request_id);
        return;
      case 'control_response': {
        const r = ev.response ?? {};
        const w = this.waiters.get(r.request_id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiters.delete(r.request_id);
        if (r.subtype === 'error') w.reject(new Error(r.error ?? 'control error'));
        else w.resolve(r.response ?? {});
        return;
      }
      default:
        return;
    }
  }

  private usageFrom(u: Json, model?: string) {
    const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    const win = store.window(model) ?? this.chat.state.usage?.contextWindow ?? 0;
    this.chat.setUsage({ contextTokens: ctx, contextWindow: win, percent: win ? Math.round((ctx / win) * 100) : 0 });
  }

  private system(ev: Json) {
    const chat = this.chat;
    switch (ev.subtype) {
      case 'init':
        chat.patch({ settings: { ...chat.state.settings, model: chat.state.settings.model ?? ev.model, permissionMode: ev.permissionMode } });
        if (ev.model) chat.setSummary({ model: ev.model });
        return;
      case 'status':
        if (ev.status === 'requesting' || ev.status === 'running') chat.setStatus('running');
        else if (ev.status === 'compacting') chat.notice('info', 'Сжимаю контекст…');
        return;
      case 'thinking_tokens':
        this.norm.thinkingTokens(ev.estimated_tokens ?? 0);
        return;
      case 'task_started': {
        chat.upsertTask({
          id: ev.task_id,
          description: ev.description ?? '',
          type: ev.task_type ?? 'task',
          status: 'running',
          toolItemId: ev.tool_use_id,
          startedAt: Date.now(),
        });
        const t = ev.tool_use_id ? chat.tool(ev.tool_use_id) : undefined;
        if (t && ev.is_backgrounded) chat.upsert({ ...t, backgroundTaskId: ev.task_id });
        return;
      }
      case 'task_updated': {
        const st = ev.patch?.status;
        if (st) chat.upsertTask({ id: ev.task_id, status: mapTaskStatus(st), endedAt: ev.patch?.end_time });
        return;
      }
      case 'task_notification':
        chat.upsertTask({
          id: ev.task_id,
          status: mapTaskStatus(ev.status),
          outputFile: ev.output_file || undefined,
          summary: ev.summary,
          endedAt: Date.now(),
        });
        return;
      case 'compact_boundary':
        chat.notice('info', 'Контекст сжат (compact)');
        return;
      case 'api_retry':
        if (Date.now() - this.lastRetryNotice > 30_000) {
          this.lastRetryNotice = Date.now();
          chat.notice('warn', 'API не ответил, Claude повторяет запрос…');
        }
        return;
      case 'session_title_changed':
        if (ev.title) chat.setSummary({ title: ev.title });
        return;
      case 'model_fallback':
        chat.notice('warn', `Модель недоступна, переключился на ${ev.fallback_model ?? ev.to ?? 'запасную'}`);
        return;
      default:
        return;
    }
  }

  private result(ev: Json) {
    const chat = this.chat;
    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    for (const [model, mu] of Object.entries((ev.modelUsage ?? {}) as Record<string, Json>)) {
      if (mu?.contextWindow) store.setWindow(model, mu.contextWindow);
    }
    let outcome: 'done' | 'error' | 'interrupted' = 'done';
    if (ev.terminal_reason === 'aborted_streaming' || ev.terminal_reason === 'aborted_tools') {
      outcome = 'interrupted';
      chat.settleRunningTools('interrupted');
    } else if (ev.is_error) {
      outcome = 'error';
      const text = typeof ev.result === 'string' && ev.result ? ev.result : (ev.errors ?? []).join('\n') || `Ошибка: ${ev.subtype}`;
      chat.notice('error', text.slice(0, 2000));
    }
    if (this.pendingTurns === 0) {
      chat.settleRunningTools('interrupted');
      chat.setStatus('idle');
      chat.finished(outcome);
    }
    this.ctrl('get_context_usage', {}, 15_000)
      .then((r) => {
        if (r.maxTokens) chat.setUsage({ contextTokens: r.totalTokens ?? 0, contextWindow: r.maxTokens, percent: r.percentage ?? 0 });
      })
      .catch(() => {});
    this.bumpIdle();
  }

  private controlRequest(ev: Json) {
    const req = ev.request ?? {};
    if (req.subtype !== 'can_use_tool') {
      // hooks / MCP-over-SDK are not used by agentd — answer so the CLI does not wait forever
      try {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `unsupported: ${req.subtype}` } });
      } catch {}
      return;
    }
    this.requests.set(ev.request_id, req);
    const name = String(req.tool_name);
    const input = (req.input ?? {}) as Json;
    const c = classifyClaudeTool(name, input);
    const options: ApprovalOption[] = (req.permission_suggestions ?? []).map((s: Json, i: number) => ({ id: `s${i}`, label: suggestionLabel(s) }));
    const a: Approval = {
      id: ev.request_id,
      kind: 'tool',
      tool: name,
      title: c.title || name,
      detail: req.description && req.description !== c.title ? req.description : req.decision_reason,
      input,
      options,
      toolItemId: req.tool_use_id,
      createdAt: Date.now(),
    };
    if (name === 'AskUserQuestion') {
      a.kind = 'question';
      a.title = 'Claude задаёт вопрос';
      a.questions = Array.isArray(input.questions) ? input.questions : [];
      a.options = [];
    } else if (name === 'ExitPlanMode') {
      a.kind = 'plan';
      a.title = 'План готов — начинать?';
      a.plan = String(input.plan ?? '');
      a.options = [{ id: 'acceptEdits', label: 'Да, и принимать правки без вопросов' }];
    } else if (c.category === 'bash') {
      a.kind = 'command';
      a.command = String(input.command ?? '');
    } else if (c.category === 'edit' || c.category === 'write') {
      a.kind = 'fileChange';
      a.diffs = c.diffs;
    }
    this.chat.addApproval(a);
  }

  decide(d: ApprovalDecision) {
    const req = this.requests.get(d.approvalId);
    if (!req) throw new Error('запрос уже неактуален');
    this.requests.delete(d.approvalId);
    let response: Json;
    if (d.decision === 'allow') {
      const input = { ...(req.input ?? {}) };
      if (d.answers) input.answers = d.answers;
      response = { behavior: 'allow', updatedInput: input };
      if (d.optionId === 'acceptEdits') {
        response.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
      } else if (d.optionId?.startsWith('s')) {
        const s = (req.permission_suggestions ?? [])[Number(d.optionId.slice(1))];
        if (s) response.updatedPermissions = [s];
      }
    } else {
      response = { behavior: 'deny', message: d.message || 'Пользователь отклонил это действие.' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: d.approvalId, response } });
    this.chat.removeApproval(d.approvalId);
    if (d.decision === 'allow' && d.optionId === 'acceptEdits')
      this.chat.patch({ settings: { ...this.chat.state.settings, permissionMode: 'acceptEdits' } });
    this.bumpIdle();
  }

  async applySettings(next: ChatSettings) {
    const cur = this.chat.state.settings;
    if (next.model && next.model !== cur.model) await this.ctrl('set_model', { model: next.model });
    if (next.permissionMode !== cur.permissionMode && CLAUDE_MODES.some((mode) => mode.id === next.permissionMode)) {
      await this.ctrl('set_permission_mode', { mode: next.permissionMode === 'default' ? 'manual' : next.permissionMode });
    }
    if (next.effort && next.effort !== cur.effort) await this.ctrl('apply_flag_settings', { settings: { effortLevel: next.effort } });
  }
}

function mapTaskStatus(s: string): 'running' | 'completed' | 'failed' | 'stopped' | 'killed' {
  if (s === 'completed' || s === 'failed' || s === 'stopped' || s === 'killed' || s === 'running') return s;
  if (s === 'error') return 'failed';
  return 'running';
}

// ====================================================================== adapter

export class ClaudeAdapter implements Adapter {
  readonly agent = 'claude' as const;
  private hub: Hub;
  private procs = new Map<string, ClaudeProc>();
  private caps = new Map<string, { at: number; caps: AgentCapabilities }>();
  private probing = new Map<string, Promise<AgentCapabilities>>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  list() {
    return scanClaudeSessions();
  }

  isLive(chat: Chat) {
    return this.procs.has(chat.id);
  }

  async load(chat: Chat) {
    if (this.procs.has(chat.id)) return; // live state is authoritative
    const file = sessionFile(chat.nativeId);
    if (!file) return;
    const norm = await loadClaudeHistory(chat, file);
    if (norm.lastUsage) {
      const u = norm.lastUsage;
      const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      const win = store.window(norm.lastModel) ?? 0;
      chat.state.usage = { contextTokens: ctx, contextWindow: win, percent: win ? Math.round((ctx / win) * 100) : 0 };
    }
    const meta = store.meta(chat.id);
    chat.state.settings = { model: meta.settings?.model ?? norm.lastModel, effort: meta.settings?.effort, permissionMode: meta.settings?.permissionMode };
  }

  private ensure(chat: Chat, resume: boolean): ClaudeProc {
    const existing = this.procs.get(chat.id);
    if (existing && !existing.exited) return existing;
    const own = new Set([...this.procs.values()].map((p) => p.pid));
    const foreign = resume ? foreignProcess(chat.nativeId, own) : undefined;
    if (foreign) {
      chat.patch({ busyElsewhere: `pid ${foreign}` });
      throw new Error(`Эта сессия уже открыта в другом процессе claude (pid ${foreign}) — например, в терминале. Закройте его и повторите.`);
    }
    const p = new ClaudeProc(this, chat, chat.state.settings, resume);
    this.procs.set(chat.id, p);
    return p;
  }

  async prepare(): Promise<string> {
    return randomUUID();
  }

  async send(chat: Chat, message: SendPayload, uuid: string, isNew: boolean) {
    const p = this.ensure(chat, !isNew && sessionFile(chat.nativeId) !== undefined);
    p.sendUser(message, uuid);
  }

  async interrupt(chat: Chat) {
    const p = this.procs.get(chat.id);
    if (!p) return;
    await p.ctrl('interrupt', {}, 10_000).catch((e) => {
      log.warn('interrupt failed, killing', e);
      p.child.kill('SIGINT');
    });
  }

  async decide(chat: Chat, d: ApprovalDecision) {
    const p = this.procs.get(chat.id);
    if (!p) throw new Error('процесс claude не запущен — запрос устарел');
    p.decide(d);
  }

  async applySettings(chat: Chat, s: ChatSettings) {
    const p = this.procs.get(chat.id);
    if (p && !p.exited) await p.applySettings(s);
  }

  async stopTask(chat: Chat, taskId: string) {
    const p = this.procs.get(chat.id);
    if (!p) throw new Error('процесс claude не запущен');
    await p.ctrl('stop_task', { task_id: taskId });
  }

  async release(chat: Chat) {
    this.procs.get(chat.id)?.close();
  }

  procExited(p: ClaudeProc) {
    if (this.procs.get(p.chat.id) === p) this.procs.delete(p.chat.id);
  }

  shutdown() {
    for (const p of this.procs.values()) p.child.kill('SIGTERM');
  }

  // ------------------------------------------------------------ limits / capabilities

  rateLimit(info: Json) {
    if (!info) return;
    const windows: LimitWindow[] = [];
    const uw = (info.unifiedWindows ?? {}) as Record<string, Json>;
    for (const [id, w] of Object.entries(uw)) {
      if (typeof w?.utilization !== 'number') continue;
      windows.push({ id, label: LIMIT_LABELS[id] ?? id, usedPercent: Math.round(w.utilization * 100), resetsAt: w.resetsAt, status: w.status });
    }
    if (!windows.length && info.rateLimitType) {
      windows.push({ id: info.rateLimitType, label: LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType, usedPercent: info.utilization != null ? Math.round(info.utilization * 100) : 0, resetsAt: info.resetsAt, status: info.status });
    }
    if (!windows.length) return;
    const prev = store.limits().find((l) => l.agent === 'claude');
    const l: AgentLimits = { agent: 'claude', plan: prev?.plan, windows, updatedAt: Date.now() };
    this.hub.setLimits(l);
  }

  learnInit(cwd: string, r: Json) {
    const caps = this.capsFromInit(r);
    this.caps.set(cwd, { at: Date.now(), caps });
    if (caps.plan) {
      const prev = store.limits().find((l) => l.agent === 'claude');
      if (prev && prev.plan !== caps.plan) this.hub.setLimits({ ...prev, plan: caps.plan });
      if (!prev) this.hub.setLimits({ agent: 'claude', plan: caps.plan, windows: [], updatedAt: Date.now() });
    }
  }

  private capsFromInit(r: Json): AgentCapabilities {
    const models = (r.models ?? []).map((m: Json) => ({
      id: String(m.value),
      label: m.value === 'default' ? `По умолчанию (${String(m.description ?? '').split('·')[0].trim() || m.resolvedModel})` : String(m.displayName ?? m.value),
      description: m.description,
      efforts: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [],
      isDefault: m.value === 'default',
    }));
    return {
      agent: 'claude',
      available: true,
      plan: r.account?.subscriptionType,
      models,
      permissionModes: CLAUDE_MODES,
      defaults: { model: 'default', permissionMode: r.current_permission_mode ?? 'default' },
      commands: (r.commands ?? []).map((c: Json) => ({ name: String(c.name), description: c.description, argumentHint: c.argumentHint })),
    };
  }

  /** Spawn a short-lived `claude -p` just for `initialize` (no API call, no tokens). */
  capabilities(cwd: string): Promise<AgentCapabilities> {
    const hit = this.caps.get(cwd);
    if (hit && Date.now() - hit.at < 10 * 60_000) return Promise.resolve(hit.caps);
    const running = this.probing.get(cwd);
    if (running) return running;
    const pr = new Promise<AgentCapabilities>((resolve) => {
      const child = spawn(config.claudeBin, [...BASE_ARGS, '--no-session-persistence'], { cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const done = (c: AgentCapabilities) => {
        clearTimeout(timer);
        try {
          child.stdin.end();
        } catch {}
        setTimeout(() => child.kill('SIGTERM'), 2000);
        resolve(c);
      };
      const fail = (msg: string) =>
        done({ agent: 'claude', available: false, error: msg, models: [], permissionModes: CLAUDE_MODES, defaults: {}, commands: [] });
      const timer = setTimeout(() => fail('claude не ответил за 20 секунд'), 20_000);
      child.on('error', (e) => fail(`не удалось запустить claude: ${e.message}`));
      child.stdin.on('error', () => {});
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'control_response' && ev.response?.request_id === 'probe') {
            if (ev.response.subtype === 'error') return fail(String(ev.response.error));
            const caps = this.capsFromInit(ev.response.response ?? {});
            this.caps.set(cwd, { at: Date.now(), caps });
            this.learnInit(cwd, ev.response.response ?? {});
            done(caps);
          }
        } catch {}
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'probe', request: { subtype: 'initialize', hooks: null } }) + '\n');
    }).finally(() => this.probing.delete(cwd));
    this.probing.set(cwd, pr);
    return pr;
  }
}
