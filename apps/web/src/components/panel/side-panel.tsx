'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, ChevronRightIcon, DownloadIcon, FolderIcon, GitBranchIcon, HouseIcon, Loader2Icon, PaperclipIcon, RefreshCwIcon, SquareIcon, WrapTextIcon, XIcon } from 'lucide-react';
import type { BgTask, ChatState, DirEntry, GitStatus } from '@mcc-agents/protocol';
import { CodeView } from '@/components/code-view';
import { DiffStat, UnifiedDiffView } from '@/components/diff-view';
import { FileTypeIcon } from '@/components/file-viewer';
import { CopyButton } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { diffStats, parseUnified, splitGitDiff } from '@/lib/diff';
import { displayName, fileKind, fmtSize, isWorkspace, rawUrl, workspaceUrl } from '@/lib/files';
import { shortPath, timeAgo } from '@/lib/format';
import { store } from '@/lib/store';
import { ui, useUi, type PanelTab } from '@/lib/ui';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------- git changes

function Changes({ cwd, wrap }: { cwd: string; wrap: boolean }) {
  const [st, setSt] = useState<GitStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(() => {
    setLoading(true);
    api
      .git(cwd)
      .then((s) => {
        setSt(s);
        setErr(null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [cwd]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  const files = useMemo(() => (st ? splitGitDiff(st.diff) : []), [st]);
  if (err) return <div className="p-4 text-sm text-destructive">{err}</div>;
  if (!st) return <div className="flex justify-center p-6"><Loader2Icon className="size-5 animate-spin text-muted-foreground" /></div>;
  if (!st.isRepo) return <div className="p-4 text-sm text-muted-foreground">Папка не в git-репозитории.</div>;
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <GitBranchIcon className="size-3.5" />
        <span className="font-mono">{st.branch ?? '—'}</span>
        {st.ahead ? <span>↑{st.ahead}</span> : null}
        {st.behind ? <span>↓{st.behind}</span> : null}
        <span className="ml-auto">{st.files.length ? `${st.files.length} файл.` : 'без изменений'}</span>
        <Button variant="ghost" size="icon" className="size-7" onClick={load} aria-label="Обновить">
          <RefreshCwIcon className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      {files.map((f) => {
        const lines = parseUnified(f.text);
        const s = diffStats(lines);
        const isOpen = open[f.path] ?? files.length <= 3;
        return (
          <div key={f.path} className="overflow-hidden rounded-md border">
            <button type="button" className="flex min-h-9 w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left text-xs" onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))}>
              <ChevronRightIcon className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')} />
              <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
              <DiffStat {...s} />
            </button>
            {isOpen && <UnifiedDiffView text={f.text} maxHeight="max-h-[60vh]" wrap={wrap} />}
          </div>
        );
      })}
      {st.files
        .filter((f) => !files.some((d) => d.path === f.path))
        .map((f) => (
          <div key={f.path} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-xs">
            <span className="w-5 text-muted-foreground">{f.status}</span>
            <span className="truncate">{f.path}</span>
          </div>
        ))}
      {st.truncated && <div className="text-xs text-muted-foreground">Diff обрезан (слишком большой).</div>}
    </div>
  );
}

// ---------------------------------------------------------------- files

function Files({ cwd, wrap }: { cwd: string; wrap: boolean }) {
  const panelFile = useUi((s) => s.panelFile);
  const [dir, setDir] = useState(cwd);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [file, setFile] = useState<{ path: string; content: string; truncated: boolean; binary: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [uploadsDir, setUploadsDir] = useState<string | null>(null);
  useEffect(() => {
    setDir(cwd);
    setFile(null);
  }, [cwd]);
  useEffect(() => {
    if (!panelFile) return;
    let cancelled = false;
    setFile(null);
    setErr(null);
    api.file(panelFile).then((f) => {
      if (!cancelled) setFile(f);
    }).catch((e) => {
      if (!cancelled) setErr(e.message);
    });
    return () => { cancelled = true; };
  }, [panelFile]);
  useEffect(() => {
    api.uploads().then((u) => setUploadsDir(u.dir)).catch(() => {});
  }, []);
  const open = (e: DirEntry) => {
    if (e.dir) return setDir(e.path);
    // documents, pictures, media → the full-screen viewer; text/code stays here in the panel
    if (fileKind(e.name) !== 'text') return ui.openFile({ path: e.path, name: displayName(e.path), size: e.size });
    api
      .file(e.path)
      .then((f) => (f.binary ? ui.openFile({ path: e.path, name: e.name, size: e.size }) : setFile(f)))
      .catch((x) => setErr(x.message));
  };
  useEffect(() => {
    setEntries(null);
    api
      .ls(dir)
      .then((e) => {
        setEntries(e);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [dir]);
  if (file)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
          <Button variant="ghost" size="icon" className="size-8" onClick={() => { setFile(null); ui.set({ panelFile: null }); }} aria-label="Назад">
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{shortPath(file.path, cwd)}</span>
          <CopyButton text={file.path} label="путь" />
          {isWorkspace(file.path) ? <a href={workspaceUrl(file.path)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center rounded-md border px-2 text-xs hover:bg-muted">Открыть в VS Code</a> : <Button asChild variant="ghost" size="icon" className="size-8" aria-label="Скачать" title="Скачать">
            <a href={rawUrl(file.path, { dl: true })} download={displayName(file.path)}>
              <DownloadIcon className="size-4" />
            </a>
          </Button>}
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto py-2">
          {file.binary ? (
            <div className="p-3 text-sm text-muted-foreground">Бинарный файл</div>
          ) : (
            <CodeView code={file.content} path={file.path} wrap={wrap} />
          )}
          {file.truncated && <div className="p-3 text-xs text-muted-foreground">… файл обрезан (больше 1 МБ)</div>}
        </div>
      </div>
    );
  const up = dir !== '/' && dir.split('/').length > 2;
  return (
    <div className="p-2">
      <div className="mb-1 flex items-center gap-1 px-1">
        {dir !== cwd && (
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDir(dir.split('/').slice(0, -1).join('/') || '/')} aria-label="Вверх" disabled={!up}>
            <ArrowLeftIcon className="size-4" />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{shortPath(dir)}</span>
        {dir !== cwd && (
          <Button variant="ghost" size="icon" className="size-8" onClick={() => setDir(cwd)} aria-label="К папке проекта" title="К папке проекта">
            <HouseIcon className="size-4" />
          </Button>
        )}
        {uploadsDir && !dir.startsWith(uploadsDir) && (
          <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 text-xs" onClick={() => setDir(uploadsDir)} title="Файлы, приложенные к чатам">
            <PaperclipIcon className="size-3.5" /> Вложения
          </Button>
        )}
      </div>
      {err && <div className="p-2 text-sm text-destructive">{err}</div>}
      {!entries && !err && <div className="flex justify-center p-6"><Loader2Icon className="size-5 animate-spin text-muted-foreground" /></div>}
      {entries?.map((e) => (
        <button
          key={e.path}
          type="button"
          onClick={() => open(e)}
          className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          {e.dir ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileTypeIcon name={e.name} className="size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate">{e.dir ? e.name : displayName(e.path)}</span>
          {!e.dir && e.size !== undefined && <span className="shrink-0 text-[11px] text-muted-foreground tabular">{fmtSize(e.size)}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- background tasks

function TaskRow({ chatId, t }: { chatId: string; t: BgTask }) {
  const [open, setOpen] = useState(t.status === 'running');
  const [out, setOut] = useState('');
  useEffect(() => {
    if (!open) return;
    let off = false;
    const load = () => api.taskOutput(chatId, t.id).then((r) => !off && setOut(r.output)).catch(() => {});
    load();
    const timer = t.status === 'running' ? setInterval(load, 2000) : undefined;
    return () => {
      off = true;
      if (timer) clearInterval(timer);
    };
  }, [open, chatId, t.id, t.status]);
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex min-h-10 items-center gap-2 px-2.5 py-1.5">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {t.status === 'running' ? <Loader2Icon className="size-4 shrink-0 animate-spin text-info" /> : <span className={cn('size-2 shrink-0 rounded-full', t.status === 'completed' ? 'bg-success' : t.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground')} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{t.description || t.id}</span>
            <span className="block text-[11px] text-muted-foreground">
              {t.status === 'running' ? 'выполняется' : t.status === 'completed' ? 'завершена' : t.status === 'failed' ? 'ошибка' : 'остановлена'} · {timeAgo(t.startedAt)}
            </span>
          </span>
        </button>
        {t.status === 'running' && (
          <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={() => store.stopTask(chatId, t.id)}>
            <SquareIcon className="size-3 fill-current" /> Стоп
          </Button>
        )}
      </div>
      {open && (
        <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-anywhere border-t bg-muted/40 p-2.5 font-mono text-[11.5px]">{out || t.summary || 'Нет вывода'}</pre>
      )}
    </div>
  );
}

function Tasks({ state }: { state: ChatState }) {
  const tasks = [...state.tasks].sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || b.startedAt - a.startedAt);
  if (!tasks.length) return <div className="p-4 text-sm text-muted-foreground">Фоновых задач нет. Они появляются, когда агент запускает команду в фоне.</div>;
  return (
    <div className="space-y-2 p-3">
      {tasks.map((t) => (
        <TaskRow key={t.id} chatId={state.summary.id} t={t} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- panel

export function SidePanel({ tab, state, onClose }: { tab: PanelTab; state: ChatState; onClose?: () => void }) {
  const cwd = state.summary.cwd;
  const wrap = useUi((s) => s.wrap);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="pt-safe flex shrink-0 items-center gap-2 border-b px-2">
        <div className="flex h-12 w-full items-center gap-2">
          <Tabs value={tab} onValueChange={(v) => ui.set({ panel: v as PanelTab })} className="min-w-0 flex-1">
            <TabsList className="h-9">
              {state.summary.mode !== 'chat' && <TabsTrigger value="changes" className="px-2.5 text-xs">Изменения</TabsTrigger>}
              <TabsTrigger value="files" className="px-2.5 text-xs">Файлы</TabsTrigger>
              <TabsTrigger value="tasks" className="px-2.5 text-xs">
                Задачи{state.tasks.some((t) => t.status === 'running') ? ' •' : ''}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {tab !== 'tasks' && (
            <Button
              variant="ghost"
              size="icon"
              className={cn('size-9 shrink-0', wrap && 'bg-muted')}
              onClick={() => ui.toggleWrap()}
              aria-label="Перенос строк"
              title={wrap ? 'Перенос строк: вкл' : 'Перенос строк: выкл'}
            >
              <WrapTextIcon className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="size-9 shrink-0" onClick={onClose ?? (() => ui.set({ panel: null }))} aria-label="Закрыть панель">
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div className="pb-safe scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {tab === 'changes' && (state.summary.mode === 'chat' ? <Files cwd={cwd} wrap={wrap} /> : <Changes cwd={cwd} wrap={wrap} />)}
        {tab === 'files' && <Files cwd={cwd} wrap={wrap} />}
        {tab === 'tasks' && <Tasks state={state} />}
      </div>
    </div>
  );
}
