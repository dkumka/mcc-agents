'use client';

import { memo, useState, type ReactNode } from 'react';
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClipboardListIcon,
  FilePenLineIcon,
  FilePlusIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  PlugIcon,
  SearchIcon,
  ShieldXIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import type { ChatItem, NoticeItem, ThinkingItem, ToolCategory, ToolItem, UserItem } from '@mcc-agents/protocol';
import { FileDiffView } from '@/components/diff-view';
import { CopyButton, Markdown } from '@/components/markdown';
import { api } from '@/lib/api';
import { duration, shortPath, tokens } from '@/lib/format';
import { cn } from '@/lib/utils';

const ICONS: Record<ToolCategory, typeof TerminalIcon> = {
  bash: TerminalIcon,
  edit: FilePenLineIcon,
  write: FilePlusIcon,
  read: FileTextIcon,
  search: SearchIcon,
  web: GlobeIcon,
  task: BotIcon,
  todo: ListTodoIcon,
  plan: ClipboardListIcon,
  question: MessageCircleQuestionIcon,
  mcp: PlugIcon,
  skill: SparklesIcon,
  other: WrenchIcon,
};

const LABELS: Record<ToolCategory, string> = {
  bash: 'Команда',
  edit: 'Правка',
  write: 'Запись',
  read: 'Чтение',
  search: 'Поиск',
  web: 'Веб',
  task: 'Субагент',
  todo: 'Задачи',
  plan: 'План',
  question: 'Вопрос',
  mcp: 'MCP',
  skill: 'Skill',
  other: '',
};

// ---------------------------------------------------------------- user / assistant / notice

export const UserBubble = memo(function UserBubble({ item }: { item: UserItem }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2.5 text-[15px] leading-relaxed md:max-w-[80%] md:text-sm">
        {item.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-2">
            {item.images.map((im, i) =>
              im.dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={im.dataUrl} alt={im.name ?? 'изображение'} className="max-h-48 rounded-lg border object-contain" />
              ) : (
                <span key={i} className="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                  🖼 {im.name ?? 'изображение'}
                </span>
              ),
            )}
          </div>
        ) : null}
        <div className="whitespace-pre-wrap break-anywhere">{item.text}</div>
      </div>
    </div>
  );
});

export function NoticeLine({ item }: { item: NoticeItem }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 px-1 text-xs',
        item.level === 'error' ? 'text-destructive' : item.level === 'warn' ? 'text-warning' : 'text-muted-foreground',
      )}
    >
      {item.level === 'error' ? <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> : <span className="mt-1.5 size-1 shrink-0 rounded-full bg-current" />}
      <span className="whitespace-pre-wrap break-anywhere">{item.text}</span>
    </div>
  );
}

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(false);
  const hasText = !!item.text.trim();
  const label = item.streaming ? 'Думает…' : 'Размышления';
  return (
    <div className="text-sm">
      <button
        type="button"
        disabled={!hasText}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground enabled:hover:text-foreground"
      >
        {item.streaming ? <Loader2Icon className="size-3.5 animate-spin" /> : <BrainIcon className="size-3.5" />}
        <span>{label}</span>
        {item.tokens ? <span className="tabular opacity-70">· ~{tokens(item.tokens)} токенов</span> : null}
        {hasText && <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && hasText && (
        <div className="mt-1 border-l-2 pl-3 text-muted-foreground">
          <Markdown text={item.text} className="text-[13px]" />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tools

function StatusIcon({ item }: { item: ToolItem }) {
  switch (item.status) {
    case 'pending':
    case 'running':
      return <Loader2Icon className="size-3.5 animate-spin text-info" />;
    case 'done':
      return <CheckIcon className="size-3.5 text-success" />;
    case 'error':
      return <XIcon className="size-3.5 text-destructive" />;
    case 'denied':
      return <ShieldXIcon className="size-3.5 text-warning" />;
    case 'interrupted':
      return <SquareIcon className="size-3 text-muted-foreground" />;
  }
}

function OutputBlock({ item, chatId, tail }: { item: ToolItem; chatId: string; tail?: boolean }) {
  const [full, setFull] = useState<string | null>(null);
  const text = full ?? item.output ?? '';
  if (!text.trim()) return null;
  const shown = tail ? text.split('\n').slice(-8).join('\n') : text;
  return (
    <div className="relative">
      <pre className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-anywhere rounded-md bg-muted/50 p-2.5 font-mono text-[12px] leading-relaxed">
        {shown}
      </pre>
      <div className="absolute right-1 top-1 flex gap-1">
        {item.outputTruncated && !full && !tail && (
          <button
            type="button"
            className="rounded-md bg-background/80 px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => api.output(chatId, item.id).then((r) => setFull(r.output))}
          >
            Полностью
          </button>
        )}
        {!tail && <CopyButton text={text} className="bg-background/80" />}
      </div>
    </div>
  );
}

type Todo = { content?: string; status?: string; activeForm?: string };

function TodoList({ todos }: { todos: Todo[] }) {
  return (
    <ul className="space-y-1 text-sm">
      {todos.map((t, i) => (
        <li key={i} className="flex items-start gap-2">
          {t.status === 'completed' ? (
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
          ) : t.status === 'in_progress' ? (
            <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-info" />
          ) : (
            <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function ToolBody({ item, chatId, cwd, children }: { item: ToolItem; chatId: string; cwd: string; children?: ReactNode }) {
  const input = (item.input ?? {}) as Record<string, unknown>;
  switch (item.category) {
    case 'bash':
      return (
        <div className="space-y-2">
          {item.title.includes('\n') || item.title.length > 90 ? (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-anywhere rounded-md border bg-background p-2.5 font-mono text-[12px]">
              <span className="select-none text-muted-foreground">$ </span>
              {item.title}
            </pre>
          ) : null}
          <OutputBlock item={item} chatId={chatId} />
          {item.exitCode != null && item.exitCode !== 0 && <div className="text-xs text-destructive">Код выхода: {item.exitCode}</div>}
        </div>
      );
    case 'edit':
    case 'write':
      return (
        <div className="space-y-2">
          {(item.diffs ?? []).map((d, i) => (
            <FileDiffView key={i} diff={d} cwd={cwd} maxHeight="max-h-80" />
          ))}
          {item.status !== 'done' && <OutputBlock item={item} chatId={chatId} />}
        </div>
      );
    case 'todo':
      return <TodoList todos={(Array.isArray(input.todos) ? input.todos : []) as Todo[]} />;
    case 'plan':
      return (
        <div className="space-y-2">
          {typeof input.plan === 'string' && <Markdown text={input.plan} />}
          {item.output && item.status !== 'done' && <OutputBlock item={item} chatId={chatId} />}
        </div>
      );
    case 'question': {
      const qs = (Array.isArray(input.questions) ? input.questions : []) as { question?: string }[];
      return (
        <div className="space-y-2 text-sm">
          {qs.map((q, i) => (
            <div key={i} className="font-medium">
              {q.question}
            </div>
          ))}
          <OutputBlock item={item} chatId={chatId} />
        </div>
      );
    }
    case 'task':
      return (
        <div className="space-y-2">
          {typeof input.prompt === 'string' && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Задание</summary>
              <div className="mt-1 whitespace-pre-wrap break-anywhere">{input.prompt}</div>
            </details>
          )}
          {children && <div className="space-y-2 border-l-2 pl-3">{children}</div>}
          {item.output && item.status !== 'running' && <Markdown text={item.output} className="text-[13px]" />}
        </div>
      );
    case 'read':
    case 'search':
    case 'web':
      return <OutputBlock item={item} chatId={chatId} />;
    default:
      return (
        <div className="space-y-2">
          {item.input && Object.keys(input).length > 0 ? (
            <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-anywhere rounded-md bg-muted/50 p-2.5 font-mono text-[11.5px]">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          ) : null}
          <OutputBlock item={item} chatId={chatId} />
        </div>
      );
  }
}

function defaultOpen(item: ToolItem): boolean {
  if (item.category === 'edit' || item.category === 'write') return item.status !== 'denied' && !!item.diffs?.length;
  if (item.category === 'todo' || item.category === 'plan') return true;
  if (item.category === 'task') return item.status === 'running';
  return false;
}

export const ToolCard = memo(function ToolCard({
  item,
  chatId,
  cwd,
  childCount,
  children,
}: {
  item: ToolItem;
  chatId: string;
  cwd: string;
  childCount?: number;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? defaultOpen(item);
  const Icon = ICONS[item.category];
  const label = LABELS[item.category] || item.tool;
  const title =
    item.category === 'edit' || item.category === 'write' || item.category === 'read' ? shortPath(item.title, cwd) : item.title || item.tool;
  const running = item.status === 'running' || item.status === 'pending';
  const showTail = running && item.category === 'bash' && !isOpen && !!item.output;
  const stats = (() => {
    if (item.category !== 'edit' && item.category !== 'write') return null;
    let add = 0;
    let del = 0;
    for (const d of item.diffs ?? []) {
      if (d.unified) for (const l of d.unified.split('\n')) {
        if (l.startsWith('+') && !l.startsWith('+++')) add++;
        else if (l.startsWith('-') && !l.startsWith('---')) del++;
      }
      else {
        add += d.newText ? d.newText.split('\n').length : 0;
        del += d.oldText ? d.oldText.split('\n').length : 0;
      }
    }
    return { add, del };
  })();

  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card text-sm', item.status === 'error' && 'border-destructive/40', item.status === 'denied' && 'border-warning/40')}>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        className="flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/50"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
        <span className={cn('min-w-0 flex-1 truncate', item.category === 'bash' || item.category === 'search' ? 'font-mono text-[12.5px]' : 'font-mono text-[12.5px]')}>
          {title}
        </span>
        {item.subtitle && <span className="hidden max-w-[30%] shrink truncate text-xs text-muted-foreground md:inline">{item.subtitle}</span>}
        {stats && (stats.add || stats.del) ? (
          <span className="shrink-0 font-mono text-xs tabular">
            {stats.add > 0 && <span className="text-diff-add">+{stats.add}</span>} {stats.del > 0 && <span className="text-diff-del">−{stats.del}</span>}
          </span>
        ) : null}
        {childCount ? <span className="shrink-0 text-xs text-muted-foreground tabular">{childCount} шаг.</span> : null}
        {item.backgroundTaskId && <span className="shrink-0 rounded bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info">фон</span>}
        {item.durationMs ? <span className="hidden shrink-0 text-xs text-muted-foreground tabular sm:inline">{duration(item.durationMs)}</span> : null}
        <StatusIcon item={item} />
        <ChevronRightIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
      </button>
      {showTail && (
        <div className="border-t px-2.5 py-2">
          <OutputBlock item={item} chatId={chatId} tail />
        </div>
      )}
      {isOpen && (
        <div className="border-t px-2.5 py-2.5">
          <ToolBody item={item} chatId={chatId} cwd={cwd}>
            {children}
          </ToolBody>
        </div>
      )}
    </div>
  );
});

export function isVisible(it: ChatItem): boolean {
  if (it.kind === 'assistant') return !!it.text || !!it.streaming;
  // the CLI often stores thinking without text (signature only): nothing to show
  if (it.kind === 'thinking') return !!it.text.trim() || !!it.streaming || !!it.tokens;
  return true;
}
