#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Запустите через sudo из SSH.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
node_dir=/home/klemid/.local/share/node/node-v24.22.3-linux-x64/bin
export PATH="$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in runuser npm node tar cp chown systemctl curl mktemp mkdir mv; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done
echo 'План: отдельная сборка веба → резервирование → замена сборки → перезапуск mcc-agents-web → проверка готовности.'
release=$(mktemp -d /home/klemid/.local/share/mcc-web-release.XXXXXXXX)
mkdir -p "$release/apps/web" "$release/packages"
tar -C "$source_dir/apps/web" --exclude=.next --exclude=node_modules -cf - . | tar -C "$release/apps/web" -xf -
cp -a "$source_dir/packages/protocol" "$release/packages/"
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$release/"
cp -a --reflink=auto "$source_dir/node_modules" "$release/node_modules"
chown -R klemid:klemid "$release"
runuser -u klemid -- env PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 npm --prefix "$release" run build:web
backup=$(mktemp -d /var/backups/mcc-web.XXXXXXXX)
printf 'Резервная копия: %s\n' "$backup"
rollback() {
  trap - ERR
  journalctl -u mcc-agents-web --since '-2 minutes' --no-pager > "$backup/failure.log" 2>&1 || true
  systemctl stop mcc-agents-web
  if [[ -d $backup/next ]]; then
    if [[ -d $source_dir/apps/web/.next ]]; then mv "$source_dir/apps/web/.next" "$backup/failed-next"; fi
    mv "$backup/next" "$source_dir/apps/web/.next"
  fi
  systemctl start mcc-agents-web
  echo "Сборка восстановлена. Диагностика: $backup/failure.log" >&2
}
trap rollback ERR
systemctl stop mcc-agents-web
if [[ -d $source_dir/apps/web/.next ]]; then mv "$source_dir/apps/web/.next" "$backup/next"; fi
cp -a "$release/apps/web/.next" "$source_dir/apps/web/.next"
systemctl start mcc-agents-web
ready=0
for attempt in {1..45}; do
  if curl --fail --silent --show-error --max-time 3 http://127.0.0.1:3110/ > /dev/null 2> "$backup/readiness.log"; then
    ready=1
    break
  fi
  sleep 1
done
[[ $ready == 1 ]]
trap - ERR
echo 'Веб-интерфейс обновлён. Перезагрузите вкладку браузера.'
