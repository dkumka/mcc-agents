# Архитектура mcc agents

```
браузер (телефон / Mac)
   │ https://agents.mcc.babochkin.com  (nginx, basic auth code.htpasswd)
   ├── /            → 127.0.0.1:3110  mcc-agents-web   (Next.js: только интерфейс, без состояния)
   └── /api/*, /ws  → unix:/run/mcc-agents/agentd.sock  mcc-agentd
                                   │
                                   ├── claude -p --input-format stream-json … (процесс на активный чат)
                                   └── codex app-server (один на все треды, JSON-RPC по stdio)
```

Почему демон отдельно от Next: процессы агентов должны жить, пока идёт работа (фоновая задача Claude живёт внутри
процесса `claude` и пропадает с ним). Next можно пересобирать и перезапускать сколько угодно — чаты не прерываются.

## agentd (`apps/agentd/src`)

| Файл | Что делает |
|---|---|
| `index.ts` | запуск: store, hub, адаптеры, сервер, периодический `refresh` (10 с) и `sweep` (60 с) |
| `config.ts` | пути, сокеты, таймауты (переменные `AGENTD_*`) |
| `server.ts` | HTTP API + WebSocket (`ws`). Два сокета: `agentd.sock` (nginx, 660 codeweb) и `local.sock` (600, для `ssh -L`; ещё и проксирует всё прочее в Next). Проверка Origin = Host для WS |
| `hub.ts` | список всех чатов (обоих агентов), подписки браузеров, создание чатов, уведомления, `projects()` |
| `chat.ts` | состояние одного чата: нормализованные элементы + live-состояние; рассылка изменений, батчинг дельт (40 мс), усечение больших выводов на проводе |
| `store.ts` | `~/.local/share/mcc-agents/state.json`: закрепления, свои названия, настройки чатов, lastSeen, лимиты, окна контекста моделей |
| `tools.ts` | классификация инструментов Claude (Bash/Edit/Read/…) → категория, заголовок, diff |
| `fsapi.ts` | файлы, дерево, поиск файлов для `@` (`rg --files`), `git status/diff` |
| `claude/sessions.ts` | инкрементальный скан `~/.claude/projects/*/*.jsonl` (чтение с последнего смещения), загрузка истории |
| `claude/normalize.ts` | строки транскрипта / события stream-json → `ChatItem` (общий код для истории и live) |
| `claude/index.ts` | `ClaudeProc` (процесс на чат) и `ClaudeAdapter` |
| `codex/rpc.ts` | клиент `codex app-server` (JSON-RPC, автоперезапуск) |
| `codex/index.ts` | `CodexAdapter`: треды, история (`thread/turns/list`, itemsView full), события, подтверждения |

### Claude

- Запуск: `CLAUDE_CODE_ENTRYPOINT=mcc-agents claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-prompt-tool stdio --allow-dangerously-skip-permissions (--session-id|--resume) <id>
  [--model] [--effort] [--permission-mode]`.
  - `CLAUDE_CODE_ENTRYPOINT=mcc-agents` — иначе `-p` помечает сессию `sdk-cli`, и терминальный `claude --resume` её скрывает.
  - `--permission-prompt-tool stdio` — запросы разрешений приходят как `control_request can_use_tool`; ответ `allow`
    (+`updatedInput`, +`updatedPermissions` из `permission_suggestions`) / `deny`. Так же идут `AskUserQuestion`
    (ответы в `updatedInput.answers`) и `ExitPlanMode`.
- Control-запросы демона: `initialize`, `interrupt`, `set_model`, `set_permission_mode`, `apply_flag_settings {effortLevel}`,
  `get_context_usage` (после каждого хода — точный % контекста), `stop_task`.
- События: `stream_event` (дельты текста/мыслей), `assistant`/`user` (блоки, результаты инструментов, `tool_use_result`
  со `structuredPatch` для diff), `system` (`init`, `status`, `task_*`, `compact_boundary`, `api_retry`, `session_title_changed`,
  `thinking_tokens`), `result`, `rate_limit_event` (окна `five_hour`, `seven_day…`).
- Очередь: сообщения во время работы просто пишутся в stdin — CLI выполняет их по порядку (каждое даёт свой `result`).
- Простаивающий процесс (`AGENTD_CLAUDE_IDLE_MS`, 20 мин) закрывается, если нет хода, подтверждений и фоновых задач;
  следующее сообщение поднимает его через `--resume`.
- Перед `--resume` проверяется `/proc`: если сессию держит другой `claude` (терминал), чат не запускается и показывается
  баннер — две программы в одной сессии испортили бы историю.
- Возможности (модели, слэш-команды, skills, режим по умолчанию, тариф) — короткий `claude -p` только с `initialize`
  (без запроса к API), кэш 10 мин на папку.

### Codex

- Один `codex app-server`; при открытии чата — `thread/resume` (подписка на события) + `thread/turns/list`.
  Новый чат — `thread/start {cwd, model, approvalPolicy, sandbox: danger-full-access}`, сообщение — `turn/start`
  (модель, effort, approvalPolicy на каждый ход), во время хода — `turn/steer`.
- Подтверждения: серверные запросы `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`, `item/permissions/requestApproval`. Режимы: `untrusted` (спрашивать), `on-request`, `never`.
- События: `item/started|completed`, дельты (`agentMessage`, `reasoning`, `commandExecution/outputDelta`),
  `turn/plan/updated` (→ список задач), `thread/tokenUsage/updated` (контекст), `account/rateLimits/updated` (лимиты).
- `clientUserMessageId` = наш id сообщения → своё сообщение не дублируется.
- `/compact` → `thread/compact/start`. Картинки → `uploads/<uuid>.<ext>` → `localImage`.

## Протокол (`packages/protocol`)

Всё, что видит интерфейс, — `ChatItem`: `user`, `assistant`, `thinking`, `tool` (категория, заголовок, ввод, вывод,
статус, diff, `parentId` для субагентов), `notice`. Плюс live-состояние чата: `approvals`, `usage`, `tasks`, `todos`,
`settings`, `live`, `busyElsewhere`, `error`.

WebSocket `/ws`: клиент → `subscribe/unsubscribe/visible/create/send/interrupt/decide/settings/stopTask/meta/seen/release`;
сервер → `chats/chat/chatRemoved/limits/snapshot/item/delta/state/created/error`.

HTTP `/api`: `health`, `projects`, `caps?agent&cwd`, `files?cwd&q`, `ls?path`, `file?path`, `git?cwd`,
`output?chatId&itemId` (полный вывод усечённого инструмента), `task-output?chatId&taskId`. Пути — только внутри `$HOME` и `/tmp`.

## Веб (`apps/web/src`)

- `lib/store.ts` — WebSocket с переподключением (и «пробуждением» после сна телефона), состояние, маршрут (`?chat=`, `?new=1&cwd=&agent=`), дельты сливаются раз в кадр.
- `components/app.tsx` — каркас: shadcn `Sidebar` (на телефоне — выезжающий Sheet), чат, правая панель (на телефоне — Sheet на весь экран).
- `components/chat/*` — `chat-view` (шапка, баннеры), `message-list` (автопрокрутка, дерево субагентов), `items` (карточки
  инструментов), `approval-panel`, `composer` (`/` команды, `@` файлы, картинки, модель/усилие/режим, Esc — стоп),
  `todo-bar`, `status-bar` (контекст, лимиты, фоновые задачи), `new-chat`.
- `components/panel/side-panel.tsx` — изменения git, файлы, фоновые задачи (вывод обновляется раз в 2 с).
- `hooks/use-app-viewport.ts` — высота приложения = visualViewport (iOS: поле ввода над клавиатурой).

## Уведомления

Когда ход закончился или нужно подтверждение, а чат никто не смотрит (вкладка скрыта / другой чат) — `notify` (Telegram)
со ссылкой на чат. Не чаще раза в 20 с на чат. Отключить: `AGENTD_NOTIFY=0`.
