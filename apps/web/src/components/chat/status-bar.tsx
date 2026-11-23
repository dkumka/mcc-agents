'use client';

import { ActivityIcon } from 'lucide-react';
import type { AgentKind, AgentLimits, BgTask, LimitWindow, Usage } from '@mcc-agents/protocol';
import { useRef, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AGENT_NAME } from '@/components/agent-badge';
import { resetAt, resetIn, timeAgo, tokens } from '@/lib/format';
import { ui } from '@/lib/ui';
import { cn } from '@/lib/utils';

export function levelClass(p: number) {
  return p >= 95 ? 'text-destructive' : p >= 80 ? 'text-warning' : '';
}

function Ring({ percent }: { percent: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, percent) / 100)} className="stroke-current" strokeLinecap="round" />
    </svg>
  );
}

function UsageBar({ w }: { w: LimitWindow }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{w.label}</span>
        <span className={cn('tabular', levelClass(w.usedPercent))}>{w.usedPercent}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', w.usedPercent >= 95 ? 'bg-destructive' : w.usedPercent >= 80 ? 'bg-warning' : 'bg-foreground/60')}
          style={{ width: `${Math.min(100, w.usedPercent)}%` }}
        />
      </div>
      <div className="text-muted-foreground">{w.resetsAt ? `Сброс ${resetIn(w.resetsAt)} — ${resetAt(w.resetsAt)}` : 'Время сброса неизвестно'}</div>
    </div>
  );
}

/**
 * «5 часов 6% · Неделя 9%» — tap (phone) or hover (mouse) shows when each limit resets.
 * The numbers come with the agents' own answers (Claude: rate_limit_event, Codex: account/rateLimits), so they can be a bit old.
 * Antigravity counts per group of models: inline — the group of `model` (else the first, Gemini), the card — all groups.
 */
export function LimitsInline({ limits, agent, model, className }: { limits: AgentLimits[]; agent: AgentKind; model?: string; className?: string }) {
  const l = limits.find((x) => x.agent === agent);
  const [open, setOpen] = useState(false);
  const hover = useRef<number | undefined>(undefined);
  if (!l || !l.windows.length) return null;
  const grouped = l.windows.some((w) => w.groupId);
  const gid = grouped ? ((model && l.windows.find((w) => w.models?.includes(model))?.groupId) ?? l.windows[0].groupId) : undefined;
  // «5 часов» before «Неделя», as for Claude / Codex
  const five = (w: LimitWindow) => (w.label === '5 часов' ? 0 : 1);
  const shown = grouped ? l.windows.filter((w) => w.groupId === gid).sort((a, b) => five(a) - five(b)) : l.windows;
  const groups = grouped ? [...new Set(l.windows.map((w) => w.groupId))].sort((a, b) => (a === gid ? -1 : b === gid ? 1 : 0)) : [];
  const fine = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const enter = () => {
    if (!fine()) return;
    window.clearTimeout(hover.current);
    hover.current = window.setTimeout(() => setOpen(true), 150);
  };
  const leave = () => {
    if (!fine()) return;
    window.clearTimeout(hover.current);
    hover.current = window.setTimeout(() => setOpen(false), 200);
  };
  const ago = ((a: string) => (a === 'сейчас' ? 'только что' : /\d (мин|ч|д)$/.test(a) ? `${a} назад` : a))(timeAgo(l.updatedAt));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={enter}
          onMouseLeave={leave}
          className={cn('inline-flex items-center gap-2 rounded px-0.5 text-left hover:text-foreground', className)}
          aria-label={`Лимиты ${AGENT_NAME[agent]}: когда сброс`}
        >
          {grouped && <span>{shown[0]?.group}</span>}
          {shown.map((w) => (
            <span key={w.id} className={cn('tabular', levelClass(w.usedPercent))}>
              {w.label} {w.usedPercent}%
            </span>
          ))}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="max-h-[70vh] w-72 space-y-3 overflow-y-auto p-3 text-xs"
        onMouseEnter={enter}
        onMouseLeave={leave}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{AGENT_NAME[agent]}</span>
          {l.plan && <span className="truncate text-muted-foreground">{l.plan}</span>}
        </div>
        {grouped
          ? groups.map((g) => {
              const ws = l.windows.filter((w) => w.groupId === g).sort((a, b) => five(a) - five(b));
              return (
                <div key={g} className="space-y-2">
                  <div className="font-medium text-foreground">
                    {ws[0]?.group}
                    {g === gid && model ? <span className="ml-1.5 font-normal text-muted-foreground">— модель этого чата</span> : null}
                  </div>
                  {ws.map((w) => (
                    <UsageBar key={w.id} w={w} />
                  ))}
                </div>
              );
            })
          : l.windows.map((w) => <UsageBar key={w.id} w={w} />)}
        {l.updatedAt ? (
          <div className="border-t pt-2 text-[11px] text-muted-foreground">
            {agent === 'antigravity'
              ? `У каждой группы моделей свои лимиты. Обновляются после каждого ответа Antigravity; последние — ${ago}.`
              : `Данные приходят с ответами ${AGENT_NAME[agent]}; последние — ${ago}.`}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function StatusBar({ usage, limits, agent, model, tasks }: { usage?: Usage; limits: AgentLimits[]; agent: AgentKind; model?: string; tasks: BgTask[] }) {
  const running = tasks.filter((t) => t.status === 'running').length;
  return (
    <div className="mx-auto flex w-full max-w-3xl items-center gap-3 overflow-x-auto px-4 pt-1.5 text-[11px] text-muted-foreground md:px-7">
      {usage && usage.contextTokens > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={cn('inline-flex shrink-0 items-center gap-1 tabular', levelClass(usage.percent))}>
              <Ring percent={usage.percent} />
              {usage.contextWindow ? `${usage.percent}%` : tokens(usage.contextTokens)}
              <span className="hidden sm:inline">контекста</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Контекст: {tokens(usage.contextTokens)}
            {usage.contextWindow ? ` из ${tokens(usage.contextWindow)}` : ''}
          </TooltipContent>
        </Tooltip>
      )}
      <LimitsInline limits={limits} agent={agent} model={model} className="shrink-0" />
      {tasks.length > 0 && (
        <button type="button" onClick={() => ui.set({ panel: 'tasks' })} className={cn('ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground', running && 'text-info')}>
          <ActivityIcon className="size-3" />
          {running ? `в фоне: ${running}` : `задачи: ${tasks.length}`}
        </button>
      )}
    </div>
  );
}
