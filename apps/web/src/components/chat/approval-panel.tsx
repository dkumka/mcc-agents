'use client';

import { useState } from 'react';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  SparklesIcon,
  XIcon,
} from 'lucide-react';
import type { Approval, ApprovalDecision, Question } from '@mcc-agents/protocol';
import { FileDiffView } from '@/components/diff-view';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { displayOption } from '@/lib/questions';
import { store } from '@/lib/store';
import { cn } from '@/lib/utils';

function decide(chatId: string, d: ApprovalDecision) {
  store.decide(chatId, d);
}

function isAnswered(q: Question, sel: Record<string, string[]>, other: Record<string, string>): boolean {
  return (sel[q.question]?.length ?? 0) > 0 || !!(other[q.question] ?? '').trim();
}

function recommendedRawLabel(q: Question): string | null {
  for (const o of q.options) {
    const d = displayOption(o);
    if (d.recommended) return d.rawLabel;
  }
  return null;
}

function QuestionForm({ chatId, a }: { chatId: string; a: Approval }) {
  const qs = a.questions ?? [];
  const [step, setStep] = useState(0);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  if (!qs.length) {
    return (
      <div className="px-3 py-2.5">
        <Button variant="outline" className="h-11" onClick={() => decide(chatId, { approvalId: a.id, decision: 'deny', message: 'Пользователь пропустил вопрос' })}>
          Закрыть
        </Button>
      </div>
    );
  }

  const idx = Math.min(step, qs.length - 1);
  const q = qs[idx];
  const multi = qs.length > 1;
  const answeredCount = qs.filter((item) => isAnswered(item, sel, other)).length;
  const currentAnswered = isAnswered(q, sel, other);
  const ready = answeredCount === qs.length;
  const isLast = idx === qs.length - 1;

  const allHaveRecommended = qs.every((item) => recommendedRawLabel(item) !== null);
  const hasMissingRecommended =
    allHaveRecommended &&
    qs.some((item) => {
      const rec = recommendedRawLabel(item);
      if (!rec) return false;
      return !isAnswered(item, sel, other);
    });

  const applyRecommended = () => {
    setSel((prev) => {
      const next = { ...prev };
      for (const item of qs) {
        if (isAnswered(item, prev, other)) continue;
        const rec = recommendedRawLabel(item);
        if (rec) next[item.question] = [rec];
      }
      return next;
    });
  };

  const submit = () => {
    if (!ready) {
      const firstUnanswered = qs.findIndex((item) => !isAnswered(item, sel, other));
      if (firstUnanswered >= 0) setStep(firstUnanswered);
      return;
    }
    const answers: Record<string, string> = {};
    const answerLists: Record<string, string[]> = {};
    for (const item of qs) {
      const parts = [...(sel[item.question] ?? [])];
      const o = (other[item.question] ?? '').trim();
      if (o) parts.push(o);
      answers[item.question] = parts.join(', ');
      answerLists[item.question] = parts;
    }
    decide(chatId, { approvalId: a.id, decision: 'allow', answers, answerLists });
  };

  return (
    <div className="flex flex-col">
      {multi && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
          <div className="text-xs font-medium text-muted-foreground tabular">
            Вопрос {idx + 1} из {qs.length}
            {answeredCount > 0 && <span className="ml-1.5 text-foreground">· отвечено {answeredCount}/{qs.length}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Вопросы">
            {qs.map((item, i) => {
              const done = isAnswered(item, sel, other);
              const active = i === idx;
              return (
                <button
                  key={item.question}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={`Вопрос ${i + 1}${done ? ' (отвечен)' : ''}`}
                  onClick={() => setStep(i)}
                  className={cn(
                    'inline-flex h-10 min-w-10 items-center justify-center rounded-md border px-2 text-xs font-medium tabular transition-colors sm:h-8 sm:min-w-8',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : done
                        ? 'border-success/50 bg-success/10 text-success hover:bg-success/20'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {done && !active ? <CheckIcon className="size-3.5" /> : i + 1}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="scrollbar-thin max-h-[38vh] space-y-2.5 overflow-y-auto px-3 py-3 md:max-h-[48vh]">
        <div className="space-y-1">
          {q.header && <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{q.header}</div>}
          <div className="text-sm font-medium leading-snug break-anywhere">{q.question}</div>
          {q.multiSelect && <div className="text-xs text-muted-foreground">Можно выбрать несколько вариантов</div>}
        </div>

        <div className="grid gap-1.5">
          {q.options.map((rawOpt, optIdx) => {
            const opt = displayOption(rawOpt);
            const on = sel[q.question]?.includes(opt.rawLabel) ?? false;
            return (
              <button
                key={`${optIdx}-${opt.rawLabel}`}
                type="button"
                onClick={() => {
                  setSel((s) => {
                    const cur = s[q.question] ?? [];
                    const next = q.multiSelect ? (on ? cur.filter((x) => x !== opt.rawLabel) : [...cur, opt.rawLabel]) : on ? [] : [opt.rawLabel];
                    return { ...s, [q.question]: next };
                  });
                  if (!q.multiSelect && !on) {
                    setOther((s) => (s[q.question] ? { ...s, [q.question]: '' } : s));
                  }
                }}
                className={cn(
                  'flex min-h-11 w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                  on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center border text-[11px] font-medium tabular',
                    q.multiSelect ? 'rounded' : 'rounded-full',
                    on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 text-muted-foreground',
                  )}
                >
                  {on ? <CheckIcon className="size-3" /> : optIdx + 1}
                </span>
                <span className="min-w-0 flex-1 break-anywhere">
                  <span className="font-medium leading-snug">{opt.label}</span>
                  {opt.recommended && (
                    <span className="ml-1.5 inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-primary">
                      Рекомендуется
                    </span>
                  )}
                  {opt.description && <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>}
                </span>
              </button>
            );
          })}
          <input
            value={other[q.question] ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              setOther((s) => ({ ...s, [q.question]: val }));
              if (!q.multiSelect && val.trim()) {
                setSel((s) => (s[q.question]?.length ? { ...s, [q.question]: [] } : s));
              }
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!isLast && currentAnswered) setStep(idx + 1);
              else if (ready) submit();
            }}
            placeholder="Другое — свой ответ…"
            className="h-11 w-full rounded-lg border bg-background px-3 text-base outline-none focus:border-ring sm:text-sm"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5">
        {multi && (
          <Button type="button" variant="outline" className="h-11 px-3 sm:h-9" disabled={idx === 0} onClick={() => setStep(idx - 1)}>
            <ChevronLeftIcon className="size-4" /> Назад
          </Button>
        )}
        {multi && !isLast && (
          <Button
            type="button"
            variant={currentAnswered && !ready ? 'default' : 'outline'}
            className="h-11 flex-1 sm:h-9 sm:flex-none"
            onClick={() => setStep(idx + 1)}
          >
            Далее <ChevronRightIcon className="size-4" />
          </Button>
        )}
        {(!multi || isLast || ready) && (
          <Button type="button" className="h-11 flex-1 sm:h-9 sm:flex-none" disabled={!ready} onClick={submit}>
            <CheckIcon className="size-4" /> {multi ? 'Отправить ответы' : 'Ответить'}
          </Button>
        )}
        {multi && hasMissingRecommended && (
          <Button type="button" variant="secondary" className="h-11 sm:h-9" onClick={applyRecommended}>
            <SparklesIcon className="size-3.5" /> Рекомендуемые
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="ml-auto h-11 text-muted-foreground sm:h-9"
          onClick={() => decide(chatId, { approvalId: a.id, decision: 'deny', message: 'Пользователь пропустил вопрос' })}
        >
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
      {a.kind === 'question' ? (
        <QuestionForm chatId={chatId} a={a} />
      ) : (
        <>
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
          </div>
          <div className="space-y-2 border-t px-3 py-2.5">
            {comment !== null && (
              <Textarea
                autoFocus
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={a.kind === 'plan' ? 'Что поправить в плане?' : 'Что сделать вместо этого? (необязательно)'}
                className="min-h-16 text-base sm:text-sm"
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
        </>
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
