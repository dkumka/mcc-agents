import type { AgentKind, ChatStatus } from '@mcc-agents/protocol';
import { cn } from '@/lib/utils';

export const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

const MARK: Record<AgentKind, { letter: string; cls: string }> = {
  claude: { letter: 'C', cls: 'bg-claude' },
  codex: { letter: 'X', cls: 'bg-codex text-background' },
  antigravity: { letter: 'A', cls: 'bg-antigravity' },
};

/** Small square mark: orange "C" for Claude, slate "X" for Codex, blue "A" for Antigravity. */
export function AgentMark({ agent, className }: { agent: AgentKind; className?: string }) {
  return (
    <span
      aria-label={AGENT_NAME[agent]}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-bold leading-none text-white',
        MARK[agent].cls,
        className,
      )}
    >
      {MARK[agent].letter}
    </span>
  );
}

export function StatusDot({ status, unread, className }: { status: ChatStatus; unread?: boolean; className?: string }) {
  if (status === 'running' || status === 'starting')
    return (
      <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-label="работает">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-info" />
      </span>
    );
  if (status === 'waiting') return <span className={cn('inline-flex size-2 shrink-0 rounded-full bg-warning', className)} aria-label="ждёт подтверждения" />;
  if (status === 'error') return <span className={cn('inline-flex size-2 shrink-0 rounded-full bg-destructive', className)} aria-label="ошибка" />;
  if (unread) return <span className={cn('inline-flex size-2 shrink-0 rounded-full bg-foreground/70', className)} aria-label="новое" />;
  return null;
}
