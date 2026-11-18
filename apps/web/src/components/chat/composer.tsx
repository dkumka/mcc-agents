'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpIcon, BrainIcon, CheckIcon, ChevronDownIcon, CpuIcon, FileIcon, Loader2Icon, MicIcon, PaperclipIcon, ShieldIcon, SlashIcon, SquareIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentCapabilities, AttachedFile, ChatSettings, SendPayload } from '@mcc-agents/protocol';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { rawUrl } from '@/lib/files';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, uploadFile } from '@/lib/api';
import { dictationSupported, MAX_DICTATION_SEC, retryVoice, useDictation, type VoiceRef } from '@/lib/dictation';
import { matchModel } from '@/lib/format';
import { useStore } from '@/lib/store';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

/** A picture for the model (downscaled) + the id of its original being uploaded to the server. */
type Img = { mediaType: string; data: string; name: string; preview: string; uploadId?: string };
type Attachment = { id: string; name: string; size: number; progress: number; file?: AttachedFile; error?: string; abort?: () => void; forImage?: boolean };

function fmtSize(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

/** Images the model can look at directly; everything else is uploaded and passed to the agent as a file path. */
const VISION = /^image\/(png|jpe?g|webp|gif|heic|heif)$/;

/** Downscale big photos (phone camera) before sending: max 2000px, JPEG 0.85. */
async function prepareImage(file: File): Promise<Img> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const max = 2000;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const keep = scale === 1 && file.size < 3_000_000 && /png|jpeg|webp|gif/.test(file.type);
    if (keep) {
      const data = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(',')[1]);
        r.readAsDataURL(file);
      });
      return { mediaType: file.type, data, name: file.name, preview: `data:${file.type};base64,${data}` };
    }
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL('image/jpeg', 0.85);
    return { mediaType: 'image/jpeg', data: dataUrl.split(',')[1], name: file.name || 'image.jpg', preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Popup = { kind: 'slash'; query: string } | { kind: 'mention'; query: string; start: number } | null;

function detectPopup(text: string, caret: number): Popup {
  const before = text.slice(0, caret);
  if (/^\/[\w:-]*$/.test(before)) return { kind: 'slash', query: before.slice(1) };
  const m = before.match(/(^|\s)@([^\s@]*)$/);
  if (m) return { kind: 'mention', query: m[2], start: caret - m[2].length - 1 };
  return null;
}

const EFFORT_LABEL: Record<string, string> = { low: 'Низкий', medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимум', ultra: 'Ультра', minimal: 'Минимальный' };
/** Phone: the chips share one row with 📎, 🎤 and «Отправить» — short labels, no chevrons. */
const EFFORT_SHORT: Record<string, string> = { low: 'Низк.', medium: 'Сред.', high: 'Выс.', xhigh: 'Оч. выс.', max: 'Макс.', ultra: 'Ультра', minimal: 'Мин.' };
const MODE_SHORT: Record<string, string> = {
  default: 'Спрос',
  untrusted: 'Спрос',
  acceptEdits: 'Правки',
  'on-request': 'Проект',
  'read-only': 'Чтение',
  bypassPermissions: 'Полный',
  never: 'Полный',
};

function Chip({ icon: Icon, children, className, compact, ...p }: React.ComponentProps<'button'> & { icon: typeof CpuIcon; compact?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 shrink-0 items-center rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted',
        compact ? 'max-w-[7rem] gap-0.5 px-1' : 'max-w-[11rem] gap-1 px-2',
        className,
      )}
      {...p}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{children}</span>
      {!compact && <ChevronDownIcon className="size-3 shrink-0 opacity-60" />}
    </button>
  );
}

export function SettingsChips({
  caps,
  settings,
  onChange,
  compact,
}: {
  caps: AgentCapabilities | null;
  settings: ChatSettings;
  onChange: (s: ChatSettings) => void;
  compact?: boolean;
}) {
  const models = caps?.models ?? [];
  const model = matchModel(models, settings.model) ?? models.find((m) => m.isDefault);
  const efforts = model?.efforts ?? [];
  const modes = caps?.permissionModes ?? [];
  const mode = modes.find((m) => m.id === (settings.permissionMode ?? caps?.defaults.permissionMode));
  const effort = settings.effort ?? model?.defaultEffort ?? caps?.defaults.effort;
  const modelLabel = model?.label ?? settings.model ?? 'Модель';
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip icon={CpuIcon} compact={compact} aria-label={`Модель: ${modelLabel}`}>
            {modelLabel.replace(/^По умолчанию \((.+)\)$/, '$1')}
          </Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
          <DropdownMenuLabel>Модель</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={model?.id ?? ''} onValueChange={(v) => onChange({ model: v })}>
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id} className="py-2">
                <div className="min-w-0">
                  <div className="text-sm">{m.label}</div>
                  {m.description && <div className="truncate text-xs text-muted-foreground">{m.description}</div>}
                </div>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {efforts.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip icon={BrainIcon} compact={compact} aria-label={`Глубина размышлений: ${effort ? (EFFORT_LABEL[effort] ?? effort) : 'Авто'}`}>
              {effort ? ((compact ? EFFORT_SHORT[effort] : undefined) ?? EFFORT_LABEL[effort] ?? effort) : 'Авто'}
            </Chip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Глубина размышлений</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={effort ?? ''} onValueChange={(v) => onChange({ effort: v })}>
              {efforts.map((e) => (
                <DropdownMenuRadioItem key={e} value={e} className="py-2">
                  {EFFORT_LABEL[e] ?? e}
                  {model?.defaultEffort === e && <span className="ml-auto text-xs text-muted-foreground">по умолч.</span>}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {modes.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Chip
              icon={ShieldIcon}
              compact={compact}
              aria-label={`Подтверждения: ${mode?.label ?? 'Режим'}`}
              className={cn(settings.permissionMode === 'bypassPermissions' || settings.permissionMode === 'never' ? 'text-warning' : '')}
            >
              {(compact && mode ? MODE_SHORT[mode.id] : undefined) ?? mode?.label ?? 'Режим'}
            </Chip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>Подтверждения</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={mode?.id ?? ''} onValueChange={(v) => onChange({ permissionMode: v })}>
              {modes.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id} className="py-2">
                  <div>
                    <div className="text-sm">{m.label}</div>
                    <div className="text-xs text-muted-foreground">{m.description}</div>
                  </div>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Shown in place of the settings chips while recording / transcribing. */
function DictationBar({ state, seconds, level, onCancel }: { state: string; seconds: number; level: number; onCancel: () => void }) {
  const bars = 14;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 pl-1" aria-live="polite">
      {state === 'transcribing' ? (
        <span className="text-xs text-muted-foreground">Распознаю…</span>
      ) : (
        <>
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-destructive" />
          <span className={cn('shrink-0 font-mono text-xs tabular-nums', seconds >= MAX_DICTATION_SEC - 30 ? 'text-warning' : 'text-muted-foreground')}>{mmss(seconds)}</span>
          <span className="flex h-5 min-w-0 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden>
            {Array.from({ length: bars }, (_, i) => {
              // a simple symmetric meter driven by the current level
              const k = 1 - Math.abs(i - (bars - 1) / 2) / (bars / 2);
              const h = Math.max(0.12, Math.min(1, level * (0.55 + 0.9 * k)));
              return <span key={i} className="w-[3px] shrink-0 rounded-full bg-foreground/60 transition-[height] duration-75" style={{ height: `${Math.round(h * 100)}%` }} />;
            })}
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" /> Отмена
          </button>
        </>
      )}
    </div>
  );
}

export function Composer({
  draftKey,
  cwd,
  caps,
  settings,
  onSettings,
  busy,
  onSend,
  onStop,
  placeholder,
  autoFocus,
  sending,
}: {
  draftKey: string;
  cwd: string;
  caps: AgentCapabilities | null;
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  busy: boolean;
  onSend: (p: SendPayload) => void | Promise<void>;
  onStop?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  sending?: boolean;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [imagePreview, setImagePreview] = useState<Img | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [popup, setPopup] = useState<Popup>(null);
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  // drafts survive reloads and chat switches
  useEffect(() => {
    setText(localStorage.getItem(`draft:${draftKey}`) ?? '');
    setImages([]);
    setImagePreview(null);
    setAttachments([]);
  }, [draftKey]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text) localStorage.setItem(`draft:${draftKey}`, text);
      else localStorage.removeItem(`draft:${draftKey}`);
    }, 300);
    return () => clearTimeout(t);
  }, [text, draftKey]);

  // auto-grow
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    // never pop the keyboard by itself on touch devices
    if (autoFocus && !window.matchMedia('(pointer: coarse)').matches) ta.current?.focus();
  }, [autoFocus, draftKey]);

  // @-mention file search
  useEffect(() => {
    if (popup?.kind !== 'mention') return;
    let off = false;
    const t = setTimeout(() => {
      api
        .files(cwd, popup.query)
        .then((f) => !off && setFiles(f.slice(0, 30)))
        .catch(() => !off && setFiles([]));
    }, 120);
    return () => {
      off = true;
      clearTimeout(t);
    };
  }, [popup, cwd]);

  const commands = useMemo(() => {
    if (popup?.kind !== 'slash') return [];
    const q = popup.query.toLowerCase();
    return (caps?.commands ?? []).filter((c) => c.name.toLowerCase().includes(q)).slice(0, 40);
  }, [popup, caps]);

  const options: { key: string; label: string; hint?: string; apply: () => void }[] =
    popup?.kind === 'slash'
      ? commands.map((c) => ({
          key: c.name,
          label: `/${c.name}`,
          hint: c.description,
          apply: () => {
            setText(`/${c.name} `);
            setPopup(null);
          },
        }))
      : popup?.kind === 'mention'
        ? files.map((f) => ({
            key: f,
            label: f,
            apply: () => {
              const caret = ta.current?.selectionStart ?? text.length;
              const next = text.slice(0, popup.start) + '@' + f + ' ' + text.slice(caret);
              setText(next);
              setPopup(null);
              requestAnimationFrame(() => {
                const pos = popup.start + f.length + 2;
                ta.current?.setSelectionRange(pos, pos);
                ta.current?.focus();
              });
            },
          }))
        : [];

  useEffect(() => setSel(0), [popup?.kind, popup?.query]);

  const uploading = attachments.some((a) => !a.file && !a.error);
  const ready = attachments.filter((a) => a.file && !a.forImage);
  const chips = attachments.filter((a) => !a.forImage);
  const original = (im: Img) => attachments.find((a) => a.id === im.uploadId)?.file;
  const canSend = (text.trim().length > 0 || images.length > 0 || ready.length > 0) && !sending && !uploading;

  const submit = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!((body.length > 0 || images.length > 0 || ready.length > 0) && !sending && !uploading)) return;
    // pictures with a stored original first: the chat pairs originals and previews by position
    const pics = [...images].sort((a, b) => Number(!!original(b)) - Number(!!original(a)));
    const payload: SendPayload = {
      text: body,
      images: pics.map(({ mediaType, data, name }) => ({ mediaType, data, name })),
      files: [...pics.map(original).filter((f): f is AttachedFile => !!f), ...ready.map((a) => a.file!)],
    };
    setText('');
    setImages([]);
    setAttachments([]);
    setPopup(null);
    localStorage.removeItem(`draft:${draftKey}`);
    try {
      await onSend(payload);
    } catch {
      setText(payload.text);
    }
  };

  // ---- voice input: the transcript goes where the caret is (or at the end), then — optionally — straight to the agent
  const autoSend = useStore((s) => s.prefs?.voiceAutoSend ?? false);
  const [canDictate, setCanDictate] = useState(false);
  useEffect(() => setCanDictate(dictationSupported()), []);
  const insertDictation = (said: string, send: boolean) => {
    const el = ta.current;
    const at = el && document.activeElement === el ? el.selectionStart : text.length;
    const before = text.slice(0, at);
    const after = text.slice(at);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    const next = before + lead + said + trail + after;
    if (send && !uploading) return void submit(next);
    setText(next);
    // keep the keyboard closed on phones — the whole point is not to type
    if (!window.matchMedia('(pointer: coarse)').matches)
      requestAnimationFrame(() => {
        const pos = (before + lead + said).length;
        ta.current?.focus();
        ta.current?.setSelectionRange(pos, pos);
      });
  };
  const retryDictation = (rec: VoiceRef) => {
    const p = retryVoice(rec);
    toast.promise(p, { loading: 'Распознаю ещё раз…', success: 'Готово', error: (e: Error) => e.message });
    p.then((r) => r.text && insertDictation(r.text, autoSend)).catch(() => {});
  };
  const dictation = useDictation(
    (said, rec) => {
      insertDictation(said, autoSend);
      if (rec.cleanupError) toast.warning('Текст не удалось исправить — вставлен как распознан', { description: rec.cleanupError });
    },
    // the take stays on the server: retry right here, or later from Settings → Голос
    (msg, rec) =>
      toast.error(msg, rec ? { duration: 30_000, description: 'Запись сохранена — её можно распознать ещё раз (и в Настройках → Голос).', action: { label: 'Повторить', onClick: () => retryDictation(rec) } } : undefined),
  );
  // «Вставить» from the dictation history in Settings
  const insertRef = useRef(insertDictation);
  useEffect(() => { insertRef.current = insertDictation; });
  useEffect(() => {
    const on = (e: Event) => insertRef.current((e as CustomEvent<string>).detail, false);
    window.addEventListener('mcc:insert-text', on);
    return () => window.removeEventListener('mcc:insert-text', on);
  }, []);
  const dictating = dictation.state !== 'idle';

  const upload = (f: File, forImage = false) => {
    const id = Math.random().toString(36).slice(2);
    const { promise, abort } = uploadFile(f, (p) => setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, progress: p } : a))));
    setAttachments((cur) => [...cur, { id, name: f.name || 'file', size: f.size, progress: 0, abort, forImage }]);
    promise
      .then((file) => setAttachments((cur) => cur.map((a) => (a.id === id ? { ...a, file, progress: 1 } : a))))
      .catch((e: Error) =>
        // a picture still goes to the model without its stored original
        setAttachments((cur) => (forImage ? cur.filter((a) => a.id !== id) : cur.map((a) => (a.id === id ? { ...a, error: e.message } : a)))),
      );
    return id;
  };

  const addFiles = async (list: FileList | File[]) => {
    const all = [...list];
    const pics = all.filter((f) => VISION.test(f.type) && f.size < 20 * 1024 * 1024).slice(0, 6);
    for (const f of all) if (!pics.includes(f)) upload(f);
    if (!pics.length) return;
    // the model gets a downscaled copy; the original is kept on the server (opens full size from the chat)
    const imgs = await Promise.all(
      pics.map((f) => {
        const uploadId = upload(f, true);
        return prepareImage(f)
          .then((im): Img => ({ ...im, uploadId }))
          .catch(() => {
            setAttachments((cur) => cur.map((a) => (a.id === uploadId ? { ...a, forImage: false } : a)));
            return null as Img | null;
          });
      }),
    );
    setImages((cur) => [...cur, ...imgs.filter((x): x is Img => !!x)].slice(0, 8));
  };

  return (
    <div className="relative mx-auto w-full max-w-3xl px-3 md:px-6">
      <Dialog open={imagePreview !== null} onOpenChange={(open) => { if (!open) setImagePreview(null); }}>
        <DialogContent className="max-h-[90dvh] overflow-auto sm:max-w-4xl">
          <DialogTitle className="break-words pr-6">{imagePreview?.name || 'Предпросмотр изображения'}</DialogTitle>
          <DialogDescription className="sr-only">Изображение, добавленное к сообщению</DialogDescription>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {imagePreview && <img src={original(imagePreview)?.path ? rawUrl(original(imagePreview)!.path) : imagePreview.preview} alt={imagePreview.name} className="max-h-[75dvh] w-full object-contain" />}
        </DialogContent>
      </Dialog>
      {popup && options.length > 0 && (
        <div className="absolute inset-x-3 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover shadow-xl md:inset-x-6">
          <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
            {popup.kind === 'slash' ? <SlashIcon className="size-3" /> : <FileIcon className="size-3" />}
            {popup.kind === 'slash' ? 'Команды и skills' : 'Файлы проекта'}
          </div>
          <div className="scrollbar-thin max-h-64 overflow-y-auto py-1">
            {options.map((o, i) => (
              <button
                key={o.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={o.apply}
                className={cn('flex w-full min-w-0 items-baseline gap-2 px-3 py-2 text-left text-sm', i === sel ? 'bg-muted' : 'hover:bg-muted/60')}
              >
                <span className="shrink-0 font-mono text-[13px]">{o.label}</span>
                {o.hint && <span className="min-w-0 truncate text-xs text-muted-foreground">{o.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className="rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-ring/70"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {chips.map((a) => (
              <div
                key={a.id}
                className={cn('relative flex max-w-full items-center gap-2 overflow-hidden rounded-lg border bg-muted/40 py-1.5 pl-2 pr-7 text-xs', a.error && 'border-destructive/50')}
                title={a.error ?? a.name}
              >
                {a.error ? (
                  <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
                ) : a.file ? (
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="block max-w-[11rem] truncate font-medium">{a.name}</span>
                  <span className={cn('block text-[10.5px]', a.error ? 'text-destructive' : 'text-muted-foreground')}>
                    {a.error ?? (a.file ? fmtSize(a.size) : `${Math.round(a.progress * 100)}% · ${fmtSize(a.size)}`)}
                  </span>
                </span>
                {!a.file && !a.error && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary/70" style={{ width: `${Math.round(a.progress * 100)}%` }} />}
                <button
                  type="button"
                  aria-label="Убрать"
                  onClick={() => {
                    a.abort?.();
                    setAttachments((cur) => cur.filter((x) => x.id !== a.id));
                  }}
                  className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {images.map((im, i) => (
              <div key={i} className="relative shrink-0">
                <button type="button" onClick={() => setImagePreview(im)} aria-label={`Просмотреть ${im.name}`} className="block cursor-pointer rounded-lg transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.preview} alt={im.name} className="size-16 rounded-lg border object-cover" />
                </button>
                {im.uploadId && !original(im) && attachments.some((a) => a.id === im.uploadId) && (
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/50" title="Сохраняю оригинал на сервере">
                    <Loader2Icon className="size-4 animate-spin" />
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Убрать"
                  onClick={() => {
                    const a = attachments.find((x) => x.id === im.uploadId);
                    a?.abort?.();
                    setAttachments((cur) => cur.filter((x) => x.id !== im.uploadId));
                    setImages((cur) => cur.filter((_, j) => j !== i));
                  }}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={1}
          placeholder={placeholder ?? 'Сообщение… / — команды, @ — файлы'}
          enterKeyHint={isMobile ? 'enter' : 'send'}
          onChange={(e) => {
            setText(e.target.value);
            setPopup(detectPopup(e.target.value, e.target.selectionStart ?? e.target.value.length));
          }}
          onKeyDown={(e) => {
            if (popup && options.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => (s + 1) % options.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => (s - 1 + options.length) % options.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                options[sel]?.apply();
                return;
              }
              if (e.key === 'Escape') {
                setPopup(null);
                return;
              }
            }
            if (e.key === 'Escape' && dictation.state === 'recording') {
              e.preventDefault();
              dictation.cancel();
              return;
            }
            if (e.key === 'Escape' && busy && onStop) {
              e.preventDefault();
              onStop();
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !isMobile && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const fl = [...e.clipboardData.files];
            if (fl.length) {
              e.preventDefault();
              addFiles(fl);
            }
          }}
          onBlur={() => setTimeout(() => setPopup(null), 150)}
          className="block max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-base leading-relaxed outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <div className="flex items-center gap-0.5 px-1 pb-1.5 md:gap-1 md:px-1.5">
          <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 text-muted-foreground" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файлы" title="Прикрепить файлы (до 50 МБ)">
            <PaperclipIcon className="size-4" />
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          {dictating ? (
            <DictationBar state={dictation.state} seconds={dictation.seconds} level={dictation.level} onCancel={dictation.cancel} />
          ) : (
            <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-0 overflow-x-auto md:gap-0.5 [mask-image:linear-gradient(90deg,#000_calc(100%-14px),transparent)]">
              <SettingsChips caps={caps} settings={settings} onChange={onSettings} compact={isMobile} />
            </div>
          )}
          {busy && onStop && (
            <Button type="button" variant="secondary" size="icon" className="size-9 shrink-0 rounded-full" onClick={onStop} aria-label="Остановить">
              <SquareIcon className="size-3.5 fill-current" />
            </Button>
          )}
          {canDictate && !dictating && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 shrink-0 text-muted-foreground"
              disabled={sending}
              onClick={() => dictation.start()}
              aria-label="Голосовой ввод"
              title="Голосовой ввод"
            >
              <MicIcon className="size-4" />
            </Button>
          )}
          {dictating ? (
            // finishing the take sits where «Отправить» is — under the thumb
            <Button
              type="button"
              size="icon"
              className="size-9 shrink-0 rounded-full bg-destructive text-white hover:bg-destructive/90"
              disabled={dictation.state !== 'recording'}
              onClick={() => dictation.stop()}
              aria-label={autoSend ? 'Закончить и отправить' : 'Закончить запись'}
              title={autoSend ? 'Закончить и отправить' : 'Закончить — текст появится в поле'}
            >
              {dictation.state === 'recording' ? autoSend ? <ArrowUpIcon className="size-4" /> : <CheckIcon className="size-4" /> : <Loader2Icon className="size-4 animate-spin" />}
            </Button>
          ) : (
            <Button type="button" size="icon" className="size-9 shrink-0 rounded-full" disabled={!canSend} onClick={() => submit()} aria-label={busy ? 'Отправить в очередь' : 'Отправить'}>
              {sending ? <CheckIcon className="size-4 animate-pulse" /> : <ArrowUpIcon className="size-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
