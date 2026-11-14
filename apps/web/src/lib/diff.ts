import { structuredPatch } from 'diff';
import type { FileDiff } from '@mcc-agents/protocol';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export function parseUnified(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  for (const raw of unified.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file mode') || raw.startsWith('deleted file mode'))
      continue;
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ type: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) out.push({ type: 'add', text: raw.slice(1), newNo: n++ });
    else if (raw.startsWith('-')) out.push({ type: 'del', text: raw.slice(1), oldNo: o++ });
    else if (raw.startsWith('\\')) continue;
    else out.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNo: o++, newNo: n++ });
  }
  while (out.length && out[out.length - 1].type === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

export function diffLines(d: FileDiff): DiffLine[] {
  if (d.unified) return parseUnified(d.unified);
  if (d.kind === 'add') return (d.newText ?? '').split('\n').map((t, i) => ({ type: 'add', text: t, newNo: i + 1 }));
  if (d.kind === 'delete') return (d.oldText ?? '').split('\n').map((t, i) => ({ type: 'del', text: t, oldNo: i + 1 }));
  const p = structuredPatch('a', 'b', d.oldText ?? '', d.newText ?? '', '', '', { context: 3 });
  const out: DiffLine[] = [];
  for (const h of p.hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    out.push({ type: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    for (const l of h.lines) {
      if (l.startsWith('+')) out.push({ type: 'add', text: l.slice(1), newNo: n++ });
      else if (l.startsWith('-')) out.push({ type: 'del', text: l.slice(1), oldNo: o++ });
      else if (!l.startsWith('\\')) out.push({ type: 'ctx', text: l.slice(1), oldNo: o++, newNo: n++ });
    }
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}

/** Split a multi-file unified diff (git diff) into per-file chunks. */
export function splitGitDiff(diff: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const parts = diff.split(/^diff --git /m).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^a\/(.+?) b\/(.+?)\n/);
    out.push({ path: m ? m[2] : 'файл', text: 'diff --git ' + p });
  }
  return out;
}
