'use client';

import { useMemo } from 'react';
import type { FileDiff } from '@mcc-agents/protocol';
import { diffLines, diffStats, parseUnified, type DiffLine } from '@/lib/diff';
import { shortPath } from '@/lib/format';
import { cn } from '@/lib/utils';

export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  return (
    <span className={cn('font-mono text-xs tabular', className)}>
      {add > 0 && <span className="text-diff-add">+{add}</span>}
      {add > 0 && del > 0 && ' '}
      {del > 0 && <span className="text-diff-del">−{del}</span>}
    </span>
  );
}

export function DiffLines({ lines, maxHeight = 'max-h-96' }: { lines: DiffLine[]; maxHeight?: string }) {
  return (
    <div className={cn('scrollbar-thin overflow-auto font-mono text-[12px] leading-[1.55]', maxHeight)}>
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) =>
            l.type === 'hunk' ? (
              <tr key={i} className="bg-info/10 text-muted-foreground">
                <td colSpan={3} className="px-2 py-0.5 text-[11px]">
                  {l.text}
                </td>
              </tr>
            ) : (
              <tr key={i} className={cn(l.type === 'add' && 'bg-diff-add/12', l.type === 'del' && 'bg-diff-del/12')}>
                <td className="w-0 select-none px-1.5 text-right align-top text-[10.5px] text-muted-foreground/60">{l.oldNo ?? ''}</td>
                <td className="w-0 select-none px-1.5 text-right align-top text-[10.5px] text-muted-foreground/60">{l.newNo ?? ''}</td>
                <td className="whitespace-pre pr-3 align-top">
                  <span className={cn('mr-1 select-none', l.type === 'add' ? 'text-diff-add' : l.type === 'del' ? 'text-diff-del' : 'text-transparent')}>
                    {l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}
                  </span>
                  {l.text || ' '}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

export function FileDiffView({ diff, cwd, maxHeight }: { diff: FileDiff; cwd?: string; maxHeight?: string }) {
  const lines = useMemo(() => diffLines(diff), [diff]);
  const st = diffStats(lines);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-2.5 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono" title={diff.path}>
          {shortPath(diff.path, cwd)}
          {diff.kind === 'add' && <span className="ml-1.5 text-diff-add">новый</span>}
          {diff.kind === 'delete' && <span className="ml-1.5 text-diff-del">удалён</span>}
        </span>
        <DiffStat {...st} />
      </div>
      <DiffLines lines={lines} maxHeight={maxHeight} />
    </div>
  );
}

export function UnifiedDiffView({ text, maxHeight }: { text: string; maxHeight?: string }) {
  const lines = useMemo(() => parseUnified(text), [text]);
  return <DiffLines lines={lines} maxHeight={maxHeight} />;
}
