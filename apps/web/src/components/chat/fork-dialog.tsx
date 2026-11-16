'use client';

import { useEffect, useRef, useState } from 'react';
import { GitBranchIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { store } from '@/lib/store';
import { ui, useUi } from '@/lib/ui';

/** «Название — ветка N»: N counts the branches already made from this chat (the original is branch 1). */
function suggestTitle(chatId: string): string {
  const chats = store.state.chats;
  const base = (chats[chatId]?.title ?? 'Чат').replace(/\s+—\s+ветка \d+$/, '');
  const n = Object.values(chats).filter((c) => c.forkOf === chatId).length + 2;
  return `${base} — ветка ${n}`;
}

/** The text of the message we branched before goes into the new chat's field: edit it and send. */
function prefill(chatId: string, text?: string) {
  if (text) localStorage.setItem(`draft:${chatId}`, text);
}

/** Rollback of the dialogue (files stay as they are): the branch takes the chat's place, the original can come back. */
export async function rewindTo(chatId: string, beforeItemId: string, text?: string) {
  const title = store.state.chats[chatId]?.title ?? 'Чат';
  const t = toast.loading('Откатываю разговор…');
  try {
    const id = await store.fork(chatId, title, beforeItemId, true);
    prefill(id, text);
    store.navigate({ kind: 'chat', chatId: id });
    toast.success('Разговор откачен', {
      id: t,
      description: 'Файлы не тронуты. Ваше сообщение — в поле ввода.',
      action: {
        label: 'Вернуть как было',
        onClick: () => {
          store.unrewind(id);
          store.navigate({ kind: 'chat', chatId });
        },
      },
      duration: 10_000,
    });
  } catch (e) {
    toast.error((e as Error).message, { id: t });
  }
}

/** «Форк»: name the branch (suggested, editable), then open it. */
export function ForkDialog() {
  const req = useUi((s) => s.fork);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!req) return;
    setTitle(suggestTitle(req.chatId));
    setBusy(false);
  }, [req]);

  const close = () => ui.set({ fork: null });
  const submit = async () => {
    if (!req || busy) return;
    setBusy(true);
    try {
      const id = await store.fork(req.chatId, title.trim(), req.beforeItemId);
      prefill(id, req.text);
      close();
      store.navigate({ kind: 'chat', chatId: id });
      toast.success('Ветка создана', { description: req.beforeItemId ? 'Исходный чат не изменился. Сообщение, с которого ветка, — в поле ввода.' : 'Исходный чат не изменился.' });
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!req} onOpenChange={(v) => !v && close()}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          // select the whole name: type a new one or keep it
          requestAnimationFrame(() => input.current?.select());
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranchIcon className="size-5" /> Форк чата
          </DialogTitle>
          <DialogDescription>
            {req?.beforeItemId
              ? 'Новый чат с разговором до выбранного сообщения. Исходный не меняется, файлы не трогаются.'
              : 'Новый чат с копией всего разговора. Исходный не меняется, файлы не трогаются.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="fork-title" className="text-xs text-muted-foreground">
              Название ветки — чтобы потом отличать её от исходного чата
            </label>
            <input
              id="fork-title"
              ref={input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={140}
              className="h-11 w-full rounded-md border bg-background px-3 text-base outline-none focus:border-ring md:text-sm"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? <Loader2Icon className="animate-spin" /> : <GitBranchIcon />} Создать ветку
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
