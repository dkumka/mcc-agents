'use client';

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownIcon, Loader2Icon } from 'lucide-react';
import type { ChatItem, ChatState, ToolItem } from '@mcc-agents/protocol';
import { FileBase, Markdown, TaskPrompt } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';
import { NoticeLine, ThinkingBlock, ToolCard, UserBubble, isVisible } from './items';

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

function Working({ since, label }: { since: number; label: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((now - since) / 1000));
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <Loader2Icon className="size-3.5 animate-spin" />
      <span>
        {label} · {s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`}
      </span>
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

  const last = top[top.length - 1];
  const streamingNow = last && ((last.kind === 'assistant' && last.streaming) || (last.kind === 'thinking' && last.streaming));

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto overscroll-contain">
        <TaskPrompt.Provider value={(text) => {
          const draft = crypto.randomUUID();
          localStorage.setItem(`draft:task:${draft}`, text);
          store.navigate({ kind: 'new', agent: state.summary.agent, cwd: state.summary.cwd, mode: state.summary.mode ?? 'code', draft });
        }}>
        <FileBase.Provider value={state.summary.cwd}>
        <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-3 pb-6 pt-4 md:px-6">
          {top.length === 0 && !busy && <div className="py-16 text-center text-sm text-muted-foreground">Сообщений пока нет</div>}
          {top.map((it) => (
            <div key={it.id} className={cn('min-w-0', it.kind === 'user' && 'mt-2')} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
              <Item item={it} chatId={chatId} cwd={state.summary.cwd} tree={tree} />
            </div>
          ))}
          {busy && !streamingNow && <Working since={workingSince} label={state.summary.status === 'starting' ? 'Запускаю' : 'Работает'} />}
          {footer}
        </div>
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
