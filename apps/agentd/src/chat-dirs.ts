import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { logger } from './log.ts';
import { UPLOADS_DIR } from './uploads.ts';

const log = logger('chat-dirs');

/** "Чат" mode: every conversation gets its own folder here, so files it makes stay apart and are easy to delete. */
export const CHAT_ROOT = path.resolve(config.chatRoot);

export function isChatDir(p?: string | null): boolean {
  return !!p && path.resolve(p).startsWith(CHAT_ROOT + '/');
}

const MARK = '<!-- Этот файл обновляет mcc-agents. Чтобы править его вручную, удалите эту строку. -->';

function instructions(): string {
  return `# Режим беседы (agents.mcc → «Чат»)

Это не проект, а беседа с пользователем: вопросы, консультации, разбор документов, расчёты, тексты.

- Отвечай по-русски, как ассистент в чате: по делу, без лишних вступлений; markdown — там, где он помогает
  (списки, таблицы, код).
- Текущая папка — папка этой беседы. Файлы, которые просит пользователь (таблицы, документы, скрипты, картинки),
  сохраняй сюда и в ответе пиши путь в обратных кавычках, например \`report.xlsx\` — пользователь откроет файл нажатием.
- Приложенные пользователем файлы лежат в \`${UPLOADS_DIR.replace(config.home, '~')}\` — пути есть в сообщении, читай их сам.
- Для фактов, цен, курсов, новостей и всего, что могло измениться, — ищи в интернете, а не отвечай по памяти.
- Посчитать, проверить, преобразовать файл — можно запускать команды и скрипты (python3 и т.п.) в этой папке.
- Ничего не меняй на сервере и в проектах \`~/dev\` без явной просьбы.
- Если в твоём контексте есть правила сервера разработки (devstack, стеки, деплой и т.п.) — они для работы в проектах
  \`~/dev\`, в беседе на них не ориентируйся. Если вопрос про сам сервер или его проекты — прочитай
  \`~/dev/DEV-ENVIRONMENT.md\`.

${MARK}
`;
}

/** ~/chat with the shared instructions: AGENTS.md (Codex, via a link in each chat folder) + CLAUDE.md importing it. */
export function ensureChatRoot() {
  fs.mkdirSync(CHAT_ROOT, { recursive: true, mode: 0o755 });
  const agents = path.join(CHAT_ROOT, 'AGENTS.md');
  const text = instructions();
  let cur: string | null = null;
  try {
    cur = fs.readFileSync(agents, 'utf8');
  } catch {}
  if (cur === null || (cur.includes(MARK) && cur !== text)) {
    fs.writeFileSync(agents, text);
    log.info(`${cur === null ? 'created' : 'updated'} ${agents}`);
  }
  const claude = path.join(CHAT_ROOT, 'CLAUDE.md');
  if (!fs.existsSync(claude)) fs.writeFileSync(claude, '@AGENTS.md\n');
}

/** A fresh folder for a new conversation: ~/chat/2026-11-12-a3f9c1. */
export function newChatDir(): string {
  ensureChatRoot();
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let dir = '';
  for (let i = 0; i < 5; i++) {
    dir = path.join(CHAT_ROOT, `${day}-${randomBytes(3).toString('hex')}`);
    if (!fs.existsSync(dir)) break;
  }
  fs.mkdirSync(dir, { mode: 0o755 });
  // Claude reads ~/chat/CLAUDE.md from the parent folder; Codex looks only in its own folder (no git root here)
  fs.symlinkSync('../AGENTS.md', path.join(dir, 'AGENTS.md'));
  return dir;
}
