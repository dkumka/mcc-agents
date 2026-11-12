'use client';

import { useState } from 'react';
import { CheckIcon, ChevronUpIcon, CircleDashedIcon, ListTodoIcon, Loader2Icon } from 'lucide-react';
import type { TodoEntry } from '@mcc-agents/protocol';
import { cn } from '@/lib/utils';

export function TodoBar({ todos, busy }: { todos: TodoEntry[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  if (done === todos.length && !busy) return null;
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-2 md:px-6">
      <div className="overflow-hidden rounded-xl border bg-card">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm">
          <ListTodoIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-xs text-muted-foreground tabular">
            {done}/{todos.length}
          </span>
          <span className="min-w-0 flex-1 truncate">{current?.content ?? 'Готово'}</span>
          <ChevronUpIcon className={cn('size-4 shrink-0 text-muted-foreground transition-transform', !open && 'rotate-180')} />
        </button>
        {open && (
          <ul className="scrollbar-thin max-h-56 space-y-1 overflow-y-auto border-t px-3 py-2 text-sm">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-2">
                {t.status === 'completed' ? (
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />
                ) : t.status === 'in_progress' ? (
                  <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-info" />
                ) : (
                  <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
                <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
