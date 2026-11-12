import type { ChatItem, ImageRef, TodoEntry, ToolItem, ToolStatus } from '@mcc-agents/protocol';
import type { Chat } from '../chat.ts';
import { classifyClaudeTool, patchToUnified } from '../tools.ts';

type Json = Record<string, any>;

const MAX_INLINE_IMAGE = 400_000; // base64 chars kept as data: URL in history

function stripReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: Json) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[изображение]' : ''))
    .filter(Boolean)
    .join('\n');
}

function tagValue(s: string, tag: string): string | undefined {
  const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

/**
 * Turns Claude Code transcript lines / stream-json events into ChatItems.
 * Used both for history (.jsonl, silent) and for the live stream.
 */
export class ClaudeNormalizer {
  private chat: Chat;
  private silent: boolean;
  /** assistant message id → number of content blocks seen (matches stream block index). */
  private blocks = new Map<string, number>();
  private streamMsg = new Map<string | null, string>(); // parent_tool_use_id → current streaming message id
  private streamItems = new Map<string, string>(); // `${msgId}:${index}` → item id
  lastModel?: string;
  lastUsage?: Json;

  constructor(chat: Chat, silent: boolean) {
    this.chat = chat;
    this.silent = silent;
  }

  private put(item: ChatItem) {
    this.chat.upsert(item, { silent: this.silent });
  }

  // ------------------------------------------------------------ assistant

  assistant(ev: Json, ts?: number) {
    const msg = ev.message as Json;
    if (!msg || !Array.isArray(msg.content)) return;
    const parentId = (ev.parent_tool_use_id ?? null) as string | null;
    const mid = String(msg.id ?? ev.uuid ?? Math.random());
    if (msg.model && msg.model !== '<synthetic>') this.lastModel = msg.model;
    if (msg.usage && !parentId) this.lastUsage = msg.usage;
    for (const block of msg.content as Json[]) {
      const n = this.blocks.get(mid) ?? 0;
      this.blocks.set(mid, n + 1);
      const id = block.type === 'tool_use' || block.type === 'server_tool_use' ? String(block.id) : `${mid}:${n}`;
      this.block(id, block, parentId, ts, msg.model);
    }
  }

  private block(id: string, block: Json, parentId: string | null, ts?: number, model?: string) {
    switch (block.type) {
      case 'text': {
        if (!block.text && !this.chat.get(id)) return;
        this.put({ kind: 'assistant', id, ts, parentId, text: block.text ?? '', model, streaming: false });
        return;
      }
      case 'thinking':
      case 'redacted_thinking': {
        const prev = this.chat.get(id);
        const text = block.thinking || (prev?.kind === 'thinking' ? prev.text : '') || '';
        this.put({ kind: 'thinking', id, ts, parentId, text, tokens: prev?.kind === 'thinking' ? prev.tokens : undefined, streaming: false });
        return;
      }
      case 'tool_use':
      case 'server_tool_use': {
        const name = String(block.name);
        const c = classifyClaudeTool(name, block.input);
        const prev = this.chat.tool(id);
        const item: ToolItem = {
          kind: 'tool',
          id,
          ts: prev?.ts ?? ts,
          parentId,
          tool: name,
          category: c.category,
          title: c.title,
          subtitle: c.subtitle,
          input: block.input,
          diffs: prev?.diffs && prev.diffs.some((d) => d.unified) ? prev.diffs : c.diffs,
          status: prev && prev.status !== 'pending' ? prev.status : 'running',
          output: prev?.output,
          backgroundTaskId: prev?.backgroundTaskId,
        };
        this.put(item);
        if (name === 'TodoWrite') this.todos(block.input);
        return;
      }
      case 'web_search_tool_result': {
        const t = this.chat.tool(String(block.tool_use_id));
        if (t) {
          const results = Array.isArray(block.content) ? block.content : [];
          this.put({ ...t, status: 'done', output: results.map((r: Json) => `${r.title ?? ''} — ${r.url ?? ''}`).join('\n') });
        }
        return;
      }
      default:
        return;
    }
  }

  private todos(input: unknown) {
    const list = (input as Json)?.todos;
    if (!Array.isArray(list)) return;
    const todos: TodoEntry[] = list.map((t: Json) => ({
      content: String(t.content ?? t.activeForm ?? ''),
      status: t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending',
    }));
    if (this.silent) this.chat.state.todos = todos;
    else this.chat.patch({ todos });
  }

  // ------------------------------------------------------------ user

  user(ev: Json, ts?: number) {
    if (ev.isMeta || ev.isVisibleInTranscriptOnly) return;
    const msg = ev.message as Json;
    if (!msg) return;
    const parentId = (ev.parent_tool_use_id ?? null) as string | null;
    const uid = String(ev.uuid ?? `u-${ts ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    if (ev.isCompactSummary) {
      this.put({ kind: 'notice', id: uid, ts, level: 'info', text: 'Контекст сжат (compact)' });
      return;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      this.userText(uid, content, [], ts, parentId);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    const images: ImageRef[] = [];
    for (const b of content as Json[]) {
      if (b.type === 'tool_result') this.toolResult(b, ev.tool_use_result ?? ev.toolUseResult);
      else if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image') {
        const data = b.source?.data;
        images.push({
          mediaType: b.source?.media_type ?? 'image/png',
          dataUrl: typeof data === 'string' && data.length < MAX_INLINE_IMAGE ? `data:${b.source.media_type};base64,${data}` : undefined,
        });
      }
    }
    if (texts.length || images.length) this.userText(uid, texts.join('\n'), images, ts, parentId);
  }

  private userText(id: string, raw: string, images: ImageRef[], ts: number | undefined, parentId: string | null) {
    if (parentId) return; // the subagent's prompt — shown inside the Task card input
    if (raw.startsWith('[Image: source:')) return; // companion line for an attached image
    if (raw.includes('<command-name>')) {
      const name = tagValue(raw, 'command-name') ?? '';
      const args = tagValue(raw, 'command-args') ?? '';
      this.put({ kind: 'notice', id, ts, level: 'info', text: `${name.startsWith('/') ? name : '/' + name} ${args}`.trim() });
      return;
    }
    const out = tagValue(raw, 'local-command-stdout') ?? tagValue(raw, 'local-command-stderr');
    if (out !== undefined) {
      if (out) this.put({ kind: 'notice', id, ts, level: 'info', text: out });
      return;
    }
    if (raw.startsWith('[Request interrupted by user')) {
      this.put({ kind: 'notice', id, ts, level: 'warn', text: 'Прервано' });
      return;
    }
    if (raw.includes('<task-notification>')) {
      const summary = tagValue(raw, 'summary') ?? tagValue(raw, 'status') ?? 'Фоновая задача обновилась';
      this.put({ kind: 'notice', id, ts, level: 'info', text: `Фоновая задача: ${summary}` });
      return;
    }
    const bash = tagValue(raw, 'bash-input');
    const text = bash !== undefined ? `! ${bash}` : stripReminders(raw);
    if (!text && !images.length) return;
    this.put({ kind: 'user', id, ts, text, images: images.length ? images : undefined });
  }

  private toolResult(b: Json, extra: unknown) {
    const id = String(b.tool_use_id);
    const t = this.chat.tool(id);
    if (!t) return;
    const text = textOf(b.content);
    let status: ToolStatus = 'done';
    if (b.is_error) {
      if (/interrupted by user/i.test(text)) status = 'interrupted';
      else if (/denied|haven't granted|rejected|not allowed|permission/i.test(text)) status = 'denied';
      else status = 'error';
    }
    const next: ToolItem = { ...t, status, output: text };
    const r = (extra && typeof extra === 'object' ? extra : {}) as Json;
    if (typeof r.backgroundTaskId === 'string') next.backgroundTaskId = r.backgroundTaskId;
    if (r.interrupted) next.status = 'interrupted';
    const unified = patchToUnified(r.structuredPatch);
    if (unified) next.diffs = [{ path: String(r.filePath ?? t.title), kind: r.type === 'create' ? 'add' : 'update', unified }];
    if ((t.tool === 'Edit' || t.tool === 'Write' || t.tool === 'MultiEdit') && status === 'done') next.output = undefined;
    if (t.tool === 'Read' && typeof r.file === 'object' && r.file) {
      next.subtitle = r.file.numLines ? `${r.file.numLines} строк` : next.subtitle;
    }
    this.put(next);
  }

  // ------------------------------------------------------------ live stream (partial messages)

  stream(ev: Json) {
    const e = ev.event as Json;
    if (!e) return;
    const parent = (ev.parent_tool_use_id ?? null) as string | null;
    if (e.type === 'message_start') {
      this.streamMsg.set(parent, String(e.message?.id));
      return;
    }
    const mid = this.streamMsg.get(parent);
    if (!mid) return;
    if (e.type === 'content_block_start') {
      const b = e.content_block as Json;
      const id = b.type === 'tool_use' || b.type === 'server_tool_use' ? String(b.id) : `${mid}:${e.index}`;
      this.streamItems.set(`${mid}:${e.index}`, id);
      if (this.chat.get(id)) return;
      if (b.type === 'text') this.put({ kind: 'assistant', id, ts: Date.now(), parentId: parent, text: '', streaming: true });
      else if (b.type === 'thinking' || b.type === 'redacted_thinking')
        this.put({ kind: 'thinking', id, ts: Date.now(), parentId: parent, text: '', streaming: true });
      else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
        const c = classifyClaudeTool(String(b.name), {});
        this.put({ kind: 'tool', id, ts: Date.now(), parentId: parent, tool: String(b.name), category: c.category, title: '', input: {}, status: 'pending' });
      }
      return;
    }
    if (e.type === 'content_block_delta') {
      const id = this.streamItems.get(`${mid}:${e.index}`);
      if (!id) return;
      const d = e.delta as Json;
      if (d.type === 'text_delta') this.chat.delta(id, d.text);
      else if (d.type === 'thinking_delta') this.chat.delta(id, d.thinking);
    }
  }

  thinkingTokens(estimated: number) {
    // attach the estimate to the latest streaming thinking item
    for (let i = this.chat.state.items.length - 1; i >= 0; i--) {
      const it = this.chat.state.items[i];
      if (it.kind === 'thinking') {
        if (it.tokens !== estimated) this.put({ ...it, tokens: estimated });
        return;
      }
      if (it.kind === 'user') return;
    }
  }
}
