'use client';

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownIcon, ChevronRightIcon, Loader2Icon, WorkflowIcon } from 'lucide-react';
import type { ChatItem, ChatState, ToolItem } from '@mcc-agents/protocol';
import { canBranch } from '@/lib/format';
import { FileBase, FileHints, Markdown, TaskPrompt } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { pathsNamed, touchedPaths } from '@/lib/files';
import { store } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { MessageActions, NoticeLine, ThinkingBlock, ToolCard, UserBubble, isVisible } from './items';

function useTree(items: ChatItem[]) {
  return useMemo(() => {
    const children = new Map<string, ChatItem[]>();
    const top: ChatItem[] = [];
    const ids = new Set(items.map((i) => i.id));
    for (const it of items) {
      if (!isVisible(it)) continue;
      if (it.parentId && ids.has(it.parentId)) {
        const arr = children.get(it.parentId) ?? [];
        arr.push(it);
        children.set(it.parentId, arr);
      } else top.push(it);
    }
    return { top, children };
  }, [items]);
}

const Item = memo(function Item({
  item,
  chatId,
  cwd,
  tree,
}: {
  item: ChatItem;
  chatId: string;
  cwd: string;
  tree: Map<string, ChatItem[]>;
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'assistant':
      return (
        <div className="min-w-0">
          <Markdown text={item.text} taskPrompts />
          {item.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle" />}
        </div>
      );
    case 'thinking':
      return <ThinkingBlock item={item} />;
    case 'notice':
      return <NoticeLine item={item} />;
    case 'tool': {
      const kids = tree.get(item.id);
      return (
        <ToolCard item={item as ToolItem} chatId={chatId} cwd={cwd} childCount={kids?.filter((k) => k.kind === 'tool').length}>
          {kids?.map((k) => (
            <Item key={k.id} item={k} chatId={chatId} cwd={cwd} tree={tree} />
          ))}
        </ToolCard>
      );
    }
  }
});

function secs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`;
}

function useNow(live = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

function Working({ since, label }: { since: number; label: string }) {
  const now = useNow();
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      <span>
        {label} · {secs(now - since)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- folded steps

/** A row of the list: an item as is, or a turn's steps (thinking, tools, words in between) folded into one line. */
type Row = { kind: 'item'; item: ChatItem } | { kind: 'work'; id: string; items: ChatItem[] };

/**
 * Each turn (what follows a user message) keeps on view only what comes after its last step — the answer; everything up
 * to that step folds. Warnings and errors stay on view.
 */
function foldTurns(top: ChatItem[]): Row[] {
  const rows: Row[] = [];
  let turn: ChatItem[] = [];
  const flush = () => {
    let last = -1;
    turn.forEach((it, i) => {
      if (it.kind === 'tool' || it.kind === 'thinking') last = i;
    });
    const steps = turn.slice(0, last + 1);
    const work = steps.filter((it) => !(it.kind === 'notice' && it.level !== 'info'));
    if (work.length) rows.push({ kind: 'work', id: work[0].id, items: work });
    for (const it of steps) if (!work.includes(it)) rows.push({ kind: 'item', item: it });
    for (const it of turn.slice(last + 1)) rows.push({ kind: 'item', item: it });
    turn = [];
  };
  for (const it of top) {
    if (it.kind !== 'user') {
      turn.push(it);
      continue;
    }
    flush();
    rows.push({ kind: 'item', item: it });
  }
  flush();
  return rows;
}

function plural(n: number, [one, few, many]: [string, string, string]): string {
  const d = n % 10;
  const h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? one : d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many}`;
}

const STEP_WORDS: Partial<Record<ToolItem['category'], [string, string, string]>> = {
  bash: ['команда', 'команды', 'команд'],
  read: ['чтение', 'чтения', 'чтений'],
  edit: ['правка', 'правки', 'правок'],
  write: ['файл', 'файла', 'файлов'],
  search: ['поиск', 'поиска', 'поисков'],
  web: ['запрос в сеть', 'запроса в сеть', 'запросов в сеть'],
  task: ['субагент', 'субагента', 'субагентов'],
};

/** «3 команды · 2 запроса в сеть»; what has no word of its own counts as «действие». */
function stepsSummary(items: ChatItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    // the task list has its own bar; ToolSearch only loads other tools
    if (it.kind !== 'tool' || it.category === 'todo' || it.tool === 'ToolSearch') continue;
    const k = STEP_WORDS[it.category] ? it.category : 'other';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => plural(n, STEP_WORDS[k as ToolItem['category']] ?? ['действие', 'действия', 'действий']))
    .join(' · ');
}

/** What the agent is doing right now, for the folded line of a running turn. */
function currentStep(items: ChatItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'thinking') return 'Думает…';
    if (it.kind === 'tool') {
      if (it.status !== 'running' && it.status !== 'pending') return 'Работает…';
      const what = it.category === 'web' ? 'Ищет в интернете' : it.category === 'read' ? 'Читает' : it.category === 'bash' ? 'Выполняет' : 'Работает';
      return `${what}: ${it.title.split('\n')[0]}`;
    }
  }
  return 'Работает…';
}

function WorkGroup({ items, live, since, chatId, cwd, tree }: { items: ChatItem[]; live: boolean; since: number; chatId: string; cwd: string; tree: Map<string, ChatItem[]> }) {
  const [open, setOpen] = useState(false);
  const now = useNow(live);
  const errors = items.filter((it) => it.kind === 'tool' && it.status === 'error').length;
  const steps = stepsSummary(items);
  const first = items[0].ts;
  const end = items.at(-1)?.ts;
  const took = first && end && end - first >= 1000 ? secs(end - first) : '';
  const label = live
    ? `${currentStep(items)} · ${secs(now - since)}`
    : [steps ? `Работал${took ? ` ${took}` : ''}` : `Думал${took ? ` ${took}` : ''}`, steps].filter(Boolean).join(' · ');
  return (
    <div className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-10 max-w-full items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground hover:text-foreground"
      >
        {live ? <Loader2Icon className="size-3.5 shrink-0 animate-spin" /> : <WorkflowIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{label}</span>
        {!live && errors > 0 && <span className="shrink-0 text-destructive">· {plural(errors, ['ошибка', 'ошибки', 'ошибок'])}</span>}
        <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-3 border-l-2 pl-3">
          {items.map((it) => (
            <div key={it.id} className="min-w-0">
              <Item item={it} chatId={chatId} cwd={cwd} tree={tree} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MessageList({ state, footer }: { state: ChatState; footer?: React.ReactNode }) {
  const { top, children: tree } = useTree(state.items);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const chatId = state.summary.id;
  const busy = state.summary.status === 'running' || state.summary.status === 'starting';
  const workingSince = useMemo(() => {
    for (let i = state.items.length - 1; i >= 0; i--) if (state.items[i].kind === 'user') return state.items[i].ts ?? Date.now();
    return Date.now();
  }, [state.items]);

  // Stick to the bottom while the answer streams in — unless the reader moved up.
  // Any upward move (wheel, finger, keys, scrollbar) unsticks at once; while a finger is on the screen we never scroll
  // (on iOS a programmatic scroll also kills the momentum); it sticks again only when the reader comes back down to the
  // bottom, presses «Вниз» or sends a message.
  const touching = useRef(false);
  const lastTop = useRef(0);
  const maxTop = (el: HTMLDivElement) => Math.max(0, el.scrollHeight - el.clientHeight);
  const toBottom = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    lastTop.current = Math.min(el.scrollTop, maxTop(el));
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current && !touching.current) toBottom(el);
  });

  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) toBottom(el);
  }, [chatId]);

  // a message of your own: back to the bottom
  const lastUserId = useMemo(() => {
    for (let i = state.items.length - 1; i >= 0; i--) if (state.items[i].kind === 'user') return state.items[i].id;
    return null;
  }, [state.items]);
  const seenUser = useRef(lastUserId);
  useEffect(() => {
    if (lastUserId === seenUser.current) return;
    seenUser.current = lastUserId;
    stick.current = true;
    setShowDown(false);
    const el = scroller.current;
    if (el) toBottom(el);
  }, [lastUserId]);

  // keep pinned to the bottom when the viewport shrinks (mobile keyboard) or the content grows by itself
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current && !touching.current) toBottom(el);
    });
    ro.observe(el);
    // content can grow without a React render (content-visibility sizing, images, code highlighting)
    if (content.current) ro.observe(content.current);
    const unstick = () => {
      if (el.scrollHeight > el.clientHeight) stick.current = false;
    };
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && unstick();
    const onKey = (e: KeyboardEvent) => ['ArrowUp', 'PageUp', 'Home'].includes(e.key) && unstick();
    const down = () => (touching.current = true);
    const up = () => (touching.current = false);
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', up, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('touchcancel', up);
    };
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    // clamp: iOS rubber-band past the end must not read as "moved up"
    const t = Math.min(Math.max(el.scrollTop, 0), maxTop(el));
    const dist = maxTop(el) - t;
    // moved up and is no longer at the bottom (content shrinking at the bottom also lowers scrollTop, but leaves dist ≈ 0)
    if (t < lastTop.current - 1 && dist > 2) stick.current = false;
    else if (t > lastTop.current && dist < 24) stick.current = true;
    lastTop.current = t;
    setShowDown(dist > 80);
  };

  const firstUserId = useMemo(() => state.items.find((i) => i.kind === 'user')?.id ?? null, [state.items]);
  const anyBusy = busy || state.summary.status === 'waiting';
  // Antigravity (ACP) has no fork / rewind
  const actions = useMemo(() => ({ chatId, firstUserId, busy: anyBusy, branching: canBranch(chatId) }), [chatId, firstUserId, anyBusy]);
  // read on click, so links don't re-render on every streamed item
  const itemsRef = useRef(state.items);
  useEffect(() => {
    itemsRef.current = state.items;
  }, [state.items]);
  const cwd = state.summary.cwd;
  const hints = useMemo(() => ({ named: (name: string) => pathsNamed(itemsRef.current, name, cwd), touched: () => touchedPaths(itemsRef.current, cwd) }), [cwd]);

  const mode = state.summary.mode ?? 'code';
  const showWork = useUi((u) => u.work[mode]);
  const rows = useMemo<Row[]>(() => (showWork ? top.map((item) => ({ kind: 'item', item })) : foldTurns(top)), [top, showWork]);
  const lastRow = rows[rows.length - 1];
  const last = top[top.length - 1];
  const streamingNow = last && ((last.kind === 'assistant' && last.streaming) || (last.kind === 'thinking' && last.streaming));
  // the folded line of the running turn shows what is going on itself
  const liveFold = busy && lastRow?.kind === 'work';

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
        <TaskPrompt.Provider value={(text) => {
          const draft = crypto.randomUUID();
          localStorage.setItem(`draft:task:${draft}`, text);
          store.navigate({ kind: 'new', agent: state.summary.agent, cwd: state.summary.cwd, mode: state.summary.mode ?? 'code', draft });
        }}>
        <FileBase.Provider value={state.summary.cwd}>
        <FileHints.Provider value={hints}>
        <MessageActions.Provider value={actions}>
        <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-3 pb-6 pt-4 md:px-6">
          {top.length === 0 && !busy && <div className="py-16 text-center text-sm text-muted-foreground">Сообщений пока нет</div>}
          {rows.map((r) =>
            r.kind === 'work' ? (
              <div key={`work:${r.id}`} className="min-w-0">
                <WorkGroup items={r.items} live={liveFold && r === lastRow} since={workingSince} chatId={chatId} cwd={state.summary.cwd} tree={tree} />
              </div>
            ) : (
              <div key={r.item.id} className={cn('min-w-0', r.item.kind === 'user' && 'mt-2')} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
                <Item item={r.item} chatId={chatId} cwd={state.summary.cwd} tree={tree} />
              </div>
            ),
          )}
          {busy && !streamingNow && !liveFold && <Working since={workingSince} label={state.summary.status === 'starting' ? 'Запускаю' : 'Работает'} />}
          {footer}
        </div>
        </MessageActions.Provider>
        </FileHints.Provider>
        </FileBase.Provider>
        </TaskPrompt.Provider>
      </div>
      {showDown && (
        <Button
          size="icon"
          variant="outline"
          className="absolute bottom-3 left-1/2 size-9 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => {
            stick.current = true;
            setShowDown(false);
            const el = scroller.current;
            if (el) toBottom(el);
          }}
          aria-label="Вниз"
        >
          <ArrowDownIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}
