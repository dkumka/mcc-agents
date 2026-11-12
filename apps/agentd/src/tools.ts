import type { FileDiff, ToolCategory } from '@mcc-agents/protocol';

type Input = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v));

/** Claude Code tool name + input → category, one-line title, optional diffs. */
export function classifyClaudeTool(
  name: string,
  inputRaw: unknown,
): { category: ToolCategory; title: string; subtitle?: string; diffs?: FileDiff[] } {
  const input = (inputRaw && typeof inputRaw === 'object' ? inputRaw : {}) as Input;
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { category: 'bash', title: str(input.command), subtitle: str(input.description) || undefined };
    case 'BashOutput':
    case 'KillShell':
    case 'TaskStop':
    case 'Monitor':
      return { category: 'bash', title: name, subtitle: str(input.description ?? input.bash_id ?? input.task_id ?? input.shell_id) };
    case 'Edit':
      return {
        category: 'edit',
        title: str(input.file_path),
        diffs: [{ path: str(input.file_path), kind: 'update', oldText: str(input.old_string), newText: str(input.new_string) }],
      };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [];
      return {
        category: 'edit',
        title: str(input.file_path),
        diffs: edits.map((e) => ({ path: str(input.file_path), kind: 'update' as const, oldText: str(e.old_string), newText: str(e.new_string) })),
      };
    }
    case 'Write':
      return { category: 'write', title: str(input.file_path), diffs: [{ path: str(input.file_path), kind: 'add', newText: str(input.content) }] };
    case 'NotebookEdit':
      return { category: 'edit', title: str(input.notebook_path) };
    case 'Read':
      return {
        category: 'read',
        title: str(input.file_path),
        subtitle: input.offset ? `строки ${input.offset}–${Number(input.offset) + Number(input.limit ?? 0)}` : undefined,
      };
    case 'Grep':
      return { category: 'search', title: str(input.pattern), subtitle: str(input.path ?? input.glob) || undefined };
    case 'Glob':
      return { category: 'search', title: str(input.pattern), subtitle: str(input.path) || undefined };
    case 'LS':
      return { category: 'search', title: str(input.path) };
    case 'WebFetch':
      return { category: 'web', title: str(input.url), subtitle: str(input.prompt) || undefined };
    case 'WebSearch':
      return { category: 'web', title: str(input.query) };
    case 'Task':
    case 'Agent':
      return { category: 'task', title: str(input.description) || 'Субагент', subtitle: str(input.subagent_type) || undefined };
    case 'TodoWrite':
      return { category: 'todo', title: 'Список задач' };
    case 'ExitPlanMode':
      return { category: 'plan', title: 'План' };
    case 'EnterPlanMode':
      return { category: 'plan', title: 'Режим планирования' };
    case 'AskUserQuestion':
      return { category: 'question', title: 'Вопрос' };
    case 'Skill':
      return { category: 'skill', title: str(input.skill), subtitle: str(input.args) || undefined };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { category: 'mcp', title: `${server} · ${rest.join('__')}` };
      }
      return { category: 'other', title: name };
  }
}

/** Claude `structuredPatch` → unified diff hunks. */
export function patchToUnified(patch: unknown): string | undefined {
  if (!Array.isArray(patch)) return undefined;
  const out: string[] = [];
  for (const h of patch as { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]) {
    if (!h || !Array.isArray(h.lines)) continue;
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    out.push(...h.lines);
  }
  return out.length ? out.join('\n') : undefined;
}

/** Strip Codex's `/bin/bash -lc '…'` wrapper for display. */
export function unwrapShell(cmd: string): string {
  const m = cmd.match(/^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/);
  if (!m) return cmd;
  return m[1] === "'" ? m[2].replace(/'\\''/g, "'") : m[2];
}
