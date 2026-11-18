'use client';

import { useEffect, useState } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { ChatSummary } from '@mcc-agents/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { setArchived } from '@/lib/archive';
import { store } from '@/lib/store';
import { ui } from '@/lib/ui';

export function RenameDialog({ open, onOpenChange, chatId, title }: { open: boolean; onOpenChange: (v: boolean) => void; chatId: string; title: string }) {
  const [v, setV] = useState(title);
  useEffect(() => setV(title), [title, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Переименовать чат</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            store.meta(chatId, { title: v });
            onOpenChange(false);
          }}
          className="space-y-4"
        >
          <Input value={v} onChange={(e) => setV(e.target.value)} autoFocus className="h-11" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => (store.meta(chatId, { title: '' }), onOpenChange(false))}>
              Сбросить
            </Button>
            <Button type="submit">Сохранить</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


function ConfirmAction({ title, name, description, onConfirm, onClose }: {
  title: string; name: string; description: string; onConfirm: () => boolean; onClose: () => void;
}) {
  const [value, setValue] = useState('');
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (value === name && onConfirm()) onClose();
      }}>
        <label className="flex flex-col gap-3 text-sm">
          <span>Для подтверждения введите <strong className="break-words">{name}</strong></span>
          <Input value={value} onChange={(event) => setValue(event.target.value)} autoFocus autoComplete="off" className="h-11 text-base" />
        </label>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
          <Button type="submit" disabled={value !== name}>{title}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function sendAction(message: Parameters<typeof store.send>[0]) {
  if (store.send(message)) return true;
  toast.error('Нет связи с сервером');
  return false;
}

export function ChatActions({ chat }: { chat: ChatSummary }) {
  const [rename, setRename] = useState(false);
  const [remove, setRemove] = useState(false);
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className="flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent" aria-label={`Действия чата ${chat.title}`}><EllipsisIcon className="size-4" /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48 [&_[role=menuitem]]:min-h-10">
        <DropdownMenuItem onClick={() => setRename(true)}>Переименовать</DropdownMenuItem>
        <DropdownMenuItem onClick={() => store.meta(chat.id, { pinned: !chat.pinned })}>{chat.pinned ? 'Открепить' : 'Закрепить'}</DropdownMenuItem>
        <DropdownMenuItem disabled={chat.status === 'running' || chat.status === 'starting' || chat.status === 'waiting'} onClick={() => ui.set({ fork: { chatId: chat.id } })}>Форк чата…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => store.meta(chat.id, { taskStage: 'in-progress' })}>В работе {chat.taskStage === 'in-progress' ? '✓' : ''}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => store.meta(chat.id, { taskStage: 'done' })}>Готово {chat.taskStage === 'done' ? '✓' : ''}</DropdownMenuItem>
        <DropdownMenuItem disabled={!chat.taskStage} onClick={() => store.meta(chat.id, { taskStage: null })}>Убрать статус</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setArchived(chat.id, !chat.archived)}>{chat.archived ? 'Вернуть из архива' : 'Архивировать'}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => setRemove(true)}>Удалить чат</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <RenameDialog open={rename} onOpenChange={setRename} chatId={chat.id} title={chat.title} />
    {remove && <ConfirmAction title="Удалить чат" name={chat.title} description="Чат будет убран из панели. История CLI и файлы на сервере сохранятся." onClose={() => setRemove(false)} onConfirm={() => sendAction({ t: 'removeChat', chatId: chat.id, confirm: chat.title })} />}
  </>;
}

export function ProjectActions({ cwd, archived, onNew }: { cwd: string; archived: boolean; onNew: () => void }) {
  const [action, setAction] = useState<'archive' | 'restore' | 'delete' | null>(null);
  const name = cwd.split('/').filter(Boolean).pop() || cwd;
  const title = action === 'delete' ? 'Удалить проект' : action === 'restore' ? 'Вернуть проект' : 'Архивировать проект';
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><button type="button" className="flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent" aria-label={`Действия проекта ${name}`}><EllipsisIcon className="size-4" /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48 [&_[role=menuitem]]:min-h-10">
        <DropdownMenuItem onClick={onNew}>Новый чат</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setAction(archived ? 'restore' : 'archive')}>{archived ? 'Вернуть из архива' : 'Архивировать проект'}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => setAction('delete')}>Удалить проект</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {action && <ConfirmAction title={title} name={name} description={action === 'delete' ? 'Проект и его чаты будут убраны из панели. Репозитории, worktree и история CLI сохранятся на сервере.' : 'Архив доступен через общий раздел и внутри проекта.'} onClose={() => setAction(null)} onConfirm={() => sendAction({ t: 'projectMeta', cwd, action, confirm: name })} />}
  </>;
}
