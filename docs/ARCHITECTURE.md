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

## Уведомления и подтверждения в Telegram

- **Ход закончился**, а чат никто не смотрит (вкладка скрыта / другой чат) — `notify` (бот сервера) со ссылкой на чат.
  Не чаще раза в 20 с на чат. Отключить: `AGENTD_NOTIFY=0`.
- **Агент ждёт ответа** (подтверждение, вопрос, план) и в вебе не ответили за `prefs.telegramDelaySec` (по умолчанию 60 с,
  настройка в окне «Настройки») — сообщение с кнопками от **отдельного бота агентов** (`telegram.ts`, `tg-approvals.ts`):
  - команда / правка / прочее: «Разрешить», «Отклонить» и до двух вариантов из `Approval.options` («до конца сессии», «всегда…»);
  - вопрос с одним выбором — кнопка на каждый вариант; несколько вопросов / мультивыбор / свой ответ — только в вебе;
  - план — «Начать» (и «Начать + принимать правки»); замечания — в вебе;
  - всегда кнопка-ссылка «Открыть чат».
- Ответ в одном месте отражается в другом: решение из веба (`hub.handle('decide')`) и из Telegram (`onCallback`) пишется в
  `TgApprovals.record`, а когда запрос исчезает из `chat.state.approvals` (`Chat.patch` → `sink.approvalRemoved`), сообщение
  редактируется: «✅ Разрешено в вебе / в Telegram», «⛔ Отклонено…», «💬 Ответ…» или «⌛ Неактуально» (ход прерван, процесс закрыт).
  Отправленные сообщения хранятся в `state.json` (`tgMessages`); после рестарта демона они помечаются «неактуально».
- Почему отдельный бот: бот сервера `@serzhb_mcc_bot` использует `ops`, который читает нажатия через `getUpdates` и держит
  смещение в недоступной `serzhb` папке; два читателя одного бота крали бы нажатия друг у друга. Принимаются только нажатия
  из `TELEGRAM_CHAT_ID`. Токен подхватывается без рестарта (проверка раз в минуту).
- Без токена бота агентов — прежнее поведение: сразу `notify` «нужно подтверждение», если чат никто не смотрит.

## Вход, тема, ширина панелей

- Вход — общий для сайтов `*.mcc` сервис `mcc-auth` (nginx `auth_request`, cookie `mcc_session`). Демон и Next о нём не знают;
  веб при 401 от `/api` (или когда WebSocket не поднимается и `/api/health` → 401) уводит на `https://auth.mcc.babochkin.com/login?rd=…`
  (`lib/auth.ts`). Туннель `local.sock` — без входа.
- Тема — cookie `theme` (`light` по умолчанию / `dark`, домен `.mcc.babochkin.com`): `app/layout.tsx` читает её на сервере и
  ставит класс `dark` на `<html>` — без мигания; переключение — `lib/theme.ts`.
- Ширина панелей — `components/resize-handle.tsx`: перетаскивание меняет CSS-переменные `--sidebar-w` (220–480 px) и
  `--panel-w` (320 px – 70% экрана) на `<html>`, значение — в cookie `mcc_sidebar_w` / `mcc_panel_w` (layout ставит их при
  рендере). Двойной клик — по умолчанию. На телефоне панели — выезжающие Sheet, ширина не меняется.
- Просмотр файлов — `components/code-view.tsx`: Shiki (`github-light`/`github-dark` через CSS-переменные, языки грузятся
  по требованию, файлы > 300 КБ без подсветки), номера строк, перенос строк (кнопка в шапке панели, `localStorage.panelWrap`;
  тот же переключатель — для diff в панели «Изменения»).

## Приложение на экране «Домой» (iOS)

- `appleWebApp.statusBarStyle: 'black-translucent'` (`app/layout.tsx`): страница идёт под строку статуса, `env(safe-area-inset-top)` =
  настоящий отступ (62 pt на iPhone 17 Pro), шапки (`.pt-safe`) опускаются под строку статуса. Со стилем `default` отступ был 0, а
  в iOS 26 у верхнего края приложения рисуется размытие Liquid Glass — заголовок шапки попадал под него.
- В этом режиме iOS 26 отдаёт `innerHeight` / `visualViewport` / `100dvh` на высоту строки статуса меньше экрана (812 из 874 pt),
  а `100lvh` — верно. `hooks/use-app-viewport.ts` добавляет разницу к `--app-h` (только без клавиатуры: с клавиатурой
  visualViewport уже считается от верха экрана); выезжающие панели и подложки диалогов растягиваются по `--app-h` (`globals.css`).
  При открытой клавиатуре `.pb-safe` не добавляет отступ полоски «Домой».
- Иконки: `app/icon.tsx`, `app/apple-icon.tsx` (квадрат без скругления — iOS скругляет сам), `app/app-icon/[variant]` —
  192, 512 и `maskable` (с безопасной зоной) для manifest; рисунок — `lib/app-icon.tsx`. Иконки и manifest открыты без входа (nginx).
- **Размытие верха (iOS 26/27, только на реальном устройстве):** система размывает верхний край веб-приложения на экране
  «Домой» (Liquid Glass scroll edge effect, зона ~строка статуса + 36 pt). Выключателя у веба нет; обходы стоят ~36 pt экрана
  (сплошная полоса на всю зону, шапка ниже), пробовали — выглядит хуже. Решение пользователя: оставить вёрстку как есть,
  а на телефоне включить «Универсальный доступ → Дисплей и размер текста → Понижение прозрачности» — размытие пропадает.
- В приложении нет адресной строки — «Обновить» есть в меню чата и в подвале сайдбара.
- `?debug=1` — оверлей с размерами viewport и safe area (`components/debug-overlay.tsx`) для отладки на телефоне.
- После смены иконки/manifest приложение на экране «Домой» нужно удалить и добавить заново: iOS кэширует их при добавлении.
