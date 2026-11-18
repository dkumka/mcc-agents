#!/usr/bin/env bash
# Выкатка панели на этом сервере: веб из этой папки, демон — в runtime ~/.local/share/mcc-klemid/agents.
# Запуск из SSH, когда в панели нет активных задач:
#   sudo bash ~/dev/mcc/mcc-agents/scripts/deploy-server.sh            # всё, что изменилось
#   sudo bash ~/dev/mcc/mcc-agents/scripts/deploy-server.sh --web      # только веб, демон не трогать
# Перед заменой: проверки, тесты, отдельная сборка веба, резервная копия runtime, .next и state.json.
# При любой ошибке после остановки служб — автоматический откат и перезапуск прежней версии.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Запустите через sudo из SSH: sudo bash ~/dev/mcc/mcc-agents/scripts/deploy-server.sh' >&2; exit 1; }
only_web=0
for a in "$@"; do
  case "$a" in
    --web) only_web=1 ;;
    *) echo "Неизвестный параметр: $a" >&2; exit 2 ;;
  esac
done

source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
runtime=/home/klemid/.local/share/mcc-klemid/agents
state=/home/klemid/.local/share/mcc-agents/state.json
node_dir=/home/klemid/.local/share/node/node-v24.22.3-linux-x64/bin
export PATH="$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in runuser node npm curl tar rsync cp chown systemctl mktemp mv diff; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done
as_user() { runuser -u klemid -- env PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 "$@"; }

health() { curl --fail --silent --show-error --max-time 5 --unix-socket /run/mcc-agents/local.sock http://localhost/api/health; }
check_idle() {
  health | node -e 'let r="";for await (const c of process.stdin) r+=c;const h=JSON.parse(r);if(h.ok!==true||h.busy!==0){console.error(`Сначала завершите задачи панели: busy=${h.busy}`);process.exit(1)}'
}

cd "$source_dir"
[[ -z $(as_user git status --porcelain --untracked-files=no) ]] || { echo 'В репозитории незакоммиченные изменения — сначала закоммитьте.' >&2; exit 1; }
diff -q package-lock.json "$runtime/package-lock.json" >/dev/null || { echo 'Изменились зависимости: этот скрипт их не ставит. Нужна отдельная выкатка с npm ci.' >&2; exit 1; }

agentd=0
if [[ $only_web == 0 ]]; then
  for d in apps/agentd/src packages/protocol/src; do
    diff -rq "$d" "$runtime/$d" >/dev/null || agentd=1
  done
fi
echo "Версия: $(as_user git log -1 --format='%h %s')"
echo "План: проверки → сборка веба отдельно → проверка busy → резервная копия → замена$([[ $agentd == 1 ]] && echo ' демона и') веба → проверка готовности."
[[ $agentd == 1 ]] && check_idle

echo '→ проверка типов и тесты'
as_user npm run typecheck
for t in chat-management-test permissions-test task-prompt-test tg-approvals-test; do
  [[ -f scripts/$t.mjs ]] && as_user node "scripts/$t.mjs" >/dev/null
done

echo '→ сборка веба (отдельно от работающей)'
release=$(mktemp -d /home/klemid/.local/share/mcc-web-release.XXXXXXXX)
mkdir -p "$release/apps/web" "$release/packages"
tar -C apps/web --exclude=.next --exclude=node_modules -cf - . | tar -C "$release/apps/web" -xf -
cp -a packages/protocol "$release/packages/"
cp package.json package-lock.json "$release/"
cp -a --reflink=auto node_modules "$release/node_modules"
chown -R klemid:klemid "$release"
as_user npm --prefix "$release" run build:web

[[ $agentd == 1 ]] && check_idle
backup=$(mktemp -d /var/backups/mcc-agents-deploy.XXXXXXXX)
tar -C "$runtime" -cf "$backup/runtime-src.tar" apps/agentd/src packages/protocol/src
cp -a "$state" "$backup/state.json"
echo "Резервная копия: $backup"

rollback() {
  trap - ERR
  echo 'Ошибка — возвращаю прежнюю версию.' >&2
  journalctl -u mcc-agentd -u mcc-agents-web --since '-5 minutes' --no-pager > "$backup/failure.log" 2>&1 || true
  systemctl stop mcc-agents-web || true
  if [[ $agentd == 1 ]]; then
    systemctl stop mcc-agentd || true
    rm -rf "$runtime/apps/agentd/src" "$runtime/packages/protocol/src"
    tar -C "$runtime" -xf "$backup/runtime-src.tar"
  fi
  if [[ -d $backup/next ]]; then
    [[ -d apps/web/.next ]] && mv apps/web/.next "$backup/failed-next"
    mv "$backup/next" apps/web/.next
  fi
  [[ $agentd == 1 ]] && systemctl start mcc-agentd
  systemctl start mcc-agents-web
  echo "Прежняя версия запущена. Журнал ошибки: $backup/failure.log" >&2
  exit 1
}
trap rollback ERR

if [[ $agentd == 1 ]]; then
  systemctl stop mcc-agentd
  for d in apps/agentd/src packages/protocol/src; do
    rsync -a --delete "$d/" "$runtime/$d/"
  done
  chown -R klemid:klemid "$runtime/apps/agentd/src" "$runtime/packages/protocol/src"
fi
systemctl stop mcc-agents-web
[[ -d apps/web/.next ]] && mv apps/web/.next "$backup/next"
cp -a "$release/apps/web/.next" apps/web/.next
chown -R klemid:klemid apps/web/.next
[[ $agentd == 1 ]] && systemctl start mcc-agentd
systemctl start mcc-agents-web

ready=0
for _ in $(seq 1 45); do
  if health >/dev/null 2>&1 && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:3110/; then ready=1; break; fi
  sleep 1
done
[[ $ready == 1 ]] || false
trap - ERR
rm -rf "$release"
echo "Готово: $([[ $agentd == 1 ]] && echo 'демон и ')веб обновлены. Перезагрузите вкладку панели."
