'use client';

import { ActivityIcon } from 'lucide-react';
import type { AgentKind, AgentLimits, BgTask, Usage } from '@mcc-agents/protocol';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { resetIn, tokens } from '@/lib/format';
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

export function LimitsInline({ limits, agent, className }: { limits: AgentLimits[]; agent: AgentKind; className?: string }) {
  const l = limits.find((x) => x.agent === agent);
  if (!l || !l.windows.length) return null;
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {l.windows.map((w) => (
        <Tooltip key={w.id}>
          <TooltipTrigger asChild>
            <span className={cn('tabular', levelClass(w.usedPercent))}>
              {w.label} {w.usedPercent}%
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Лимит «{w.label}»: использовано {w.usedPercent}%{w.resetsAt ? `, сброс ${resetIn(w.resetsAt)}` : ''}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}

export function StatusBar({ usage, limits, agent, tasks }: { usage?: Usage; limits: AgentLimits[]; agent: AgentKind; tasks: BgTask[] }) {
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
      <LimitsInline limits={limits} agent={agent} className="shrink-0" />
      {tasks.length > 0 && (
        <button type="button" onClick={() => ui.set({ panel: 'tasks' })} className={cn('ml-auto inline-flex shrink-0 items-center gap-1 hover:text-foreground', running && 'text-info')}>
          <ActivityIcon className="size-3" />
          {running ? `в фоне: ${running}` : `задачи: ${tasks.length}`}
        </button>
      )}
    </div>
  );
}
