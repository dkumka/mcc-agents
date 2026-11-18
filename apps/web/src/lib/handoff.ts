import { toast } from 'sonner';
import type { AgentKind, ChatSummary } from '@mcc-agents/protocol';
import { api } from '@/lib/api';
import { store } from '@/lib/store';

export const AGENT_NAME: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
export const otherAgent = (a: AgentKind): AgentKind => (a === 'claude' ? 'codex' : 'claude');

const FORMAT: Record<AgentKind, string> = {
  codex:
    'формат JSONL Codex: мои реплики — записи `response_item` с `role: "user"`, ответы — с `role: "assistant"`; ' +
    'записи `developer` — служебные инструкции Codex, вызовы инструментов и их вывод — рабочие шаги, их только учитывай',
  claude:
    'формат JSONL Claude Code: строки `type: "user"` и `type: "assistant"`, текст — в `message.content`; ' +
    'строки `user` с `tool_result` — это вывод инструментов, а не мои сообщения; `tool_use` — рабочие шаги, их только учитывай',
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
  const draft = [
    `Продолжим работу, которую я начал в ${from} в чате «${chat.title}». Полная история лежит в файле`,
    info.path,
    `(${FORMAT[chat.agent]}).`,
    code ? `Рабочая папка та же: ${info.cwd}.` : `Файлы той беседы, если понадобятся, — в папке ${info.cwd}.`,
    '',
    'Прочитай историю целиком и:',
    '1. Кратко перескажи, о чём шла речь: мои цели, исходные данные, к каким решениям мы пришли и что уже сделано.',
    `2. Отметь, что в ответах ${from} выглядит спорным, ошибочным или недоделанным, — с пояснением.`,
    code ? '3. Проверь текущее состояние файлов и git: что из обсуждённого действительно сделано.' : '3. Скажи, на чём мы остановились.',
    '4. Предложи, как продолжить.',
    '',
    `Дальше работаем в этом чате, на ${from} больше не опирайся.`,
  ].join('\n');
  store.navigate({ kind: 'new', agent: otherAgent(chat.agent), mode: code ? 'code' : 'chat', cwd: code ? info.cwd : undefined, draft });
}
