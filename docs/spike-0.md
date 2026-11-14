# Оболочка для claude / codex — этап 0: проверка протоколов

Дата: 2026-11-12. Сервер `mcc`, `claude` 2.1.319, `codex-cli` 0.167.0, оба залогинены пользователем
(Claude — подписка claude.ai, Codex — ChatGPT). Тесты — в `/tmp/agent-spike/proj` на дешёвых моделях.
Сырые логи событий — на сервере в `/tmp/agent-spike/logs/*.jsonl` (не в git: там email и id аккаунтов).

**Итог: оба CLI дают всё нужное без SDK и без обходных путей. Блокеров нет.**

## Claude: `claude -p` в режиме stream-json

Запуск (одна команда на активный чат, процесс живёт в демоне):

```
CLAUDE_CODE_ENTRYPOINT=mcc-agents claude -p \
  --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --model <model> --effort <level> --permission-mode <mode> \
  (--session-id <uuid> | --resume <uuid>)
```

stdin — JSON-строки: `{"type":"user","message":{"role":"user","content":...}}` и
`{"type":"control_request","request_id":…,"request":{"subtype":…}}`. stdout — события.

| Что нужно оболочке | Как сделано в CLI | Проверено |
|---|---|---|
| Начать / продолжить сессию | `--session-id` / `--resume`; первым — `control_request initialize` | ✅ |
| Список слэш-команд, skills, агентов, моделей, output styles, тип подписки | ответ на `initialize` (`commands`, `agents`, `models` с уровнями effort, `account.subscriptionType`) + `system/init` (`slash_commands`, `skills`, `mcp_servers`, `tools`) | ✅ 66 команд |
| Потоковый текст | `stream_event` (`content_block_*`, дельты) + итоговые `assistant` | ✅ |
| Карточки инструментов | `assistant.tool_use` → `user.tool_result` + `tool_use_result` (структурно: для Write/Edit — путь, патч) | ✅ |
| Подтверждения | `control_request can_use_tool` (tool_name, input, `permission_suggestions`: «разрешить на сессию», «добавить правило») → ответ `allow` (+`updatedInput`) / `deny` (+message) | ✅ allow и deny |
| Интерактивные инструменты | с `--permission-prompt-tool stdio` модели доступны `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` (идут через тот же `can_use_tool`) | ✅ появились |
| Смена модели в чате | `control_request set_model` (в истории пишется как `/model`) | ✅ haiku → sonnet |
| Effort | `--effort` при запуске; на лету — `apply_flag_settings {effortLevel}` | ✅ принят |
| Режим разрешений | `--permission-mode` (`manual`, `acceptEdits`, `plan`, `auto`, `bypassPermissions`, `dontAsk`); на лету — `set_permission_mode` | флаг ✅ |
| Прервать (Esc) | `control_request interrupt` → `result` с `terminal_reason: aborted_streaming` | ✅ |
| Очередь сообщений во время работы | просто писать в stdin — выполняются по порядку | ✅ |
| Контекст | `get_context_usage` → те же категории, что `/context` (system prompt, tools, memory, skills, messages, free), `percentage`, `autoCompactThreshold`; плюс `usage` в каждом `assistant`/`result`, `modelUsage.contextWindow` | ✅ |
| Лимиты подписки | `rate_limit_event` после каждого запроса: `five_hour` и `seven_day` (`utilization`, `resetsAt`, `status`) | ✅ 5% / 2% |
| Фоновые задачи | `system task_started` / `task_updated` / `task_notification` / `background_tasks_changed`; у задачи `output_file` (можно читать вживую); остановка — `control_request stop_task`; по завершении задачи агент сам начинает ход | ✅ |
| Мысли (thinking) | блоки `thinking` приходят, но у haiku/sonnet текст пустой (только подпись) + `system thinking_tokens` (оценка токенов). В сессиях CloudCLI (Opus) часть блоков с текстом. В UI: показываем текст, если есть, иначе «думал ~N токенов» | ⚠️ частично |
| Ещё в протоколе (не проверял) | `rewind_files`, `rename_session`, `mcp_status`/`mcp_toggle`, `list_models`, `get_plan`, `end_session`, `compact_boundary`, `prompt_suggestion`, `api_retry` | — |

### Общие сессии с терминалом

- История — тот же файл `~/.claude/projects/<путь>/<id>.jsonl`. `claude --resume <id>` в терминале
  открывает веб-чат полностью (проверено: видны команды, `/model`, отказы).
- ⚠️ По умолчанию `-p` помечает сессию `entrypoint: sdk-cli`, и **терминальный список `claude --resume`
  такие скрывает** (в CLI зашито: скрыты `sdk-cli`, `sdk-ts`, `sdk-py`).
  **Решение:** запускать с `CLAUDE_CODE_ENTRYPOINT=mcc-agents` — это штатная переменная, которой
  представляются клиенты (CloudCLI пишет `claudecodeui`). Проверено: сессия появляется в списке
  `claude --resume` в терминале. Заодно по этой метке видно, какие чаты созданы из веба.
- Обратное направление: оболочка читает все `.jsonl` из `~/.claude/projects` и показывает чаты из терминала.
- Одну сессию нельзя одновременно вести из двух мест — оболочка будет предупреждать, если по
  сессии уже идёт процесс `claude` (не наш).

### Важное для архитектуры

- **Процесс `claude` должен жить в демоне, пока идёт работа.** Фоновая задача живёт внутри процесса:
  после выхода процесса она теряется (при `--resume` CLI пишет «didn't finish before the previous session
  ended»). Пока есть фоновые задачи, процесс не завершается даже при закрытом stdin.
- Простой процесс `claude -p` занимает **~200 МБ RAM**. Политика: держать процесс у активных чатов;
  после N минут простоя без фоновых задач — закрывать, при новом сообщении — `--resume` (история и кэш на месте).
- Режим `--bare` не подходит: он не читает OAuth (только API-ключ). Нужен обычный режим — тогда
  подхватываются `~/.claude/CLAUDE.md`, skills, плагины, MCP, хуки — как в терминале.

## Codex: `codex app-server` (JSON-RPC по stdio)

Официальный протокол (на нём расширение VS Code). Типы генерируются самим CLI:
`codex app-server generate-ts --out <dir>` (97 + 665 файлов) — берём в `packages/protocol` прямо так.
**Один процесс app-server обслуживает все треды** (~230 МБ на всё), не по процессу на чат.

| Что нужно оболочке | Метод / событие | Проверено |
|---|---|---|
| Инициализация | `initialize {clientInfo}` → `initialized` | ✅ |
| Аккаунт, тариф | `account/read` | ✅ |
| Лимиты | `account/rateLimits/read` + push `account/rateLimits/updated` после каждого запроса (`usedPercent`, окно в минутах, `resetsAt`; у этого тарифа одно недельное окно) | ✅ 14→15% |
| Модели | `model/list`; на ход — `turn/start {model, effort, summary}` | ✅ |
| Новый / продолжить тред | `thread/start {cwd, approvalPolicy, sandbox}` / `thread/resume {threadId}` + `thread/turns/list`, `thread/items/list` | ✅ в новом процессе помнит контекст |
| Список чатов | `thread/list` (курсор, сортировка) | ✅ |
| Сообщение | `turn/start {threadId, input:[text/localImage/mention/skill]}`; в идущий ход — `turn/steer` | start ✅ |
| Поток | `item/started` / `item/completed` (типы: `userMessage`, `agentMessage`, `commandExecution` с `aggregatedOutput`/`exitCode`, `fileChange` с diff, `reasoning`, MCP), дельты `item/agentMessage/delta`, `item/commandExecution/outputDelta` | ✅ |
| Подтверждения | серверные запросы `item/commandExecution/requestApproval` (команда, cwd, `commandActions`, предложенное правило) и `item/fileChange/requestApproval` → `accept` / `acceptForSession` / `decline` / `cancel`; статус треда `waitingOnApproval` | ✅ accept и decline |
| Прервать | `turn/interrupt {threadId, turnId}` → `turn/completed status: interrupted` | ✅ |
| Diff хода | `turn/diff/updated` (готовый unified diff) | ✅ |
| План (todo) | `turn/plan/updated` | — |
| Контекст | `thread/tokenUsage/updated` (`total`, `last`, `modelContextWindow`) | ✅ |
| Ещё | `thread/fork`, `thread/compact/start`, `thread/name/set`, `thread/archive`, `review/start`, `fuzzyFileSearch`, `skills/list`, `command/exec` | — |

- **Подтверждения работают по-настоящему.** `approvalPolicy: "untrusted"` спрашивает про каждую
  команду, кроме безопасных; `on-request` — модель решает сама; `never` — без вопросов. Песочница
  остаётся `danger-full-access` (bwrap на сервере не работает — см. SERVER.md). В CloudCLI для Codex
  работал только Bypass — здесь этой проблемы нет.
- **Общие сессии с терминалом:** тред пишется в `~/.codex/sessions/…/rollout-…-<id>.jsonl` с
  `source: vscode` и **виден в терминальном `codex resume`** (проверено). В обратную сторону — `thread/list`.

## Что это значит для плана

1. Схема из плана подтверждается: `apps/agentd` (Node-демон, держит процессы, WebSocket) +
   `apps/web` (Next.js + shadcn) + `packages/protocol` (общий формат событий, типы Codex — сгенерированные).
2. Адаптер Claude: процесс на чат, stream-json + control-протокол, `CLAUDE_CODE_ENTRYPOINT=mcc-agents`,
   закрытие простаивающих процессов. Адаптер Codex: один app-server, JSON-RPC.
3. Всё из списка интерфейса (карточки, подтверждения, фон, контекст, лимиты, модели/effort/режимы,
   слэш-команды, прерывание, очередь, общие сессии) реализуемо штатными средствами CLI.
4. Открытые мелочи: текст thinking у Claude (показываем, что есть); вложения-картинки (у обоих
   есть в протоколе, проверим на этапе 2).

Драйверы, которыми проверял, — [`scripts/spike/`](../scripts/spike/) (`cdrive.py` — Claude, `xdrive.py` — Codex).

## Мусор после теста

- `/tmp/agent-spike/` на сервере — драйверы, логи, сгенерированные типы.
- Тестовые сессии: `~/.claude/projects/-tmp-agent-spike-proj/` (3 шт.) и один тред Codex
  (`~/.codex/sessions/2026/11/12/rollout-…-01a1ce76-….jsonl`, виден в `codex resume` → All).
