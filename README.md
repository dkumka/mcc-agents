# mcc agents

Личная веб-оболочка над официальными CLI **Claude Code** (`claude`), **Codex** (`codex`) и **Antigravity** (`agy`, на этом сервере пока не установлен) на сервере разработки `mcc`.
Адрес: **https://agents.mcc.example.com**. Вход — общей формой https://auth.mcc.example.com (сервис `mcc-auth` из репозитория
`mcc-server`, cookie на все `*.mcc.example.com`; логин и пароль — прежние, `/etc/nginx/code.htpasswd`).

- Без SDK: запускаются сами CLI в их штатных режимах — `claude -p` (stream-json + control-протокол), `codex app-server`
  (JSON-RPC) и `agy acp` (Agent Client Protocol). Вход — собственный вход каждого CLI (`claude` / `codex login --device-auth` /
  `agy` по SSH), токены оболочка не трогает.
- Сессии **общие с терминалом**: те же файлы `~/.claude/projects/…`, `~/.codex/sessions/…`, `~/.gemini/antigravity-cli/…`.
  Веб-чаты видны в `claude --resume` / `codex resume` / `agy --conversation <id>`, терминальные — в вебе.
- Интерфейс в духе Claude Code: слева проекты и чаты, по центру чат с карточками инструментов, справа — изменения git,
  файлы, фоновые задачи. Светлая/тёмная тема, нормальная мобильная версия.

## Структура

```
apps/agentd      демон (Node 24, TypeScript без сборки — node запускает .ts напрямую): процессы CLI, API, WebSocket
apps/web         веб-интерфейс (Next.js 16 + shadcn/ui, radix-vega / neutral)
packages/protocol общие типы agentd ⇄ web
deploy/          systemd-юниты и tmpfiles (копии того, что лежит на сервере); nginx для agents.mcc.klemid.ru — общий `mcc-nginx.conf` в репозитории `mcc-server`
scripts/         sync.sh (Mac → сервер) + git-align.sh, deploy.sh (обновление на сервере), e2e.mjs (дымовой тест)
docs/            ARCHITECTURE.md — как устроено, STATUS.md — что готово и что дальше, spike-0.md — проверка протоколов
```

## Разработка

Код правится и запускается прямо на сервере, в `~/dev/mcc/mcc-agents`: там залогинены `claude`/`codex` и лежат сессии.
Веб-интерфейс работает из этой папки, демон — из runtime `~/.local/share/mcc-klemid/agents`.

Выкатка — после коммита и push, из SSH, когда в панели нет активных задач:

```bash
sudo bash ~/dev/mcc/mcc-agents/scripts/deploy-server.sh          # веб и, если менялись agentd/протокол, демон
sudo bash ~/dev/mcc/mcc-agents/scripts/deploy-server.sh --web    # только веб, демон не трогать
```

Скрипт проверяет типы и тесты, собирает веб отдельно от работающего, проверяет `busy`, сохраняет runtime, `.next` и
`state.json` в `/var/backups/mcc-agents-deploy.*`, заменяет и ждёт готовности; при ошибке сам возвращает прежнюю версию.
Новые зависимости он не ставит — тогда нужна отдельная выкатка с `npm ci`.

`scripts/sync.sh`, `git-align.sh`, `deploy.sh` — инструменты `serzhb` для его схемы (Mac → сервер), у нас не используются.

Тест без входа (например, из iOS Simulator на Mac): `ssh -N -L 3119:/run/mcc-agents/local.sock dev@SERVER_IP`
→ http://localhost:3119. Сокет `local.sock` доступен только пользователю `dev`.

Сквозной тест протокола (на сервере, тратит немного лимита): `node scripts/e2e.mjs /run/mcc-agents/local.sock claude /tmp/agent-spike/proj haiku`
(агент — `claude` / `codex` / `antigravity`; для Antigravity по умолчанию Gemini 3.8 Flash). Тестовый экземпляр демона рядом с
рабочим — см. ARCHITECTURE, раздел Antigravity (`AGENTD_TELEGRAM=0`).

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
