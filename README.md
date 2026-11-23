# mcc agents

Личная веб-оболочка над официальными CLI **Claude Code** (`claude`), **Codex** (`codex`) и **Antigravity** (`agy`) на сервере
разработки `mcc`.
Адрес: **https://agents.mcc.babochkin.com**. Вход — общей формой https://auth.mcc.babochkin.com (сервис `mcc-auth` из репозитория
`mcc-server`, cookie на все `*.mcc.babochkin.com`; логин и пароль — прежние, `/etc/nginx/code.htpasswd`).

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
deploy/          systemd-юниты, tmpfiles, сайт nginx (копии того, что лежит на сервере)
scripts/         sync.sh (Mac → сервер) + git-align.sh, deploy.sh (обновление на сервере), e2e.mjs (дымовой тест)
docs/            ARCHITECTURE.md — как устроено, STATUS.md — что готово и что дальше, spike-0.md — проверка протоколов
```

## Разработка

Код пишется где угодно, но **запускается только на сервере** — там залогинены `claude`/`codex`/`agy` и лежат сессии.
На Mac `claude`/`codex`/`agy` и Node для этого проекта не запускаем.

```bash
scripts/sync.sh                     # Mac → ~/dev/mcc-agents на сервере (rsync); если там ровно origin/main — git тоже туда (git-align.sh)
scripts/sync.sh --pull              # обратно: файлы, созданные на сервере (package-lock, компоненты shadcn)
ssh serzhb@94.131.82.220 '~/dev/mcc-agents/scripts/deploy.sh --local'   # собрать и перезапустить то, что залито
```

Боевое обновление — через GitHub: коммит → `git push` → на сервере `scripts/deploy.sh` (подтянет `origin/main`,
`npm install` при смене зависимостей, `next build`, перезапуск веба; демон — только если `apps/agentd` или
`packages/protocol` изменились с коммита, с которого он запущен (`.git/mcc-deploy/agentd`), и не при занятых чатах — иначе
`--force`; отложенный перезапуск следующий `deploy.sh` не забудет).

Тест без входа (например, из iOS Simulator на Mac): `ssh -N -L 3119:/run/mcc-agents/local.sock serzhb@94.131.82.220`
→ http://localhost:3119. Сокет `local.sock` доступен только пользователю `serzhb`.

Сквозной тест протокола (на сервере, тратит немного лимита): `node scripts/e2e.mjs /run/mcc-agents/local.sock claude /tmp/agent-spike/proj haiku`
(агент — `claude` / `codex` / `antigravity`; для Antigravity по умолчанию Gemini 3.8 Flash). Тестовый экземпляр демона рядом с
рабочим — см. ARCHITECTURE, раздел Antigravity (`AGENTD_TELEGRAM=0`).

## Сервисы на сервере

| Что | Где |
|---|---|
| `mcc-agentd.service` | демон; сокеты `/run/mcc-agents/agentd.sock` (nginx), `local.sock` (туннель) |
| `mcc-agents-web.service` | Next.js, `127.0.0.1:3110` |
| nginx | `/etc/nginx/sites-available/agents.mcc.babochkin.com` |
| данные оболочки | `~/.local/share/mcc-agents/state.json` (закрепления, названия, настройки чатов, лимиты, настройки Telegram, отправленные сообщения), `uploads/` |
| бот Telegram агентов | `~/secrets/agents-telegram.env` (`secret-set agents-telegram TELEGRAM_BOT_TOKEN`; чат — из `telegram.env`) |
| логи | `journalctl -u mcc-agentd -u mcc-agents-web` |

Подробно — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), текущее состояние — [docs/STATUS.md](docs/STATUS.md).
