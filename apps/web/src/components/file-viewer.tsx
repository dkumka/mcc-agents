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
import { CopyButton, WorkspaceActions } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { browserImage, displayName, extOf, fileKind, fmtSize, isIOS, isWorkspace, rawUrl, type FileKind } from '@/lib/files';
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

type Head = { ok: boolean; status: number; size?: number };

function Body({ f, name, kind, head, shareable, onBinary }: { f: ViewerFile; name: string; kind: FileKind; head: Head | null; shareable: boolean; onBinary: () => void }) {
  const [imgErr, setImgErr] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [text, setText] = useState<{ content: string; truncated: boolean } | null>(null);
  const [textErr, setTextErr] = useState<string | null>(null);
  const wrap = useUi((s) => s.wrap);

  useEffect(() => {
    if (kind !== 'text') return;
    api
      .file(f.path)
      .then((r) => (r.binary ? onBinary() : setText({ content: r.content, truncated: r.truncated })))
      .catch((e: Error) => setTextErr(e.message));
  }, [kind, f.path, onBinary]);

  if (head && !head.ok) {
    return (
      <Center>
        <TriangleAlertIcon className="size-8 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          {head.status === 404 ? 'Файл не найден — его удалили или переместили.' : head.status === 403 ? 'Этот файл открыть нельзя.' : `Не удалось открыть файл (${head.status}).`}
        </div>
      </Center>
    );
  }

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
  if (kind === 'text' && !textErr) {
    if (!text) return <Center><Loader2Icon className="size-6 animate-spin text-muted-foreground" /></Center>;
    return (
      <div className="scrollbar-thin h-full overflow-auto py-2">
        <CodeView code={text.content} path={name} wrap={wrap} />
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
        <div className="text-sm text-muted-foreground">
          {TYPE_LABEL[ext] ?? (ext ? ext.toUpperCase() : 'Файл')}
          {head?.size != null ? ` · ${fmtSize(head.size)}` : f.size ? ` · ${fmtSize(f.size)}` : ''}
        </div>
      </div>
      {textErr && <div className="text-xs text-destructive">{textErr}</div>}
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
  const [head, setHead] = useState<Head | null>(null);
  const [binary, setBinary] = useState(false);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [shareable] = useState(canShareFiles);

  // does it exist, how big is it
  useEffect(() => {
    let off = false;
    fetch(rawUrl(f.path), { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        if (off) return;
        const len = Number(r.headers.get('content-length'));
        setHead({ ok: r.ok, status: r.status, size: r.ok && Number.isFinite(len) ? len : undefined });
      })
      .catch(() => !off && setHead(null));
    return () => {
      off = true;
    };
  }, [f.path]);

  // The share sheet must open inside the tap, so the file is fetched beforehand.
  useEffect(() => {
    if (!shareable || !head?.ok || (head.size ?? f.size ?? 0) > SHARE_MAX) return;
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
  }, [shareable, head, f.path, f.size, f.mediaType, name]);

  const size = head?.size ?? f.size;
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
              {f.path.replace(/^\/home\/[^/]+/, '~')}
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
              {shareFile || !head?.ok ? <ShareIcon className="size-5" /> : <Loader2Icon className="size-5 animate-spin" />}
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
        <Body key={kind} f={f} name={name} kind={kind} head={head} shareable={shareable} onBinary={onBinary} />
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
