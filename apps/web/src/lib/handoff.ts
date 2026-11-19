import { toast } from 'sonner';
import type { AgentKind, ChatSummary } from '@mcc-agents/protocol';
import { api } from '@/lib/api';
import { store } from '@/lib/store';

export const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
export const otherAgent = (a: AgentKind): AgentKind => (a === 'claude' ? 'codex' : 'claude');

const FORMAT: Record<AgentKind, string> = {
  codex: 'JSONL Codex: мои реплики — `role: "user"`, ответы — `role: "assistant"`, записи `developer` пропусти',
  claude: 'JSONL Claude Code: `type: "user"` / `"assistant"`; `user` с `tool_result` — вывод инструментов, не мои слова',
};

/**
 * «Продолжить в другом агенте»: a real fork between CLIs is impossible (different history formats), so the new
 * chat gets a prompt with the path to the full history — the other agent reads it itself, then the user sends it.
 */
export async function continueInOtherAgent(chat: ChatSummary) {
  let info: Awaited<ReturnType<typeof api.sessionFile>>;
  try {
    info = await api.sessionFile(chat.id);
  } catch (e) {
    toast.error('Не удалось найти историю чата', { description: (e as Error).message });
    return;
  }
  const from = AGENT_NAME[chat.agent];
  const code = info.mode !== 'chat';
  const text = [
    `Продолжим работу из ${from}, чат «${chat.title}». Полная история: ${info.path} (${FORMAT[chat.agent]}).`,
    code ? `Рабочая папка та же: ${info.cwd}.` : `Файлы той беседы — в ${info.cwd}.`,
    '',
    `Прочитай историю и кратко: цели и решения; что в ответах ${from} спорно или не доделано;` +
      (code ? ' что из этого реально сделано в файлах и git;' : '') + ' на чём остановились и как продолжить.',
    `Дальше работаем здесь, на ${from} не опирайся.`,
  ].join('\n');
  // like «Открыть как новую задачу»: the route (and the address bar) carries only an id, the text waits in localStorage
  const draft = crypto.randomUUID();
  localStorage.setItem(`draft:task:${draft}`, text);
  store.navigate({ kind: 'new', agent: otherAgent(chat.agent), mode: code ? 'code' : 'chat', cwd: code ? info.cwd : undefined, draft });
}
