# mcc agents

Личная веб-оболочка над официальными CLI **Claude Code** (`claude`) и **Codex** (`codex`) на сервере разработки `mcc`.
Адрес: **https://agents.mcc.example.com**. Вход — общей формой https://auth.mcc.example.com (сервис `mcc-auth` из репозитория
`mcc-server`, cookie на все `*.mcc.example.com`; логин и пароль — прежние, `/etc/nginx/code.htpasswd`).

- Без SDK: запускаются сами CLI в их штатных режимах — `claude -p` (stream-json + control-протокол) и `codex app-server` (JSON-RPC).
  Вход — собственный OAuth каждого CLI (`claude` / `codex login --device-auth` по SSH), токены оболочка не трогает.
- Сессии **общие с терминалом**: те же файлы `~/.claude/projects/…` и `~/.codex/sessions/…`. Веб-чаты видны в
  `claude --resume` / `codex resume`, терминальные — в вебе.
- Интерфейс в духе Claude Code: слева проекты и чаты, по центру чат с карточками инструментов, справа — изменения git,
  файлы, фоновые задачи. Светлая/тёмная тема, нормальная мобильная версия.

## Структура

```
apps/agentd      демон (Node 24, TypeScript без сборки — node запускает .ts напрямую): процессы CLI, API, WebSocket
apps/web         веб-интерфейс (Next.js 16 + shadcn/ui, radix-vega / neutral)
packages/protocol общие типы agentd ⇄ web
deploy/          systemd-юниты, tmpfiles, сайт nginx (копии того, что лежит на сервере)
scripts/         sync.sh (Mac → сервер), deploy.sh (обновление на сервере), e2e.mjs (дымовой тест)
docs/            ARCHITECTURE.md — как устроено, STATUS.md — что готово и что дальше, spike-0.md — проверка протоколов
```

## Разработка

Код пишется где угодно, но **запускается только на сервере** — там залогинены `claude`/`codex` и лежат сессии.
На Mac `claude`/`codex` и Node для этого проекта не запускаем.

```bash
scripts/sync.sh                     # Mac → ~/dev/mcc-agents на сервере (rsync, без коммита)
scripts/sync.sh --pull              # обратно: файлы, созданные на сервере (package-lock, компоненты shadcn)
ssh dev@SERVER_IP '~/dev/mcc-agents/scripts/deploy.sh --local'   # собрать и перезапустить то, что залито
```

Боевое обновление — через GitHub: коммит → `git push` → на сервере `scripts/deploy.sh` (подтянет `origin/main`,
`npm install` при смене зависимостей, `next build`, перезапуск веба; демон — только если менялись `apps/agentd` или
`packages/protocol`, и не при занятых чатах — иначе `--force`).

Тест без входа (например, из iOS Simulator на Mac): `ssh -N -L 3119:/run/mcc-agents/local.sock dev@SERVER_IP`
→ http://localhost:3119. Сокет `local.sock` доступен только пользователю `dev`.

Сквозной тест протокола (на сервере, тратит немного лимита): `node scripts/e2e.mjs /run/mcc-agents/local.sock claude /tmp/agent-spike/proj haiku`.

## Сервисы на сервере

| Что | Где |
|---|---|
| `mcc-agentd.service` | демон; сокеты `/run/mcc-agents/agentd.sock` (nginx), `local.sock` (туннель) |
| `mcc-agents-web.service` | Next.js, `127.0.0.1:3110` |
| nginx | `/etc/nginx/sites-available/agents.mcc.example.com` |
| данные оболочки | `~/.local/share/mcc-agents/state.json` (закрепления, названия, настройки чатов, лимиты, настройки Telegram, отправленные сообщения), `uploads/` |
| бот Telegram агентов | `~/secrets/agents-telegram.env` (`secret-set agents-telegram TELEGRAM_BOT_TOKEN`; чат — из `telegram.env`) |
| логи | `journalctl -u mcc-agentd -u mcc-agents-web` |

Подробно — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), текущее состояние — [docs/STATUS.md](docs/STATUS.md).

Обновление управления чатами/архива/статусов после завершения всех задач панели
выполняется из обычного SSH: `sudo bash scripts/deploy-chat-management.sh`.
Установщик проверяет idle, собирает веб отдельно, резервирует runtime и обновляет
обе службы. После установки перезагрузить вкладку панели.

Для публикации только веб-интерфейса из SSH: `sudo bash scripts/deploy-web.sh`.
Скрипт собирает отдельно, сохраняет предыдущую сборку и перезапускает веб-сервис.
