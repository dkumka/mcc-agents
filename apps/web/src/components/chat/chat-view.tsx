'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ActivityIcon,
  EllipsisVerticalIcon,
  FolderTreeIcon,
  GitCompareArrowsIcon,
  Loader2Icon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  TerminalIcon,
  TriangleAlertIcon,
  GitBranchIcon,
  Undo2Icon,
  XIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightLeftIcon,
  BellRingIcon,
  BellIcon,
  CheckIcon,
  FolderInputIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { AgentCapabilities, AgentKind, ChatState, SendPayload } from '@mcc-agents/protocol';
import { AGENT_NAME, AgentMark } from '@/components/agent-badge';
import { copyText } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { RenameDialog } from '@/components/chat-actions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { capsCached } from '@/lib/api';
import { setArchived } from '@/lib/archive';
import { baseName, canBranch, matchModel, shortPath, terminalCommand } from '@/lib/format';
import { store, useStore } from '@/lib/store';
import { ui, useUi, type PanelTab } from '@/lib/ui';
import { cn } from '@/lib/utils';
import { ApprovalPanel } from './approval-panel';
import { Composer } from './composer';
import { MessageList } from './message-list';
import { StatusBar } from './status-bar';
import { TodoBar } from './todo-bar';

export function useCaps(agent: AgentKind, cwd: string | undefined) {
  const [caps, setCaps] = useState<AgentCapabilities | null>(null);
  useEffect(() => {
    if (!cwd) return;
    let off = false;
    capsCached(agent, cwd)
      .then((c) => !off && setCaps(c))
      .catch(() => !off && setCaps(null));
    return () => {
      off = true;
    };
  }, [agent, cwd]);
  return caps;
}

function PanelButton({ tab, icon: Icon, label, badge }: { tab: PanelTab; icon: typeof ActivityIcon; label: string; badge?: number }) {
  const active = useUi((s) => s.panel === tab);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('relative size-9', active && 'bg-muted')} onClick={() => ui.togglePanel(tab)} aria-label={label}>
          <Icon className="size-4" />
          {badge ? <span className="absolute right-1 top-1 flex size-3.5 items-center justify-center rounded-full bg-info text-[9px] font-bold text-white">{badge}</span> : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** «Продолжение чата … из Claude» / «Продолжен в Codex …» — a link to the other end of a handoff. */
function HandoffBanner({ from, to }: { from?: string; to?: string }) {
  const other = useStore((st) => st.chats[(from ?? to)!]);
  if (!other) return null;
  return (
    <button
      type="button"
      onClick={() => store.navigate({ kind: 'chat', chatId: other.id })}
      className="flex w-full shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:px-4"
    >
      <ArrowRightLeftIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {from ? `Продолжение чата из ${AGENT_NAME[other.agent]}: «${other.title}»` : `Продолжен в ${AGENT_NAME[other.agent]}: «${other.title}»`}
      </span>
      <AgentMark agent={other.agent} className="size-3.5 text-[8px]" />
      <span className="shrink-0">Открыть →</span>
    </button>
  );
}

/** In a rolled-back chat: the original is hidden but kept — bring it back in one tap. */
function RewindBanner({ chatId, from }: { chatId: string; from: string }) {
  const original = useStore((st) => st.chats[from]);
  const key = `rewindBanner:${chatId}`;
  const [closed, setClosed] = useState(() => typeof window !== 'undefined' && localStorage.getItem(key) === '1');
  if (closed || !original?.hidden) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground md:px-4">
      <Undo2Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">Разговор откачен к более ранней точке. Исходный скрыт, файлы не тронуты.</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 shrink-0 px-2 text-xs"
        onClick={() => {
          store.unrewind(chatId);
          store.navigate({ kind: 'chat', chatId: from });
        }}
      >
        Вернуть как было
      </Button>
      <button
        type="button"
        aria-label="Скрыть"
        className="flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
        onClick={() => {
          localStorage.setItem(key, '1');
          setClosed(true);
        }}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function Header({ state, caps }: { state: ChatState; caps: AgentCapabilities | null }) {
  const s = state.summary;
  const [rename, setRename] = useState(false);
  const running = state.tasks.filter((t) => t.status === 'running').length;
  const cmd = terminalCommand(s.agent, s.nativeId, s.cwd);
  const isChat = s.mode === 'chat';
  const showWork = useUi((u) => u.work[s.mode ?? 'code']);
  return (
    <header className="pt-safe flex shrink-0 items-center gap-1 border-b bg-background/95 px-2 backdrop-blur md:px-3">
      <div className="flex h-12 w-full min-w-0 items-center gap-1">
        <SidebarTrigger className="size-9 shrink-0" />
        <div className="min-w-0 flex-1 px-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <AgentMark agent={s.agent} />
            <h1 className="min-w-0 truncate text-sm font-medium">{s.title}</h1>
            {(s.status === 'running' || s.status === 'starting') && <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />}
            {s.notifyDone && (
              <button
                type="button"
                title="Пришлю в Telegram, когда закончит — нажмите, чтобы отменить"
                aria-label="Отменить сообщение в Telegram"
                className="shrink-0 text-info hover:text-foreground"
                onClick={() => store.meta(s.id, { notifyDone: false })}
              >
                <BellRingIcon className="size-3.5" />
              </button>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={s.cwd}>
            {isChat ? ['Беседа', (caps && matchModel(caps.models, state.settings.model ?? s.model)?.label) ?? s.model].filter(Boolean).join(' · ') : `${baseName(s.cwd)} · ${shortPath(s.cwd)}`}
          </div>
        </div>
        {!isChat && <PanelButton tab="changes" icon={GitCompareArrowsIcon} label="Изменения (git)" />}
        <div className="hidden sm:contents">
          <PanelButton tab="files" icon={FolderTreeIcon} label="Файлы" />
        </div>
        {state.tasks.length > 0 && <PanelButton tab="tasks" icon={ActivityIcon} label="Фоновые задачи" badge={running || undefined} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-9" aria-label="Меню чата">
              <EllipsisVerticalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem className="py-2.5 sm:hidden" onClick={() => ui.set({ panel: 'files' })}>
              <FolderTreeIcon /> Файлы
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2.5" onClick={() => store.meta(s.id, { pinned: !s.pinned })}>
              {s.pinned ? <PinOffIcon /> : <PinIcon />} {s.pinned ? 'Открепить' : 'Закрепить'}
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2.5" onClick={() => setRename(true)}>
              <PencilIcon /> Переименовать
            </DropdownMenuItem>
            <DropdownMenuItem
              className="py-2.5"
              title={isChat ? 'Для всех бесед' : 'Для всех чатов с кодом'}
              onSelect={(e) => {
                e.preventDefault();
                ui.toggleWork(s.mode ?? 'code');
              }}
            >
              <WorkflowIcon /> <span className="flex-1">Показывать ход работы</span>
              {showWork && <CheckIcon className="text-foreground" />}
            </DropdownMenuItem>
            {isChat && (
              <DropdownMenuItem className="py-2.5" disabled={s.status === 'running' || s.status === 'starting' || s.status === 'waiting'} onClick={() => ui.set({ handoff: { chatId: s.id, project: true } })}>
                <FolderInputIcon /> Перенести в проект…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="py-2.5" disabled={s.status === 'running' || s.status === 'starting' || s.status === 'waiting'} onClick={() => ui.set({ handoff: { chatId: s.id } })}>
              <ArrowRightLeftIcon /> Продолжить в другом агенте…
            </DropdownMenuItem>
            {canBranch(s.id) && (
              <DropdownMenuItem
                className="py-2.5"
                disabled={s.status === 'running' || s.status === 'starting' || s.status === 'waiting'}
                onClick={() => ui.set({ fork: { chatId: s.id } })}
              >
                <GitBranchIcon /> Форк чата…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="py-2.5"
              onClick={() => {
                store.meta(s.id, { notifyDone: !s.notifyDone });
                toast.success(s.notifyDone ? 'Сообщение в Telegram отменено' : 'Пришлю в Telegram, когда закончит', {
                  description: s.notifyDone ? undefined : 'Один раз — если вы не будете смотреть на этот чат в момент окончания.',
                });
              }}
            >
              {s.notifyDone ? <BellRingIcon className="text-info" /> : <BellIcon />}
              {s.notifyDone ? 'Не сообщать, когда закончит' : 'Сообщить в Telegram, когда закончит'}
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2.5" onClick={() => setArchived(s.id, !s.archived)}>
              {s.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />} {s.archived ? 'Вернуть из архива' : 'В архив'}
            </DropdownMenuItem>
            <DropdownMenuItem className="py-2.5" onClick={() => window.location.reload()}>
              <RefreshCwIcon /> Обновить страницу
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="py-2.5" onClick={() => copyText(cmd).then(() => toast.success('Команда скопирована', { description: cmd }))}>
              <TerminalIcon /> Скопировать команду для терминала
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RenameDialog open={rename} onOpenChange={setRename} chatId={s.id} title={s.title} />
    </header>
  );
}

export function ChatView({ chatId }: { chatId: string }) {
  const state = useStore((s) => s.states[chatId]);
  const summary = useStore((s) => s.chats[chatId]);
  const limits = useStore((s) => s.limits);
  const connected = useStore((s) => s.connected);
  const caps = useCaps(state?.summary.agent ?? summary?.agent ?? 'claude', state?.summary.cwd ?? summary?.cwd);

  useEffect(() => {
    if (state && document.visibilityState === 'visible') store.send({ t: 'seen', chatId });
  }, [chatId, state?.items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) {
    return (
      <div className="flex h-full flex-col">
        <header className="pt-safe flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <SidebarTrigger className="size-9" />
          <div className="truncate text-sm font-medium">{summary?.title ?? 'Загрузка…'}</div>
        </header>
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {summary || !connected ? <Loader2Icon className="size-5 animate-spin" /> : 'Чат не найден'}
        </div>
      </div>
    );
  }

  const s = state.summary;
  const busy = s.status === 'running' || s.status === 'starting' || s.status === 'waiting';
  const onSend = (p: SendPayload) => {
    if (!store.sendMessage(chatId, p)) {
      toast.error('Нет соединения с сервером');
      throw new Error('offline');
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <Header state={state} caps={caps} />
      {s.rewoundFrom && <RewindBanner chatId={chatId} from={s.rewoundFrom} />}
      {s.handoffFrom && <HandoffBanner from={s.handoffFrom} />}
      {s.handoffTo && <HandoffBanner to={s.handoffTo} />}
      {s.archived && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground md:px-4">
          <ArchiveIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">Чат в архиве. Новое сообщение вернёт его в список.</span>
          <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => setArchived(s.id, false)}>
            Вернуть
          </Button>
        </div>
      )}
      {(state.error || state.busyElsewhere) && (
        <div className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-anywhere">{state.busyElsewhere ? `Сессия открыта в другом процессе (${state.busyElsewhere}). Закройте его, чтобы писать отсюда.` : state.error}</span>
        </div>
      )}
      <MessageList state={state} />
      <div className="pb-safe shrink-0 border-t bg-background/95 pt-2 backdrop-blur md:border-t-0">
        <TodoBar todos={state.todos} busy={busy} />
        <ApprovalPanel chatId={chatId} approvals={state.approvals} cwd={s.cwd} />
        <Composer
          draftKey={chatId}
          cwd={s.cwd}
          caps={caps}
          settings={state.settings}
          onSettings={(st) => store.setSettings(chatId, st)}
          busy={busy}
          onSend={onSend}
          onStop={() => store.interrupt(chatId)}
          placeholder={busy ? 'Добавить в очередь…' : undefined}
          autoFocus
        />
        <StatusBar usage={state.usage} limits={limits} agent={s.agent} model={state.settings.model} tasks={state.tasks} />
      </div>
    </div>
  );
}
