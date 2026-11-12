import type {
  AgentKind,
  Approval,
  BgTask,
  ChatItem,
  ChatState,
  ChatStatus,
  ChatSummary,
  ServerMessage,
  ToolItem,
  Usage,
} from '@mcc-agents/protocol';
import { config } from './config.ts';

export interface ChatSink {
  toSubscribers(chat: Chat, msg: ServerMessage): void;
  summaryChanged(chat: Chat): void;
  turnFinished(chat: Chat, outcome: 'done' | 'error' | 'interrupted'): void;
  approvalAdded(chat: Chat, a: Approval): void;
}

/** Shorten big tool output for the wire: head + tail, full text stays in memory (/api/output). */
export function wireItem(item: ChatItem): ChatItem {
  if (item.kind !== 'tool' || !item.output || item.output.length <= config.inlineOutputMax) return item;
  const head = item.output.slice(0, 4000);
  const tail = item.output.slice(-(config.inlineOutputMax - 4000));
  return { ...item, output: `${head}\n\n… (${item.output.length - head.length - tail.length} символов скрыто) …\n\n${tail}`, outputTruncated: true };
}

/**
 * In-memory state of one chat: normalized items + live state, with change fan-out.
 * Adapters write into it; the hub forwards changes to subscribed browsers.
 */
export class Chat {
  readonly id: string;
  readonly agent: AgentKind;
  readonly nativeId: string;
  state: ChatState;
  loaded = false;
  loading: Promise<void> | null = null;
  lastActivity = Date.now();
  private idx = new Map<string, number>();
  private pending = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private sink: ChatSink;

  constructor(summary: ChatSummary, sink: ChatSink) {
    this.id = summary.id;
    this.agent = summary.agent;
    this.nativeId = summary.nativeId;
    this.sink = sink;
    this.state = { summary, items: [], approvals: [], tasks: [], todos: [], settings: {}, live: false };
  }

  get summary() {
    return this.state.summary;
  }

  get cwd() {
    return this.state.summary.cwd;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ------------------------------------------------------------ items

  resetItems(items: ChatItem[]) {
    this.state.items = items;
    this.idx.clear();
    items.forEach((it, i) => this.idx.set(it.id, i));
  }

  get(id: string): ChatItem | undefined {
    const i = this.idx.get(id);
    return i === undefined ? undefined : this.state.items[i];
  }

  tool(id: string): ToolItem | undefined {
    const it = this.get(id);
    return it?.kind === 'tool' ? it : undefined;
  }

  upsert(item: ChatItem, opts: { silent?: boolean } = {}) {
    this.flushDeltas(item.id);
    const i = this.idx.get(item.id);
    if (i === undefined) {
      this.idx.set(item.id, this.state.items.length);
      this.state.items.push(item);
    } else {
      this.state.items[i] = item;
    }
    this.touch();
    if (!opts.silent) this.sink.toSubscribers(this, { t: 'item', chatId: this.id, item: wireItem(item) });
  }

  /** Merge fields into an existing item (no-op if missing). */
  update<T extends ChatItem>(id: string, patch: Partial<T>) {
    const cur = this.get(id);
    if (!cur) return;
    this.upsert({ ...cur, ...patch } as ChatItem);
  }

  /** Streamed text: appended to assistant/thinking text or tool output, batched for the wire. */
  delta(id: string, text: string) {
    const it = this.get(id);
    if (!it || !text) return;
    if (it.kind === 'assistant' || it.kind === 'thinking') it.text += text;
    else if (it.kind === 'tool') {
      const before = it.output?.length ?? 0;
      it.output = (it.output ?? '') + text;
      if (before > config.inlineOutputMax) return; // already truncated on the wire
      if (it.output.length > config.inlineOutputMax) {
        this.sink.toSubscribers(this, { t: 'item', chatId: this.id, item: wireItem(it) });
        return;
      }
    } else return;
    this.touch();
    this.pending.set(id, (this.pending.get(id) ?? '') + text);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushDeltas(), 40);
  }

  private flushDeltas(only?: string) {
    if (only !== undefined) {
      // an upsert of this item supersedes its pending delta
      this.pending.delete(only);
      return;
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const [itemId, text] of this.pending) this.sink.toSubscribers(this, { t: 'delta', chatId: this.id, itemId, text });
    this.pending.clear();
  }

  notice(level: 'info' | 'warn' | 'error', text: string) {
    this.upsert({ kind: 'notice', id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), level, text });
  }

  /** Mark tools still running as interrupted (process died / turn aborted). */
  settleRunningTools(status: 'interrupted' | 'error' = 'interrupted') {
    for (const it of this.state.items) {
      if (it.kind === 'tool' && (it.status === 'running' || it.status === 'pending') && !it.backgroundTaskId) {
        this.upsert({ ...it, status });
      }
      if ((it.kind === 'assistant' || it.kind === 'thinking') && it.streaming) this.upsert({ ...it, streaming: false });
    }
  }

  // ------------------------------------------------------------ live state

  patch(p: Partial<Omit<ChatState, 'items' | 'summary'>>) {
    Object.assign(this.state, p);
    this.sink.toSubscribers(this, { t: 'state', chatId: this.id, patch: p });
  }

  setSummary(p: Partial<ChatSummary>) {
    let changed = false;
    for (const [k, v] of Object.entries(p)) {
      if ((this.state.summary as unknown as Record<string, unknown>)[k] !== v) changed = true;
    }
    if (!changed) return;
    this.state.summary = { ...this.state.summary, ...p };
    this.sink.summaryChanged(this);
  }

  setStatus(status: ChatStatus) {
    const s = this.state.approvals.length && status === 'running' ? 'waiting' : status;
    this.setSummary({ status: s, updatedAt: Date.now() });
  }

  setUsage(u: Usage) {
    this.patch({ usage: u });
  }

  addApproval(a: Approval) {
    this.patch({ approvals: [...this.state.approvals.filter((x) => x.id !== a.id), a] });
    this.setSummary({ status: 'waiting' });
    this.sink.approvalAdded(this, a);
  }

  removeApproval(id: string) {
    if (!this.state.approvals.some((a) => a.id === id)) return;
    const approvals = this.state.approvals.filter((a) => a.id !== id);
    this.patch({ approvals });
    if (!approvals.length && this.summary.status === 'waiting') this.setSummary({ status: 'running' });
  }

  clearApprovals() {
    if (this.state.approvals.length) this.patch({ approvals: [] });
  }

  upsertTask(t: Partial<BgTask> & { id: string }) {
    const cur = this.state.tasks.find((x) => x.id === t.id);
    const next: BgTask = cur
      ? { ...cur, ...t }
      : { description: '', type: 'local_bash', status: 'running', startedAt: Date.now(), ...t };
    this.patch({ tasks: [...this.state.tasks.filter((x) => x.id !== t.id), next] });
  }

  finished(outcome: 'done' | 'error' | 'interrupted') {
    this.sink.turnFinished(this, outcome);
  }

  snapshot(): ChatState {
    this.flushDeltas();
    return { ...this.state, items: this.state.items.map(wireItem) };
  }
}
