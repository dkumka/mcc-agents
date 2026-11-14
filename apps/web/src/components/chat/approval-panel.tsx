'use client';

import { useState } from 'react';
import { CheckIcon, ClipboardListIcon, MessageCircleQuestionIcon, ShieldAlertIcon, XIcon } from 'lucide-react';
import type { Approval, ApprovalDecision } from '@mcc-agents/protocol';
import { FileDiffView } from '@/components/diff-view';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';

function decide(chatId: string, d: ApprovalDecision) {
  store.decide(chatId, d);
}

function QuestionForm({ chatId, a }: { chatId: string; a: Approval }) {
  const qs = a.questions ?? [];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const ready = qs.every((q) => (sel[q.question]?.length ?? 0) > 0 || (other[q.question] ?? '').trim());
  return (
    <div className="space-y-4">
      {qs.map((q) => (
        <div key={q.question} className="space-y-2">
          {q.header && <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{q.header}</div>}
          <div className="text-sm font-medium">{q.question}</div>
          <div className="grid gap-1.5">
            {q.options.map((o) => {
              const on = sel[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() =>
                    setSel((s) => {
                      const cur = s[q.question] ?? [];
                      const next = q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : on ? [] : [o.label];
                      return { ...s, [q.question]: next };
                    })
                  }
                  className={cn(
                    'flex min-h-11 w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                    on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                  )}
                >
                  <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', q.multiSelect && 'rounded', on && 'border-primary bg-primary text-primary-foreground')}>
                    {on && <CheckIcon className="size-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium">{o.label}</span>
                    {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                  </span>
                </button>
              );
            })}
            <input
              value={other[q.question] ?? ''}
              onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))}
              placeholder="Свой ответ…"
              className="h-11 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring"
            />
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          className="h-11 flex-1 sm:flex-none"
          disabled={!ready}
          onClick={() => {
            const answers: Record<string, string> = {};
            for (const q of qs) {
              const parts = [...(sel[q.question] ?? [])];
              const o = (other[q.question] ?? '').trim();
              if (o) parts.push(o);
              answers[q.question] = parts.join(', ');
            }
            decide(chatId, { approvalId: a.id, decision: 'allow', answers });
          }}
        >
          Ответить
        </Button>
        <Button variant="outline" className="h-11" onClick={() => decide(chatId, { approvalId: a.id, decision: 'deny', message: 'Пользователь пропустил вопрос' })}>
          Пропустить
        </Button>
      </div>
    </div>
  );
}

function ApprovalCard({ chatId, a, cwd }: { chatId: string; a: Approval; cwd: string }) {
  const [comment, setComment] = useState<string | null>(null);
  const Icon = a.kind === 'question' ? MessageCircleQuestionIcon : a.kind === 'plan' ? ClipboardListIcon : ShieldAlertIcon;
  return (
    <div className="overflow-hidden rounded-xl border border-warning/50 bg-card shadow-lg">
      <div className="flex items-start gap-2.5 border-b bg-warning/10 px-3 py-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {a.kind === 'command' ? 'Выполнить команду?' : a.kind === 'fileChange' ? 'Изменить файлы?' : a.kind === 'question' || a.kind === 'plan' ? a.title : `Разрешить ${a.tool}?`}
          </div>
          {a.detail && <div className="mt-0.5 text-xs text-muted-foreground break-anywhere">{a.detail}</div>}
        </div>
      </div>
      <div className="scrollbar-thin max-h-[45vh] space-y-2 overflow-y-auto px-3 py-2.5 md:max-h-[50vh]">
        {a.kind === 'command' && (
          <pre className="whitespace-pre-wrap break-anywhere rounded-md bg-muted/60 p-2.5 font-mono text-[12.5px]">
            <span className="select-none text-muted-foreground">$ </span>
            {a.command}
          </pre>
        )}
        {a.kind === 'fileChange' && (a.diffs?.length ? a.diffs.map((d, i) => <FileDiffView key={i} diff={d} cwd={cwd} maxHeight="max-h-72" />) : <div className="font-mono text-xs">{a.title}</div>)}
        {a.kind === 'tool' && (
          <div className="space-y-1">
            <div className="font-mono text-xs break-anywhere">{a.title}</div>
            {a.input ? (
              <pre className="scrollbar-thin max-h-40 overflow-auto whitespace-pre-wrap break-anywhere rounded-md bg-muted/60 p-2 font-mono text-[11.5px]">
                {JSON.stringify(a.input, null, 2)}
              </pre>
            ) : null}
          </div>
        )}
        {a.kind === 'plan' && <Markdown text={a.plan ?? ''} />}
        {a.kind === 'question' && <QuestionForm chatId={chatId} a={a} />}
      </div>
      {a.kind !== 'question' && (
        <div className="space-y-2 border-t px-3 py-2.5">
          {comment !== null && (
            <Textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={a.kind === 'plan' ? 'Что поправить в плане?' : 'Что сделать вместо этого? (необязательно)'}
              className="min-h-16 text-sm"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {comment === null ? (
              <>
                <Button className="h-11 min-w-28 flex-1 sm:h-9 sm:flex-none" onClick={() => decide(chatId, { approvalId: a.id, decision: 'allow' })}>
                  <CheckIcon /> {a.kind === 'plan' ? 'Начать' : 'Разрешить'}
                </Button>
                {(a.options ?? []).map((o) => (
                  <Button
                    key={o.id}
                    variant="outline"
                    className="h-auto min-h-11 max-w-full whitespace-normal py-2 text-left sm:min-h-9"
                    onClick={() => decide(chatId, { approvalId: a.id, decision: 'allow', optionId: o.id })}
                  >
                    {o.label}
                  </Button>
                ))}
                <Button variant="destructive" className="h-11 sm:h-9" onClick={() => setComment('')}>
                  <XIcon /> {a.kind === 'plan' ? 'Доработать' : 'Отклонить'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="destructive" className="h-11 flex-1 sm:h-9 sm:flex-none" onClick={() => decide(chatId, { approvalId: a.id, decision: 'deny', message: comment || undefined })}>
                  {a.kind === 'plan' ? 'Отправить замечания' : 'Отклонить'}
                </Button>
                <Button variant="ghost" className="h-11 sm:h-9" onClick={() => setComment(null)}>
                  Назад
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ApprovalPanel({ chatId, approvals, cwd }: { chatId: string; approvals: Approval[]; cwd: string }) {
  if (!approvals.length) return null;
  const a = approvals[0];
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-2 md:px-6">
      {approvals.length > 1 && <div className="mb-1 text-xs text-muted-foreground">Ещё запросов: {approvals.length - 1}</div>}
      <ApprovalCard key={a.id} chatId={chatId} a={a} cwd={cwd} />
    </div>
  );
}
