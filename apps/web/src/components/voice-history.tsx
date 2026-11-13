'use client';

import { useEffect, useRef, useState } from 'react';
import { CornerDownLeftIcon, Loader2Icon, PauseIcon, PlayIcon, RotateCwIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { VOICE_MODELS, type VoiceRecord } from '@mcc-agents/protocol';
import { CopyButton } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api, deleteVoice } from '@/lib/api';
import { retryVoice } from '@/lib/dictation';
import { fmtSize, rawUrl } from '@/lib/files';
import { cn } from '@/lib/utils';

const when = (t: number) =>
  new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
const dur = (s?: number) => (s === undefined ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
const short = (id?: string) => VOICE_MODELS.find((m) => m.id === id)?.label.replace(/^(OpenAI|Microsoft|ElevenLabs) /, '') ?? id ?? '';

/** Dictations kept on the server: listen, insert, copy, recognise again, delete. */
export function VoiceHistory({ onInsert }: { onInsert: () => void }) {
  const [data, setData] = useState<{ records: VoiceRecord[]; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  const load = () =>
    api
      .voice()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
    return () => audio.current?.pause();
  }, []);

  const replace = (r: VoiceRecord) => setData((d) => d && { ...d, records: d.records.map((x) => (x.id === r.id ? r : x)) });

  const play = (r: VoiceRecord) => {
    if (playing === r.id) {
      audio.current?.pause();
      setPlaying(null);
      return;
    }
    audio.current?.pause();
    const a = new Audio(rawUrl(r.file));
    a.onended = () => setPlaying(null);
    a.onerror = () => {
      setPlaying(null);
      toast.error('Этот браузер не может проиграть запись — откройте файл');
    };
    audio.current = a;
    a.play().catch(() => setPlaying(null));
    setPlaying(r.id);
  };

  const retry = async (r: VoiceRecord, model?: string) => {
    setBusy((b) => ({ ...b, [r.id]: true }));
    try {
      replace(await retryVoice(r, model));
    } catch (e) {
      toast.error((e as Error).message);
      load();
    } finally {
      setBusy((b) => ({ ...b, [r.id]: false }));
    }
  };

  const remove = async (id: string | 'all') => {
    try {
      await deleteVoice(id);
      if (id === 'all') audio.current?.pause();
      setConfirmAll(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <p className="text-sm text-destructive">Не удалось загрузить записи: {error}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">Загружаю…</p>;
  if (!data.records.length) return <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">Записей пока нет.</p>;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {data.records.length} зап. · {fmtSize(data.bytes)}
        </span>
        {confirmAll ? (
          <span className="flex items-center gap-1.5">
            <span className="text-foreground">Удалить все записи безвозвратно?</span>
            <Button size="sm" variant="destructive" className="h-8" onClick={() => remove('all')}>
              Удалить
            </Button>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setConfirmAll(false)}>
              Нет
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="outline" className="h-8" onClick={() => setConfirmAll(true)}>
            <Trash2Icon /> Очистить всё
          </Button>
        )}
      </div>
      <ul className="space-y-2">
        {data.records.slice(0, limit).map((r) => (
          <li key={r.id} className={cn('space-y-1.5 rounded-lg border p-2.5', r.status === 'error' && 'border-destructive/40')}>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>{when(r.createdAt)}</span>
              {r.durationSec !== undefined && <span className="font-mono">{dur(r.durationSec)}</span>}
              {r.model && <span className="truncate">{short(r.model)}</span>}
              {r.translated && <span className="rounded bg-muted px-1 font-medium text-foreground">EN</span>}
            </div>
            {r.status === 'error' ? (
              <p className="flex items-start gap-1.5 text-sm text-destructive">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {r.error ?? 'Не распознано'}
              </p>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-sm">{r.text}</p>
                {r.raw && r.raw !== r.text && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Как распознано</summary>
                    <p className="mt-1 whitespace-pre-wrap break-words">{r.raw}</p>
                  </details>
                )}
                {r.cleanupError && <p className="text-xs text-warning">Не исправлено: {r.cleanupError}</p>}
              </>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => play(r)} aria-label={playing === r.id ? 'Пауза' : 'Прослушать'}>
                {playing === r.id ? <PauseIcon /> : <PlayIcon />}
              </Button>
              {r.text && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('mcc:insert-text', { detail: r.text }));
                    onInsert();
                  }}
                >
                  <CornerDownLeftIcon /> Вставить
                </Button>
              )}
              {r.text && <CopyButton text={r.text} label="Копировать" className="h-8 px-2" />}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-8 px-2" disabled={busy[r.id]}>
                    {busy[r.id] ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />} Ещё раз
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  <DropdownMenuLabel>Распознать моделью</DropdownMenuLabel>
                  {VOICE_MODELS.map((m) => (
                    <DropdownMenuItem key={m.id} className="py-2" onSelect={() => retry(r, m.id)}>
                      <div className="min-w-0">
                        <div className="text-sm">{m.label}</div>
                        <div className="text-xs text-muted-foreground">{m.description}</div>
                      </div>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button size="sm" variant="ghost" className="ml-auto h-8 px-2 text-muted-foreground" onClick={() => remove(r.id)} aria-label="Удалить запись">
                <Trash2Icon />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {data.records.length > limit && (
        <Button variant="outline" className="h-10 w-full" onClick={() => setLimit((l) => l + 20)}>
          Показать ещё
        </Button>
      )}
    </div>
  );
}
