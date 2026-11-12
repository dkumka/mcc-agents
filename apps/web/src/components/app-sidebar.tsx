'use client';

import { useMemo, useState } from 'react';
import { ChevronRightIcon, MoonIcon, PinIcon, PlusIcon, RefreshCwIcon, SearchIcon, SettingsIcon, SunIcon, WifiOffIcon } from 'lucide-react';
import type { ChatSummary } from '@mcc-agents/protocol';
import { AgentMark, StatusDot } from '@/components/agent-badge';
import { LimitsInline } from '@/components/chat/status-bar';
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
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { baseName, shortPath, timeAgo } from '@/lib/format';
import { store, useStore } from '@/lib/store';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

function ChatRow({ c, active, onPick }: { c: ChatSummary; active: boolean; onPick: () => void }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton isActive={active} onClick={onPick} className="h-auto min-h-10 gap-2 py-2 md:min-h-8 md:py-1.5" title={c.title}>
        <AgentMark agent={c.agent} className="opacity-90" />
        <span className={cn('min-w-0 flex-1 truncate', c.unread && 'font-semibold')}>{c.title}</span>
        <StatusDot status={c.status} unread={c.unread} />
        <span className="shrink-0 text-[11px] text-muted-foreground tabular">{timeAgo(c.updatedAt)}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
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
  const limits = useStore((s) => s.limits);
  const connected = useStore((s) => s.connected);
  const everConnected = useStore((s) => s.everConnected);
  const { isMobile, setOpenMobile } = useSidebar();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState(false);
  const activeId = route.kind === 'chat' ? route.chatId : null;

  const { pinned, groups } = useMemo(() => {
    const list = Object.values(chats).sort((a, b) => b.updatedAt - a.updatedAt);
    const ql = q.trim().toLowerCase();
    const filtered = ql ? list.filter((c) => c.title.toLowerCase().includes(ql) || c.cwd.toLowerCase().includes(ql)) : list;
    const pinned = filtered.filter((c) => c.pinned);
    const by = new Map<string, ChatSummary[]>();
    for (const c of filtered) {
      if (c.pinned) continue;
      const arr = by.get(c.cwd) ?? [];
      arr.push(c);
      by.set(c.cwd, arr);
    }
    const groups = [...by.entries()].sort((a, b) => b[1][0].updatedAt - a[1][0].updatedAt);
    return { pinned, groups };
  }, [chats, q]);

  const pick = (id: string) => {
    store.navigate({ kind: 'chat', chatId: id });
    if (isMobile) setOpenMobile(false);
  };
  const newChat = (cwd?: string) => {
    store.navigate({ kind: 'new', cwd });
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
        <Button className="h-10 justify-start gap-2 md:h-9" onClick={() => newChat()}>
          <PlusIcon className="size-4" /> Новый чат
        </Button>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск чатов"
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
                  <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
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
                      <ChatRow key={c.id} c={c} active={c.id === activeId} onPick={() => pick(c.id)} />
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
        {!groups.length && !pinned.length && <div className="px-4 py-6 text-sm text-muted-foreground">{q ? 'Ничего не найдено' : connected ? 'Чатов пока нет' : 'Подключаюсь…'}</div>}
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
    </Sidebar>
  );
}
