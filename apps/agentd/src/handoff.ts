import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, AttachedFile, ChatItem, FileDiff, TodoEntry, ToolItem } from '@mcc-agents/protocol';
import type { Chat } from './chat.ts';
import { isChatDir } from './chat-dirs.ts';
import { UPLOADS_DIR } from './uploads.ts';

/**
 * «Продолжить в другом агенте»: the dialogue of a chat as a Markdown file for another agent to read.
 * Built from the chat's normalized items (history read from disk — the old agent is not asked, its limits are not spent).
 * What a receiving agent needs: every user message verbatim (task, decisions), the agent's answers, what was done —
 * commands with exit codes (output only where it matters: failures and the last few), edited files with line counts
 * (the files themselves are on disk, `git diff` shows them), reads/searches as one-liners. Thinking is left out.
 * A conversation («Беседа», ~/chat/…) is not a project: no git, and of the steps only web lookups and the files it made.
 */

export const AGENT_LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

/** Above this the earlier long answers are shortened (the last ones stay whole). */
const SOFT_LIMIT = 300_000;
const KEEP_FULL_ANSWERS = 12;
const OUTPUT_LINES = 20;
const OUTPUT_CHARS = 2000;
/** Commands whose output is kept even when they succeeded (counted from the end of the dialogue). */
const LAST_OUTPUTS = 5;

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}\n${text}\n${f}`;
}

function tail(text: string): string {
  let lines = text.replace(/\s+$/, '').split('\n');
  const cut = lines.length > OUTPUT_LINES;
  if (cut) lines = lines.slice(-OUTPUT_LINES);
  let out = lines.join('\n');
  if (out.length > OUTPUT_CHARS) out = out.slice(-OUTPUT_CHARS);
  return (cut || out.length < text.trim().length ? '… (начало вывода опущено)\n' : '') + out;
}

function lineCounts(d: FileDiff): string {
  let add = 0;
  let del = 0;
  if (d.unified) {
    for (const l of d.unified.split('\n')) {
      if (l.startsWith('+') && !l.startsWith('+++')) add++;
      else if (l.startsWith('-') && !l.startsWith('---')) del++;
    }
  } else {
    add = d.newText ? d.newText.split('\n').length : 0;
    del = d.oldText ? d.oldText.split('\n').length : 0;
  }
  return `+${add} −${del}`;
}

const mark = (t: ToolItem) =>
  t.status === 'denied' ? ' — отклонено пользователем' : t.status === 'interrupted' ? ' — прервано' : t.status === 'error' && t.category !== 'bash' ? ' — ошибка' : '';

function toolLine(t: ToolItem, withOutput: boolean): string {
  const title = t.title.replace(/\s+/g, ' ').trim().slice(0, 300);
  switch (t.category) {
    case 'bash': {
      const code = t.exitCode !== undefined && t.exitCode !== null ? ` → код ${t.exitCode}` : t.status === 'error' ? ' → ошибка' : '';
      let s = `- команда: \`${title}\`${code}${mark(t)}`;
      if (withOutput && t.output?.trim()) s += `\n\n${fence(tail(t.output))}\n`;
      return s;
    }
    case 'edit':
    case 'write': {
      if (t.diffs?.length) return t.diffs.map((d) => `- ${d.kind === 'add' ? 'создан' : d.kind === 'delete' ? 'удалён' : 'изменён'} \`${d.path}\` (${lineCounts(d)})${mark(t)}`).join('\n');
      return `- правка: \`${title}\`${mark(t)}`;
    }
    case 'read':
      return `- прочитан: \`${title}\`${mark(t)}`;
    case 'search':
      return `- поиск: \`${title}\`${t.subtitle ? ` в ${t.subtitle}` : ''}`;
    case 'web':
      return `- веб: ${title}`;
    case 'task':
      return `- субагент: ${title}${mark(t)}`;
    case 'plan': {
      const plan = (t.input as { plan?: unknown } | undefined)?.plan;
      return typeof plan === 'string' && plan.trim() ? `- план:\n\n${plan.trim().slice(0, 6000)}\n` : '- план';
    }
    case 'todo':
      return ''; // the current list is at the end
    case 'question':
      return `- вопрос пользователю: ${title}`;
    default:
      return `- инструмент ${t.tool}: ${title}${mark(t)}`;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) =>
      resolve(err ? '' : String(out)),
    );
  });
}

async function gitState(cwd: string): Promise<string> {
  if (!cwd || !fs.existsSync(cwd)) return '';
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return '';
  const branch = (await git(cwd, ['branch', '--show-current'])).trim();
  const last = (await git(cwd, ['log', '-1', '--format=%h %s'])).trim();
  const status = (await git(cwd, ['status', '--short', '--untracked-files=all'])).trim().split('\n').slice(0, 80).join('\n');
  const stat = (await git(cwd, ['diff', 'HEAD', '--stat'])).trim().split('\n').slice(-40).join('\n');
  let s = `### git\n\nВетка: \`${branch || '—'}\`, последний коммит: ${last || '—'}\n\n`;
  s += status ? `Незакоммиченные изменения (\`git status --short\`):\n\n${fence(status)}\n` : 'Незакоммиченных изменений нет.\n';
  if (stat) s += `\n\`git diff HEAD --stat\`:\n\n${fence(stat)}\n`;
  return s;
}

function todosBlock(todos: TodoEntry[]): string {
  if (!todos.length) return '';
  const sign = { completed: '[x]', in_progress: '[~]', pending: '[ ]' } as const;
  return `### Список задач агента\n\n${todos.map((t) => `- ${sign[t.status]} ${t.content}`).join('\n')}\n`;
}

/** The Markdown transcript. */
export async function transcript(chat: Chat, title: string): Promise<string> {
  const items: ChatItem[] = chat.state.items.filter((i) => !i.parentId); // a subagent's steps stay inside it
  const agent = AGENT_LABEL[chat.agent];
  const bashIdx = items.flatMap((it, i) => (it.kind === 'tool' && it.category === 'bash' ? [i] : []));
  const keepOutput = new Set(bashIdx.slice(-LAST_OUTPUTS));
  const answers = items.flatMap((it, i) => (it.kind === 'assistant' && it.text.trim() ? [i] : []));
  const total = items.reduce((n, it) => n + (it.kind === 'assistant' || it.kind === 'user' ? it.text.length : 200), 0);
  const shorten = total > SOFT_LIMIT ? new Set(answers.slice(0, -KEEP_FULL_ANSWERS)) : new Set<number>();
  const talk = isChatDir(chat.cwd);

  const out: string[] = [];
  out.push(`# ${talk ? 'Беседа' : 'Разговор'} из ${agent}: «${title}»`);
  out.push('');
  out.push(`- Агент: ${agent}${chat.state.settings.model ? `, модель \`${chat.state.settings.model}\`` : ''}`);
  out.push(`- ${talk ? 'Папка беседы' : 'Папка'}: \`${chat.cwd}\``);
  out.push(`- Чат: \`${chat.id}\``);
  out.push(`- Передан: ${new Date().toLocaleString('ru-RU')}`);
  out.push('');
  out.push(
    talk
      ? 'Это беседа, а не работа над проектом. Ниже весь разговор по порядку: сообщения пользователя и ответы ассистента — как были. ' +
          'Из действий — только поиски в интернете и созданные файлы (они лежат в папке беседы). Размышления не включены.'
      : 'Ниже весь разговор по порядку. Сообщения пользователя и ответы агента — как были. Действия агента — кратко: команды с кодом ' +
          `выхода (вывод — только у упавших и у последних ${LAST_OUTPUTS}), изменённые файлы с числом строк (сами изменения — на диске, ` +
          'смотри `git diff`), прочитанное и поиски. Размышления агента не включены.',
  );
  out.push('');
  out.push('## Разговор');
  let who: 'user' | 'agent' | null = null;
  items.forEach((it, i) => {
    if (it.kind === 'user') {
      who = 'user';
      out.push('', '### 👤 Пользователь', '');
      out.push(it.text.trim() || '(без текста)');
      const extra = [...(it.files ?? []).map((f) => `\`${f.path}\` («${f.name}»)`), ...(it.images ?? []).map((m) => `картинка${m.name ? ` ${m.name}` : ''}`)];
      if (extra.length) out.push('', `Вложения: ${extra.join(', ')}`);
      return;
    }
    if (it.kind === 'thinking') return;
    if (it.kind === 'notice') {
      if (it.level === 'info' && !/сжат|compact/i.test(it.text)) return;
      out.push('', `> ${it.level === 'error' ? '⚠️ Ошибка' : it.level === 'warn' ? '⚠️' : 'ℹ️'}: ${it.text.replace(/\n/g, ' ').slice(0, 600)}`);
      return;
    }
    if (who !== 'agent') {
      who = 'agent';
      out.push('', `### 🤖 ${agent}`);
    }
    if (it.kind === 'assistant') {
      let text = it.text.trim();
      if (!text) return;
      if (shorten.has(i) && text.length > 1500) text = `${text.slice(0, 1500)}\n\n… (длинный ответ сокращён при передаче)`;
      out.push('', text);
      return;
    }
    if (talk && !['web', 'write', 'edit', 'plan', 'question'].includes(it.category)) return;
    const line = toolLine(it, it.category === 'bash' && (it.status === 'error' || keepOutput.has(i)));
    if (line) {
      // tool lines stick together as a list
      if (out.at(-1)?.startsWith('- ') === false) out.push('');
      out.push(line);
    }
  });
  const todos = todosBlock(chat.state.todos);
  // a conversation has no git: the section only when there is a task list
  if (todos || !talk) out.push('', '## Состояние на момент передачи', '');
  if (todos) out.push(todos);
  if (!talk) {
    const g = await gitState(chat.cwd);
    out.push(g || 'Папка не в git-репозитории.\n');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Save the transcript as an attachment (kept with the other uploads). */
export async function handoffFile(chat: Chat, title: string): Promise<AttachedFile> {
  const text = await transcript(chat, title);
  fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  const name = `история-${chat.agent}-${new Date().toISOString().slice(0, 10)}.md`;
  const file = path.join(UPLOADS_DIR, `${randomUUID().slice(0, 8)}-${name}`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { path: file, name, size: Buffer.byteLength(text), mediaType: 'text/markdown' };
}

/** «Перенести в проект»: the first message of a project chat that picks up a conversation. */
export function promoteMessage(from: AgentKind, title: string, chatDir: string, cwd: string, note?: string): string {
  let s =
    `Переносим в проект \`${cwd}\` беседу, которая шла в ${AGENT_LABEL[from]} («${title}»). Вся её история — в приложенном файле: ` +
    `прочитай его целиком. Файлы, созданные в беседе, лежат в \`${chatDir}\` — бери оттуда, если понадобятся.\n\n` +
    'Сейчас: коротко напиши, о чём была беседа, что из неё относится к этому проекту и что, по-твоему, нужно сделать. ' +
    'Потом жди моей команды: ничего не меняй и не запускай, пока я не скажу.';
  if (note?.trim()) s += `\n\n${note.trim()}`;
  return s;
}

/** The first message of the new chat. */
export function handoffMessage(from: AgentKind, title: string, cwd: string, note?: string): string {
  if (isChatDir(cwd)) {
    let t =
      `Продолжаем беседу, которая шла в ${AGENT_LABEL[from]} («${title}»). Вся её история — в приложенном файле: прочитай его целиком.\n\n` +
      'Сейчас: в двух-трёх фразах напомни, о чём мы говорили и на чём остановились, — и продолжай беседу как ни в чём не бывало.';
    if (note?.trim()) t += `\n\n${note.trim()}`;
    return t;
  }
  let s =
    `Продолжаем разговор, который шёл в ${AGENT_LABEL[from]} (чат «${title}», папка \`${cwd}\`). ` +
    'Вся его история — в приложенном файле: прочитай его целиком.\n\n' +
    'Сейчас: коротко напиши, о чём разговор, что уже сделано (изменения в файлах уже на диске — сверься с git), ' +
    'какие были договорённости и что осталось. Потом жди моей команды: ничего не меняй и не запускай, пока я не скажу.';
  if (note?.trim()) s += `\n\n${note.trim()}`;
  return s;
}
