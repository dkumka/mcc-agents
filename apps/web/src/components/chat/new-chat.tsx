'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, ChevronsUpDownIcon, FolderIcon, FolderOpenIcon, GitBranchIcon } from 'lucide-react';
import type { AgentKind, ChatSettings, ProjectInfo, SendPayload } from '@mcc-agents/protocol';
import { AGENT_NAME, AgentMark } from '@/components/agent-badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { api } from '@/lib/api';
import { shortPath } from '@/lib/format';
import { store, useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useCaps } from './chat-view';
import { Composer } from './composer';
import { LimitsInline } from './status-bar';

const HOME = '/home/serzhb';

function expand(p: string) {
  const t = p.trim();
  if (t === '~') return HOME;
  if (t.startsWith('~/')) return HOME + t.slice(1);
  return t.replace(/\/+$/, '');
}

function ProjectPicker({ value, onChange, projects }: { value: string; onChange: (p: string) => void; projects: ProjectInfo[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const custom = q.startsWith('/') || q.startsWith('~') ? expand(q) : '';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 w-full justify-between gap-2 px-3 text-left font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{value ? shortPath(value) : 'Выберите проект'}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(32rem,calc(100vw-1.5rem))] p-0"
        align="start"
        // on phones the search field would pop the keyboard over the list
        onOpenAutoFocus={(e) => window.matchMedia('(pointer: coarse)').matches && e.preventDefault()}
      >
        <Command>
          <CommandInput value={q} onValueChange={setQ} placeholder="Поиск или путь: ~/dev/…" className="h-11" />
          <CommandList className="max-h-[50vh]">
            <CommandEmpty>Ничего не найдено</CommandEmpty>
            {custom && (
              <CommandGroup heading="Папка">
                <CommandItem
                  value={`custom:${custom}`}
                  onSelect={() => {
                    onChange(custom);
                    setOpen(false);
                  }}
                  className="py-2.5"
                >
                  <FolderIcon /> {shortPath(custom)}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Проекты">
              {projects.map((p) => (
                <CommandItem
                  key={p.path}
                  value={`${p.name} ${p.path}`}
                  onSelect={() => {
                    onChange(p.path);
                    setOpen(false);
                  }}
                  className="py-2.5"
                >
                  {p.isGit ? <GitBranchIcon /> : <FolderIcon />}
                  <span className="min-w-0 flex-1 truncate">
                    {p.name}
                    <span className="ml-2 text-xs text-muted-foreground">{shortPath(p.path)}</span>
                  </span>
                  {p.chatCount > 0 && <span className="text-xs text-muted-foreground tabular">{p.chatCount}</span>}
                  {value === p.path && <CheckIcon />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function lastSettings(agent: AgentKind): ChatSettings {
  try {
    return JSON.parse(localStorage.getItem(`settings:${agent}`) ?? '{}');
  } catch {
    return {};
  }
}

export function NewChat({ initialCwd, initialAgent }: { initialCwd?: string; initialAgent?: AgentKind }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [agent, setAgent] = useState<AgentKind>(initialAgent ?? ((typeof window !== 'undefined' && (localStorage.getItem('lastAgent') as AgentKind)) || 'claude'));
  const [settings, setSettings] = useState<ChatSettings>({});
  const [sending, setSending] = useState(false);
  const limits = useStore((s) => s.limits);
  const caps = useCaps(agent, cwd || HOME);

  useEffect(() => {
    api
      .projects()
      .then((p) => {
        setProjects(p);
        if (!cwd) setCwd(localStorage.getItem('lastCwd') || p.find((x) => x.chatCount > 0)?.path || p[0]?.path || HOME);
      })
      .catch(() => setCwd((c) => c || HOME));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialCwd) setCwd(initialCwd);
  }, [initialCwd]);
  useEffect(() => {
    if (initialAgent) setAgent(initialAgent);
  }, [initialAgent]);

  // defaults from the CLI, overridden by what was used last time
  useEffect(() => {
    if (!caps) return;
    const last = lastSettings(agent);
    const models = caps.models.map((m) => m.id);
    setSettings({
      model: last.model && models.includes(last.model) ? last.model : caps.defaults.model,
      effort: last.effort ?? caps.defaults.effort,
      permissionMode: last.permissionMode && caps.permissionModes.some((m) => m.id === last.permissionMode) ? last.permissionMode : caps.defaults.permissionMode,
    });
  }, [caps, agent]);

  const projectName = useMemo(() => projects.find((p) => p.path === cwd)?.name ?? shortPath(cwd), [projects, cwd]);

  const onSend = async (p: SendPayload) => {
    if (!cwd) {
      toast.error('Выберите проект');
      throw new Error('no cwd');
    }
    setSending(true);
    try {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v)) as ChatSettings;
      if (agent === 'claude' && clean.model === 'default') delete clean.model;
      localStorage.setItem(`settings:${agent}`, JSON.stringify(settings));
      localStorage.setItem('lastAgent', agent);
      localStorage.setItem('lastCwd', cwd);
      const id = await store.create(agent, cwd, clean, p);
      store.navigate({ kind: 'chat', chatId: id }, { replace: true });
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex shrink-0 items-center gap-1 px-2 md:px-3">
        <div className="flex h-12 items-center gap-1">
          <SidebarTrigger className="size-9" />
          <span className="text-sm font-medium">Новый чат</span>
        </div>
      </header>
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-5 px-4 py-8">
          <div className="space-y-1 text-center">
            <h2 className="text-xl font-semibold tracking-tight">С чего начнём?</h2>
            <p className="text-sm text-muted-foreground">Сессии те же, что в терминале: их видят `claude --resume` и `codex resume`.</p>
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              {(['claude', 'codex'] as AgentKind[]).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAgent(a)}
                  className={cn('flex h-14 items-center gap-2.5 rounded-xl border px-3 text-left transition-colors', agent === a ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50')}
                >
                  <AgentMark agent={a} className="size-6 text-xs" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{AGENT_NAME[a]}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      <LimitsInline limits={limits} agent={a} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <ProjectPicker value={cwd} onChange={setCwd} projects={projects} />
            {caps && !caps.available && <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{AGENT_NAME[agent]} недоступен: {caps.error}</div>}
          </div>
        </div>
      </div>
      <div className="pb-safe shrink-0 pt-2">
        <Composer
          draftKey={`new:${agent}`}
          cwd={cwd || HOME}
          caps={caps}
          settings={settings}
          onSettings={(s) => setSettings((cur) => ({ ...cur, ...s }))}
          busy={false}
          onSend={onSend}
          sending={sending}
          placeholder={`Задача для ${AGENT_NAME[agent]} в ${projectName || '…'}`}
          autoFocus
        />
        <div className="h-2" />
      </div>
    </div>
  );
}
