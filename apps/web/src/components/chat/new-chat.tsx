'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckIcon, ChevronsUpDownIcon, FolderIcon, FolderOpenIcon, FolderPlusIcon, GitBranchIcon } from 'lucide-react';
import { NewProjectDialog } from '@/components/new-project-dialog';
import { AGENTS, type AgentCapabilities, type AgentKind, type ChatMode, type ChatSettings, type ProjectInfo, type SendPayload } from '@mcc-agents/protocol';
import { AGENT_NAME, AgentMark } from '@/components/agent-badge';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
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

function ProjectPicker({ value, onChange, projects, onNew }: { value: string; onChange: (p: string) => void; projects: ProjectInfo[]; onNew: () => void }) {
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
            <CommandGroup>
              <CommandItem
                value="new-project"
                onSelect={() => {
                  setOpen(false);
                  onNew();
                }}
                className="py-2.5"
              >
                <FolderPlusIcon /> Новый проект…
              </CommandItem>
            </CommandGroup>
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

export function lastSettings(agent: AgentKind): ChatSettings {
  try {
    return JSON.parse(localStorage.getItem(`settings:${agent}`) ?? '{}');
  } catch {
    return {};
  }
}

/** The «decide yourself, ask only about risky things» mode: Claude `auto`, Codex `on-request`. */
export function autoMode(caps: AgentCapabilities): string | undefined {
  const has = (m: string) => caps.permissionModes.some((x) => x.id === m);
  return has('auto') ? 'auto' : has('on-request') ? 'on-request' : caps.defaults.permissionMode;
}

/** Conversations start the same way every time: Claude Opus (or Codex if picked), automatic permissions. */
function chatDefaults(agent: AgentKind, caps: AgentCapabilities): ChatSettings {
  const ids = caps.models.map((m) => m.id);
  const has = (m: string) => caps.permissionModes.some((x) => x.id === m);
  if (agent === 'claude') {
    const opus = ids.find((m) => m === 'opus') ?? ids.find((m) => /opus/i.test(m) && !m.includes('['));
    return { model: opus ?? caps.defaults.model, effort: caps.defaults.effort, permissionMode: has('auto') ? 'auto' : caps.defaults.permissionMode };
  }
  return { model: caps.defaults.model, effort: caps.defaults.effort, permissionMode: has('on-request') ? 'on-request' : caps.defaults.permissionMode };
}

export function NewChat({ initialCwd, initialAgent, mode = 'code' }: { initialCwd?: string; initialAgent?: AgentKind; mode?: ChatMode }) {
  return mode === 'chat' ? <NewConversation key="chat" initialAgent={initialAgent} /> : <NewProjectChat key="code" initialCwd={initialCwd} initialAgent={initialAgent} />;
}

export function AgentCards({ agent, onChange, compact, agents = AGENTS }: { agent: AgentKind; onChange: (a: AgentKind) => void; compact?: boolean; agents?: AgentKind[] }) {
  const limits = useStore((s) => s.limits);
  return (
    <div className={cn('grid gap-2', agents.length === 2 ? 'grid-cols-2' : 'grid-cols-3')}>
      {agents.map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          className={cn(
            'flex min-w-0 flex-col items-center justify-center gap-1 rounded-xl border px-1.5 text-center transition-colors sm:flex-row sm:justify-start sm:gap-2.5 sm:px-3 sm:text-left',
            compact ? 'h-12' : 'h-14',
            agent === a ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
          )}
        >
          <AgentMark agent={a} className="size-5 text-[11px] sm:size-6 sm:text-xs" />
          <span className="min-w-0 max-w-full">
            <span className="block truncate text-[13px] font-medium sm:text-sm">{AGENT_NAME[a]}</span>
            <span className="hidden truncate text-[11px] text-muted-foreground sm:block">
              <LimitsInline limits={limits} agent={a} />
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
}

/** "Чат" mode: no project, a fresh folder per conversation is made by the server. */
function NewConversation({ initialAgent }: { initialAgent?: AgentKind }) {
  const [agent, setAgent] = useState<AgentKind>(initialAgent ?? 'claude');
  const [settings, setSettings] = useState<ChatSettings>({});
  const [sending, setSending] = useState(false);
  const isMobile = useIsMobile();
  const caps = useCaps(agent, HOME);
  const [hello] = useState(greeting);

  useEffect(() => {
    if (caps) setSettings(chatDefaults(agent, caps));
  }, [caps, agent]);

  const onSend = async (p: SendPayload) => {
    setSending(true);
    try {
      const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v)) as ChatSettings;
      if (agent === 'claude' && clean.model === 'default') delete clean.model;
      const id = await store.create(agent, '', clean, p, 'chat');
      store.navigate({ kind: 'chat', chatId: id }, { replace: true });
    } catch (e) {
      toast.error((e as Error).message);
      throw e;
    } finally {
      setSending(false);
    }
  };

  const composer = (
    <Composer
      draftKey={`new-chat:${agent}`}
      cwd={HOME}
      caps={caps}
      settings={settings}
      onSettings={(st) => setSettings((cur) => ({ ...cur, ...st }))}
      busy={false}
      onSend={onSend}
      sending={sending}
      placeholder="Спросите что угодно…"
      autoFocus
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="pt-safe flex shrink-0 items-center gap-1 px-2 md:px-3">
        <div className="flex h-12 items-center gap-1">
          <SidebarTrigger className="size-9" />
          <span className="text-sm font-medium">Новая беседа</span>
        </div>
      </header>
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 py-8">
          <div className="space-y-1.5 px-4 text-center">
            <h2 className="font-serif text-2xl tracking-tight md:text-3xl">{hello}! Чем помочь?</h2>
            <p className="text-sm text-muted-foreground">Вопросы, советы, документы, расчёты — без проекта. Поиск в интернете включён.</p>
          </div>
          <div className="mx-auto w-full max-w-md px-4">
            <AgentCards agent={agent} onChange={setAgent} compact />
            {caps && !caps.available && <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{AGENT_NAME[agent]} недоступен: {caps.error}</div>}
          </div>
          {!isMobile && composer}
        </div>
      </div>
      {isMobile && (
        <div className="pb-safe shrink-0 pt-2">
          {composer}
          <div className="h-2" />
        </div>
      )}
    </div>
  );
}

function NewProjectChat({ initialCwd, initialAgent }: { initialCwd?: string; initialAgent?: AgentKind }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [newProject, setNewProject] = useState(false);
  const [cwd, setCwd] = useState(initialCwd ?? '');
  // the last agent comes after mounting: read during render it differs from the server HTML, and React keeps the server's
  // highlighted card (Claude) while the composer already says «Antigravity»
  const [agent, setAgent] = useState<AgentKind>(initialAgent ?? 'claude');
  const [settings, setSettings] = useState<ChatSettings>({});
  const [sending, setSending] = useState(false);
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
  useEffect(() => {
    const last = localStorage.getItem('lastAgent') as AgentKind | null;
    if (!initialAgent && last && AGENTS.includes(last)) setAgent(last);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // model and effort: what was used last time; permissions: always «Авто» (Claude) / «Модель решает» (Codex) —
  // change it in the chip for this chat if needed
  useEffect(() => {
    if (!caps) return;
    const last = lastSettings(agent);
    const models = caps.models.map((m) => m.id);
    setSettings({
      model: last.model && models.includes(last.model) ? last.model : caps.defaults.model,
      effort: last.effort ?? caps.defaults.effort,
      permissionMode: autoMode(caps),
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
            <p className="text-sm text-muted-foreground">Сессии те же, что в терминале: их видят `claude --resume`, `codex resume` и `agy --conversation`.</p>
          </div>
          <div className="space-y-2">
            <AgentCards agent={agent} onChange={setAgent} />
            <ProjectPicker value={cwd} onChange={setCwd} projects={projects} onNew={() => setNewProject(true)} />
            <NewProjectDialog
              open={newProject}
              onOpenChange={setNewProject}
              onCreated={(p) => {
                setProjects((cur) => [{ path: p, name: p.split('/').pop() ?? p, lastActivity: Date.now(), chatCount: 0, isGit: true }, ...cur]);
                setCwd(p);
              }}
            />
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
