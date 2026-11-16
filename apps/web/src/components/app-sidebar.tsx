'use client';

import { useMemo, useRef, useState } from 'react';
import { ArchiveIcon, ArchiveRestoreIcon, ChevronRightIcon, CodeXmlIcon, EllipsisIcon, FolderPlusIcon, GitBranchIcon, PencilIcon, PinOffIcon, MessageCircleIcon, MoonIcon, PinIcon, PlusIcon, RefreshCwIcon, SearchIcon, SettingsIcon, SunIcon, WifiOffIcon } from 'lucide-react';
import type { ChatMode, ChatSummary } from '@mcc-agents/protocol';
import { AgentMark, StatusDot } from '@/components/agent-badge';
import { LimitsInline } from '@/components/chat/status-bar';
import { NewProjectDialog } from '@/components/new-project-dialog';
import { RenameDialog } from '@/components/chat/chat-view';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { setArchived } from '@/lib/archive';
import { ResizeHandle } from '@/components/resize-handle';
import { SettingsDialog } from '@/components/settings-dialog';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { baseName, shortPath, timeAgo } from '@/lib/format';
import { modeOf, store, useStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/**
 * A chat in the list. Its menu (pin, rename, archive): «⋯» on hover and right click with a mouse, long press on a phone.
 * Archived rows show «Вернуть» instead of «⋯».
 */
function ChatRow({
  c,
  active,
  onPick,
  onRename,
  mark,
}: {
  c: ChatSummary;
  active: boolean;
  onPick: () => void;
  onRename: (c: ChatSummary) => void;
  /** show the archive icon (search results mix archived chats with the rest) */
  mark?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  const press = useRef<number | undefined>(undefined);
  const long = useRef(false);
  const cancelPress = () => window.clearTimeout(press.current);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={(e) => {
          if (long.current) {
            // the finger is lifted after a long press: that opened the menu, not the chat
            long.current = false;
            e.preventDefault();
            return;
          }
          onPick();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(true);
        }}
        onTouchStart={() => {
          long.current = false;
          cancelPress();
          press.current = window.setTimeout(() => {
            long.current = true;
            navigator.vibrate?.(10);
            setMenu(true);
          }, 500);
        }}
        onTouchMove={cancelPress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        className="h-auto min-h-10 select-none gap-2 py-2 [-webkit-touch-callout:none] md:min-h-8 md:py-1.5"
        title={c.title}
      >
        <AgentMark agent={c.agent} className="opacity-90" />
        <span className={cn('min-w-0 flex-1 truncate', c.unread && 'font-semibold', c.archived && 'text-muted-foreground')}>{c.title}</span>
        {c.forkOf && <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" aria-label="ветка" />}
        {c.archived && mark && <ArchiveIcon className="size-3 shrink-0 text-muted-foreground" aria-label="в архиве" />}
        <StatusDot status={c.status} unread={c.unread} />
        <span className="shrink-0 text-[11px] text-muted-foreground tabular">{timeAgo(c.updatedAt)}</span>
      </SidebarMenuButton>
      {c.archived && (
        <SidebarMenuAction
          title="Вернуть из архива"
          aria-label="Вернуть из архива"
          onClick={() => setArchived(c.id, false)}
          className="top-1/2! size-7 -translate-y-1/2 bg-sidebar md:size-6"
        >
          <ArchiveRestoreIcon />
        </SidebarMenuAction>
      )}
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          {/* with a mouse: «⋯» on hover; on touch screens the menu opens by long press and this is only its anchor */}
          <SidebarMenuAction
            showOnHover
            aria-label="Меню чата"
            className={cn(
              'top-1/2! -translate-y-1/2 bg-sidebar [@media(hover:none)]:pointer-events-none [@media(hover:none)]:opacity-0',
              c.archived && 'pointer-events-none opacity-0!',
            )}
          >
            <EllipsisIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-52">
          {!c.archived && (
            <DropdownMenuItem className="py-2.5" onClick={() => store.meta(c.id, { pinned: !c.pinned })}>
              {c.pinned ? <PinOffIcon /> : <PinIcon />} {c.pinned ? 'Открепить' : 'Закрепить'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="py-2.5" onClick={() => onRename(c)}>
            <PencilIcon /> Переименовать
          </DropdownMenuItem>
          <DropdownMenuItem className="py-2.5" onClick={() => setArchived(c.id, !c.archived)}>
            {c.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />} {c.archived ? 'Вернуть из архива' : 'В архив'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** "Сегодня / Вчера / 7 дней / 30 дней / <месяц>" — like the chat list in the Claude app. */
function dateBucket(ts: number, now = new Date()): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= day) return 'Сегодня';
  if (ts >= day - 86_400_000) return 'Вчера';
  if (ts >= day - 7 * 86_400_000) return 'Последние 7 дней';
  if (ts >= day - 30 * 86_400_000) return 'Последние 30 дней';
  const d = new Date(ts);
  return d.getFullYear() === now.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function ModeSwitch({ mode }: { mode: ChatMode }) {
  const { isMobile } = useSidebar();
  const items: { m: ChatMode; label: string; icon: typeof CodeXmlIcon }[] = [
    { m: 'chat', label: 'Чат', icon: MessageCircleIcon },
    { m: 'code', label: 'Код', icon: CodeXmlIcon },
  ];
  return (
    <div role="tablist" aria-label="Режим" className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px]">
      {items.map(({ m, label, icon: Icon }) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => mode !== m && store.switchMode(m)}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors',
            isMobile ? 'h-9' : 'h-8',
            mode === m
              ? 'bg-background text-foreground shadow-sm dark:border dark:border-input dark:bg-input/30'
              : 'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground',
          )}
        >
          <Icon className="size-4" /> {label}
        </button>
      ))}
    </div>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const dark = theme === 'dark';
  return (
    <Button variant="ghost" size="icon" className="size-8" onClick={() => setTheme(dark ? 'light' : 'dark')} aria-label={dark ? 'Светлая тема' : 'Тёмная тема'} title={dark ? 'Светлая тема' : 'Тёмная тема'}>
      {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </Button>
  );
}

export function AppSidebar() {
  const chats = useStore((s) => s.chats);
  const route = useStore((s) => s.route);
  const mode = useStore(modeOf);
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(() => typeof window !== 'undefined' && localStorage.getItem('archiveOpen') === '1');
  const [archiveLimit, setArchiveLimit] = useState(20);
  const [newProject, setNewProject] = useState(false);
  const limits = useStore((s) => s.limits);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const { isMobile, setOpenMobile } = useSidebar();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState(false);
  const activeId = route.kind === 'chat' ? route.chatId : null;

  const { pinned, groups, dated, archived } = useMemo(() => {
    const list = Object.values(chats)
      // hidden: the original of a rolled-back chat (or an undone rollback) — kept, not listed; the open one stays visible
      .filter((c) => (c.mode ?? 'code') === mode && (!c.hidden || c.id === activeId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const ql = q.trim().toLowerCase();
    // archived chats live in their own section; a search looks through them too (marked with the archive icon)
    const archived = list.filter((c) => c.archived);
    const filtered = ql
      ? list.filter((c) => c.title.toLowerCase().includes(ql) || (mode === 'code' && c.cwd.toLowerCase().includes(ql)))
      : list.filter((c) => !c.archived);
    const pinned = filtered.filter((c) => c.pinned);
    const by = new Map<string, ChatSummary[]>();
    const dated = new Map<string, ChatSummary[]>();
    for (const c of filtered) {
      if (c.pinned) continue;
      const key = mode === 'chat' ? dateBucket(c.updatedAt) : c.cwd;
      const into = mode === 'chat' ? dated : by;
      const arr = into.get(key) ?? [];
      arr.push(c);
      into.set(key, arr);
    }
    const groups = [...by.entries()].sort((a, b) => b[1][0].updatedAt - a[1][0].updatedAt);
    return { pinned, groups, dated: [...dated.entries()], archived };
  }, [chats, q, mode, activeId]);

  const pick = (id: string) => {
    store.navigate({ kind: 'chat', chatId: id });
    if (isMobile) setOpenMobile(false);
  };
  const newChat = (cwd?: string) => {
    store.navigate({ kind: 'new', cwd, mode });
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar>
      <SidebarHeader className="pt-safe gap-2">
        <div className="flex h-10 items-center gap-2 px-1">
          <div className="flex size-7 items-center justify-center rounded-md bg-foreground font-mono text-xs font-bold text-background">&gt;_</div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="text-sm font-semibold">mcc agents</div>
            <div className="truncate text-[11px] text-muted-foreground">Claude Code · Codex</div>
          </div>
          {!connected && everConnected && <WifiOffIcon className="size-4 text-destructive" aria-label="нет связи" />}
        </div>
        <ModeSwitch mode={mode} />
        <div className="flex gap-1.5">
          <Button className="h-10 flex-1 justify-start gap-2 md:h-9" onClick={() => newChat()}>
            <PlusIcon className="size-4" /> {mode === 'chat' ? 'Новая беседа' : 'Новый чат'}
          </Button>
          {mode === 'code' && (
            <Button variant="outline" size="icon" className="size-10 shrink-0 md:size-9" onClick={() => setNewProject(true)} aria-label="Новый проект" title="Новый проект в ~/dev">
              <FolderPlusIcon className="size-4" />
            </Button>
          )}
        </div>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === 'chat' ? 'Поиск бесед' : 'Поиск чатов'}
            className="h-9 w-full rounded-md border bg-background pl-8 pr-2 text-sm outline-none focus:border-ring"
          />
        </div>
      </SidebarHeader>
      <SidebarContent className="scrollbar-thin">
        {pinned.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>
              <PinIcon className="mr-1 size-3" /> Закреплённые
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pinned.map((c) => (
                  <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} onRename={setRenaming} mark />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {dated.map(([label, list]) => (
          <SidebarGroup key={label} className="py-1">
            <SidebarGroupLabel>{label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {list.map((c) => (
                  <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} onRename={setRenaming} mark />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
        {groups.map(([cwd, list]) => {
          const limit = expanded[cwd] || q ? list.length : 6;
          const isCollapsed = collapsed[cwd] && !q;
          return (
            <SidebarGroup key={cwd} className="py-1">
              <SidebarGroupLabel className="cursor-pointer select-none gap-1 pr-8" title={cwd} onClick={() => setCollapsed((s) => ({ ...s, [cwd]: !s[cwd] }))}>
                <ChevronRightIcon className={cn('size-3 transition-transform', !isCollapsed && 'rotate-90')} />
                <span className="truncate">{baseName(cwd) || cwd}</span>
                <span className="ml-1 truncate font-normal opacity-60">{shortPath(cwd).replace(/\/[^/]+$/, '')}</span>
              </SidebarGroupLabel>
              <SidebarGroupAction title="Новый чат в этом проекте" onClick={() => newChat(cwd)} className="size-7 md:size-5">
                <PlusIcon />
              </SidebarGroupAction>
              {!isCollapsed && (
                <SidebarGroupContent>
                  <SidebarMenu>
                    {list.slice(0, limit).map((c) => (
                      <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} onRename={setRenaming} mark />
                    ))}
                    {list.length > limit && (
                      <SidebarMenuItem>
                        <SidebarMenuButton className="text-xs text-muted-foreground" onClick={() => setExpanded((s) => ({ ...s, [cwd]: true }))}>
                          Ещё {list.length - limit}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              )}
            </SidebarGroup>
          );
        })}
        {archived.length > 0 && !q.trim() && (
          <SidebarGroup className="py-1">
            <SidebarGroupLabel
              className="cursor-pointer select-none gap-1"
              onClick={() =>
                setArchiveOpen((v) => {
                  localStorage.setItem('archiveOpen', v ? '0' : '1');
                  return !v;
                })
              }
            >
              <ChevronRightIcon className={cn('size-3 transition-transform', (archiveOpen || archived.some((c) => c.id === activeId)) && 'rotate-90')} />
              <ArchiveIcon className="size-3" /> Архив
              <span className="ml-1 font-normal opacity-60 tabular">{archived.length}</span>
            </SidebarGroupLabel>
            {(archiveOpen || archived.some((c) => c.id === activeId)) && (
              <SidebarGroupContent>
                <SidebarMenu>
                  {archived.slice(0, archiveLimit).map((c) => (
                    <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} onRename={setRenaming} />
                  ))}
                  {archived.length > archiveLimit && (
                    <SidebarMenuItem>
                      <SidebarMenuButton className="text-xs text-muted-foreground" onClick={() => setArchiveLimit((n) => n + 20)}>
                        Ещё {archived.length - archiveLimit}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            )}
          </SidebarGroup>
        )}
        {!groups.length && !dated.length && !pinned.length && (
          <div className="px-4 py-6 text-sm text-muted-foreground">
            {q ? 'Ничего не найдено' : !connected ? 'Подключаюсь…' : archived.length ? 'Всё в архиве — откройте его ниже.' : mode === 'chat' ? 'Бесед пока нет. Спросите о чём угодно — без проекта и папки.' : 'Чатов пока нет'}
          </div>
        )}
      </SidebarContent>
      <SidebarFooter className="pb-safe gap-1 border-t">
        <div className="space-y-1 px-1 text-[11px] text-muted-foreground">
          {(['claude', 'codex'] as const).map((a) => (
            <div key={a} className="flex items-center gap-1.5">
              <AgentMark agent={a} className="size-3.5 text-[8px]" />
              <LimitsInline limits={limits} agent={a} />
              {!limits.find((l) => l.agent === a)?.windows.length && <span>лимиты появятся после первого запроса</span>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <a href="https://mcc.babochkin.com" className="flex-1 truncate px-1 text-[11px] text-muted-foreground hover:text-foreground">
            mcc.babochkin.com
          </a>
          <Button variant="ghost" size="icon" className="size-8" onClick={() => window.location.reload()} aria-label="Обновить" title="Обновить">
            <RefreshCwIcon className="size-4" />
          </Button>
          <ThemeSwitch />
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setSettings(true)} aria-label="Настройки" title="Настройки">
            <SettingsIcon className="size-4" />
          </Button>
        </div>
      </SidebarFooter>
      <ResizeHandle side="right" cssVar="--sidebar-w" cookie="mcc_sidebar_w" min={220} max={() => 480} />
      <SettingsDialog open={settings} onOpenChange={setSettings} />
      <RenameDialog open={!!renaming} onOpenChange={(v) => !v && setRenaming(null)} chatId={renaming?.id ?? ''} title={renaming?.title ?? ''} />
      <NewProjectDialog
        open={newProject}
        onOpenChange={setNewProject}
        onCreated={(cwd) => {
          store.navigate({ kind: 'new', cwd, mode: 'code' });
          if (isMobile) setOpenMobile(false);
        }}
      />
    </Sidebar>
  );
}
