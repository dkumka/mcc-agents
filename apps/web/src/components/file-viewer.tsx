'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  DownloadIcon,
  EyeIcon,
  FileArchiveIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  Loader2Icon,
  PresentationIcon,
  ShareIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react';
import { CodeView } from '@/components/code-view';
import { CopyButton, FileBase, Markdown, WorkspaceActions } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, type Located } from '@/lib/api';
import { baseName, browserImage, displayName, extOf, fileKind, fmtSize, isIOS, isWorkspace, rawUrl, type FileKind } from '@/lib/files';
import { ui, useUi, type ViewerFile } from '@/lib/ui';
import { cn } from '@/lib/utils';

const SHARE_MAX = 40 * 1024 * 1024; // the file is fetched into memory for the share sheet

function canShareFiles(): boolean {
  try {
    return (
      typeof navigator.canShare === 'function' &&
      window.matchMedia('(pointer: coarse)').matches &&
      navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] })
    );
  } catch {
    return false;
  }
}

const TYPE_LABEL: Record<string, string> = {
  doc: 'Документ Word',
  docx: 'Документ Word',
  odt: 'Документ',
  rtf: 'Документ RTF',
  pages: 'Документ Pages',
  xls: 'Таблица Excel',
  xlsx: 'Таблица Excel',
  ods: 'Таблица',
  numbers: 'Таблица Numbers',
  csv: 'Таблица CSV',
  ppt: 'Презентация PowerPoint',
  pptx: 'Презентация PowerPoint',
  key: 'Презентация Keynote',
  pdf: 'PDF',
  zip: 'Архив',
  gz: 'Архив',
  tgz: 'Архив',
  tar: 'Архив',
  '7z': 'Архив',
  rar: 'Архив',
};

export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const e = extOf(name);
  const Icon = /^(xlsx?|ods|numbers|csv|tsv)$/.test(e)
    ? FileSpreadsheetIcon
    : /^(pptx?|odp|key)$/.test(e)
      ? PresentationIcon
      : /^(zip|gz|tgz|tar|7z|rar|bz2|xz)$/.test(e)
        ? FileArchiveIcon
        : /^(docx?|odt|rtf|pages|pdf|txt|md)$/.test(e)
          ? FileTextIcon
          : FileIcon;
  return <Icon className={className} />;
}

/** Small "open / download" pair for a file path (diff headers, tool cards). */
export function FileActions({ path, className }: { path: string; className?: string }) {
  const name = displayName(path);
  if (isWorkspace(path)) return <WorkspaceActions path={path} />;
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => ui.openFile({ path })}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:size-7"
        aria-label={`Открыть ${name}`}
        title="Открыть"
      >
        <EyeIcon className="size-3.5" />
      </button>
      <a
        href={rawUrl(path, { dl: true, name })}
        download={name}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:size-7"
        aria-label={`Скачать ${name}`}
        title="Скачать"
      >
        <DownloadIcon className="size-3.5" />
      </a>
    </span>
  );
}

/** Bigger text files are not previewed at all (the first 1 MB of smaller ones is). */
const TEXT_MAX = 50 * 1024 * 1024;

const tilde = (p: string) => p.replace(/^\/home\/[^/]+/, '~');

function Problem({ title, path, children }: { title: string; path?: string; children?: React.ReactNode }) {
  return (
    <Center>
      <TriangleAlertIcon className="size-8 text-muted-foreground" />
      <div className="max-w-full space-y-1 px-2">
        <div className="text-base font-medium">{title}</div>
        {path && <div className="break-anywhere font-mono text-xs text-muted-foreground select-all">{path}</div>}
      </div>
      {children}
    </Center>
  );
}

/** Same-name files to pick from (a bare name with several matches, or suggestions for a missing path). */
function Matches({ f, matches }: { f: ViewerFile; matches: string[] }) {
  return (
    <div className="flex w-full max-w-lg flex-col gap-1 text-left">
      {matches.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => ui.openFile({ path: m, hints: f.hints })}
          className="break-anywhere min-h-10 rounded-md border px-3 py-2 text-left font-mono text-xs hover:bg-muted"
        >
          {tilde(m)}
        </button>
      ))}
    </div>
  );
}

function LocateProblem({ f, loc }: { f: ViewerFile; loc: Located }) {
  if (loc.status === 'choose')
    return (
      <Problem title={`Нашлось несколько файлов «${baseName(loc.path)}» — какой открыть?`}>
        <Matches f={f} matches={loc.matches} />
      </Problem>
    );
  if (loc.status === 'not_found')
    return (
      <Problem title="Файл не найден:" path={loc.path}>
        {loc.matches.length > 0 && (
          <>
            <div className="text-sm text-muted-foreground">Файлы с таким же именем:</div>
            <Matches f={f} matches={loc.matches} />
          </>
        )}
      </Problem>
    );
  const title = loc.status === 'eacces' ? 'Нет доступа' : loc.status === 'not_file' ? 'Это не файл' : 'Нет доступа: папка вне проектов панели';
  return <Problem title={title} path={loc.path} />;
}

/** The text of a file the API refused: same wording as LocateProblem. */
function textProblem(e: Error, path: string) {
  if (/не найден|ENOENT/i.test(e.message)) return <Problem title="Файл не найден:" path={path} />;
  if (/доступ|not allowed|EACCES/i.test(e.message)) return <Problem title="Нет доступа" path={path} />;
  return <Problem title={`Не удалось открыть файл: ${e.message}`} path={path} />;
}

function Body({ f, name, kind, size, shareable, onBinary }: { f: ViewerFile; name: string; kind: FileKind; size?: number; shareable: boolean; onBinary: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [text, setText] = useState<{ content: string; truncated: boolean } | null>(null);
  const [textErr, setTextErr] = useState<Error | null>(null);
  const [source, setSource] = useState(false);
  const wrap = useUi((s) => s.wrap);
  const tooLarge = kind === 'text' && (size ?? 0) > TEXT_MAX;

  useEffect(() => {
    if (kind !== 'text' || tooLarge) return;
    api
      .file(f.path)
      .then((r) => (r.binary ? onBinary() : setText({ content: r.content, truncated: r.truncated })))
      .catch((e: Error) => setTextErr(e));
  }, [kind, tooLarge, f.path, onBinary]);

  if (tooLarge)
    return (
      <Problem title={`Файл слишком большой для просмотра (${fmtSize(size!)})`} path={f.path}>
        <div className="text-sm text-muted-foreground">Скачайте его кнопкой вверху.</div>
      </Problem>
    );
  if (textErr) return textProblem(textErr, f.path);

  if (kind === 'image' && browserImage(name) && !imgErr) {
    return (
      <div className={cn('scrollbar-thin relative h-full overflow-auto bg-muted/30', !zoom && 'flex items-center justify-center')}>
        {f.preview && !imgLoaded && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={f.preview} alt="" className="absolute inset-0 m-auto max-h-full max-w-full object-contain opacity-70 blur-[1px]" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={rawUrl(f.path)}
          alt={name}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgErr(true)}
          onClick={() => setZoom((z) => !z)}
          className={cn('relative', zoom ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain', !imgLoaded && 'opacity-0')}
        />
        {!imgLoaded && !f.preview && <Loader2Icon className="absolute size-6 animate-spin text-muted-foreground" />}
      </div>
    );
  }
  if (kind === 'pdf' && !isIOS() && navigator.pdfViewerEnabled !== false) return <iframe src={rawUrl(f.path)} title={name} className="size-full border-0 bg-muted/30" />;
  if (kind === 'video')
    return (
      <div className="flex h-full items-center justify-center bg-black">
        <video src={rawUrl(f.path)} controls playsInline preload="metadata" className="max-h-full max-w-full" />
      </div>
    );
  if (kind === 'audio')
    return (
      <Center>
        <FileIcon className="size-10 text-muted-foreground" />
        <audio src={rawUrl(f.path)} controls preload="metadata" className="w-full max-w-md" />
      </Center>
    );
  if (kind === 'text') {
    if (!text) return <Center><Loader2Icon className="size-6 animate-spin text-muted-foreground" /></Center>;
    const md = /^(md|markdown|mdx)$/.test(extOf(name));
    return (
      <div className="scrollbar-thin h-full overflow-auto py-2">
        {md && (
          <div className="flex justify-end gap-1 px-3 pb-1">
            {(['Просмотр', 'Исходник'] as const).map((l, i) => (
              <button
                key={l}
                type="button"
                aria-pressed={source === (i === 1)}
                onClick={() => setSource(i === 1)}
                className={cn('min-h-10 rounded-md px-3 text-sm', source === (i === 1) ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted')}
              >
                {l}
              </button>
            ))}
          </div>
        )}
        {md && !source ? (
          // links inside the document are relative to its folder
          <FileBase.Provider value={f.path.replace(/\/[^/]*$/, '') || '/'}>
            <Markdown text={text.content} className="mx-auto max-w-3xl px-4 pb-4 sm:px-6" />
          </FileBase.Provider>
        ) : (
          <CodeView code={text.content} path={name} wrap={wrap} />
        )}
        {text.truncated && <div className="p-3 text-xs text-muted-foreground">… показан первый 1 МБ — весь файл можно скачать</div>}
      </div>
    );
  }
  // office documents, archives, PDF on iPhone, HEIC elsewhere…
  const ext = extOf(name);
  return (
    <Center>
      <div className="flex size-20 items-center justify-center rounded-2xl border bg-muted/50">
        <FileTypeIcon name={name} className="size-9 text-muted-foreground" />
      </div>
      <div className="max-w-full space-y-1 px-4">
        <div className="break-anywhere text-base font-medium">{name}</div>
        {(kind === 'other' || !TYPE_LABEL[ext]) && <div className="text-sm font-medium">Формат не поддерживается для просмотра</div>}
        <div className="text-sm text-muted-foreground">
          {TYPE_LABEL[ext] ?? (ext ? ext.toUpperCase() : 'Файл')}
          {size != null ? ` · ${fmtSize(size)}` : ''}
        </div>
      </div>
      <p className="max-w-sm px-6 text-xs text-muted-foreground">
        {shareable
          ? 'Браузер не показывает такие файлы сам. «Поделиться» — открыть в Word, Pages, Excel или Книгах, сохранить в «Файлы», отправить. «Скачать» — в «Загрузки».'
          : 'Браузер не показывает такие файлы сам — скачайте и откройте в своей программе.'}
      </p>
    </Center>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-6 text-center">{children}</div>;
}

function Viewer({ f }: { f: ViewerFile }) {
  const name = f.name || displayName(f.path);
  const [loc, setLoc] = useState<Located | null>(null);
  const [locErr, setLocErr] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [shareable] = useState(canShareFiles);

  // does it exist, how big is it; a missing path an agent wrote is looked up by name
  useEffect(() => {
    let off = false;
    api
      .locate(f.path, { cwd: f.cwd, bare: f.bare, hints: f.hints })
      .then((r) => {
        if (off) return;
        // found elsewhere: reopen at the real path (the header and downloads must point at it)
        if (r.status === 'ok' && r.path !== f.path) return ui.openFile({ ...f, path: r.path, name: undefined, bare: false });
        setLoc(r);
      })
      .catch((e: Error) => !off && setLocErr(e.message));
    return () => {
      off = true;
    };
  }, [f]);
  const ok = loc?.status === 'ok';

  // The share sheet must open inside the tap, so the file is fetched beforehand.
  useEffect(() => {
    if (!shareable || !ok || (loc?.size ?? f.size ?? 0) > SHARE_MAX) return;
    let off = false;
    fetch(rawUrl(f.path))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && !off) setShareFile(new File([b], name, { type: b.type || f.mediaType || 'application/octet-stream' }));
      })
      .catch(() => {});
    return () => {
      off = true;
    };
  }, [shareable, ok, loc?.size, f.path, f.size, f.mediaType, name]);

  const size = loc?.size ?? f.size;
  const kind: FileKind = binary ? 'other' : fileKind(name, f.mediaType);
  const onBinary = useCallback(() => setBinary(true), []);
  return (
    <>
      <div className="pt-safe shrink-0 border-b bg-background">
        <div className="flex h-12 items-center gap-1 px-2">
          <Button variant="ghost" size="icon" className="size-10 shrink-0" onClick={() => ui.set({ viewer: null })} aria-label="Закрыть">
            <XIcon className="size-5" />
          </Button>
          <div className="min-w-0 flex-1 px-1">
            <DialogTitle className="truncate text-sm font-medium">{name}</DialogTitle>
            <DialogDescription className="truncate text-[11px] text-muted-foreground" title={f.path}>
              {size != null ? `${fmtSize(size)} · ` : ''}
              {tilde(f.path)}
            </DialogDescription>
          </div>
          <CopyButton text={f.path} className="hidden size-10 justify-center sm:inline-flex" />
          {shareable && (
            <Button
              variant="ghost"
              size="icon"
              className="size-10 shrink-0"
              disabled={!shareFile}
              aria-label="Поделиться"
              title="Поделиться / сохранить в «Файлы»"
              onClick={() => shareFile && navigator.share({ files: [shareFile], title: name }).catch(() => {})}
            >
              {shareFile || !ok ? <ShareIcon className="size-5" /> : <Loader2Icon className="size-5 animate-spin" />}
            </Button>
          )}
          <Button asChild variant="ghost" size="icon" className="size-10 shrink-0" aria-label="Скачать" title="Скачать">
            <a href={rawUrl(f.path, { dl: true, name })} download={name}>
              <DownloadIcon className="size-5" />
            </a>
          </Button>
        </div>
      </div>
      <div className="pb-safe min-h-0 flex-1">
        {locErr ? (
          <Problem title={`Не удалось проверить файл: ${locErr}`} path={f.path} />
        ) : !loc ? (
          <Center><Loader2Icon className="size-6 animate-spin text-muted-foreground" /></Center>
        ) : !ok ? (
          <LocateProblem f={f} loc={loc} />
        ) : (
          <Body key={kind} f={f} name={name} kind={kind} size={size} shareable={shareable} onBinary={onBinary} />
        )}
      </div>
    </>
  );
}

/** Full-screen viewer for any file on the server (attachments, files the agent made, project files). */
export function FileViewer() {
  const f = useUi((s) => s.viewer);
  return (
    <Dialog open={!!f} onOpenChange={(o) => !o && ui.set({ viewer: null })}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="file-viewer flex h-[var(--app-h,100dvh)] max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 max-sm:top-0 max-sm:left-0 max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 sm:h-[min(90vh,1000px)] sm:w-[min(1100px,94vw)] sm:max-w-none sm:rounded-xl"
      >
        {f && <Viewer key={f.path} f={f} />}
      </DialogContent>
    </Dialog>
  );
}
