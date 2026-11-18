# Инструкции для агентов (mcc agents)

Веб-оболочка над CLI `claude` и `codex`. Сначала прочитай [README.md](README.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
и [docs/STATUS.md](docs/STATUS.md).

## Правила

- **Документация — часть задачи.** Изменил поведение, протокол, деплой, добавил функцию — в той же задаче обнови
  `docs/ARCHITECTURE.md` и `docs/STATUS.md` (раздел «Готово» / «Дальше» / «Известные проблемы»). README — если меняется запуск.
- **Без SDK.** Работаем только с официальными CLI в их штатных режимах (`claude -p` stream-json + control-протокол,
  `codex app-server`). Не читать и не использовать OAuth-токены CLI, не проксировать запросы к API, не логиниться за пользователя.
- **CLI запускаются только на сервере** `mcc`. На Mac `claude`/`codex`/Node для этого проекта не запускать.
- **Мобильная версия обязательна.** Любую правку интерфейса проверяй на ширине телефона (375–402 px) и в iOS Simulator
  (через туннель `local.sock`, см. README): ничего не вылезает по ширине, кнопки ≥ 40 px, поле ввода над клавиатурой,
  шрифт полей ≥ 16 px, ничего не работает только по наведению.
- **Демон не перезапускать посреди чужой работы**: рестарт `mcc-agentd` обрывает задачи агентов во всех чатах.
  Используй `scripts/deploy.sh` (он проверяет `/api/health` → `busy`). Если ты сам агент, запущенный из этой оболочки, —
  ты дочерний процесс `mcc-agentd`, и его рестарт убьёт тебя: делай отложенно (`sudo systemd-run --on-active=30s systemctl restart mcc-agentd`) и предупреди пользователя.
- nginx — только `sudo nginx -t && sudo systemctl reload nginx`.
- Изменения на сервере (юниты, nginx, tmpfiles) — копии в `deploy/` этого репозитория **и** запись в журнал
  `~/dev/mcc/mcc-server/SERVER.md` + копии в `~/dev/mcc/mcc-server/server/` (правила репозитория `mcc-server`).
- Секреты в репозиторий не писать.
- Коммиты и push в этот репозиторий агенты делают сами, сообщения — коротко по-русски или conventional.

## Код

- `apps/agentd`: TypeScript, который Node 24 исполняет напрямую (type stripping) — только «стираемый» синтаксис:
  без `enum`, без parameter properties, импорты с расширением `.ts`, типы через `import type`.
  Проверка: `npx tsc -p apps/agentd --noEmit`.
- `apps/web`: Next.js App Router, shadcn/ui (`radix-vega`, neutral), Tailwind 4. Почти всё — клиентские компоненты;
  состояние — `src/lib/store.ts` (WebSocket + useSyncExternalStore). Селекторы `useStore` должны возвращать стабильные
  ссылки (срез состояния), производные данные — через `useMemo`.
- Протокол меняешь — правь `packages/protocol/src/index.ts` и обе стороны.
