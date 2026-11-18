#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Запустите через sudo из SSH после завершения задач панели.' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
runtime=/home/klemid/.local/share/mcc-klemid/agents
node_dir=/home/klemid/.local/share/node/node-v24.22.3-linux-x64/bin
export PATH="$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
for command in runuser node npm curl tar cp chown systemctl mktemp mkdir mv; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done
check_idle() {
  curl --fail --silent --show-error --max-time 5 --unix-socket /run/mcc-agents/local.sock http://localhost/api/health |
    node -e 'let raw="";for await (const chunk of process.stdin) raw+=chunk;const h=JSON.parse(raw);if(h.ok!==true||h.busy!==0){console.error("Сначала завершите все задачи панели. busy=",h.busy);process.exit(1)}'
}
check_idle
echo 'План: проверки, отдельная сборка, резервирование, повторная проверка busy, обновление runtime и перезапуск agentd/web.'
cd "$source_dir"
runuser -u klemid -- env PATH="$PATH" npm run typecheck
runuser -u klemid -- env PATH="$PATH" node scripts/chat-management-test.mjs
release=$(mktemp -d /home/klemid/.local/share/mcc-chat-management-web.XXXXXXXX)
mkdir -p "$release/apps/web" "$release/packages"
tar -C apps/web --exclude=.next --exclude=node_modules -cf - . | tar -C "$release/apps/web" -xf -
cp -a packages/protocol "$release/packages/"
cp package.json package-lock.json "$release/"
cp -a --reflink=auto node_modules "$release/node_modules"
chown -R klemid:klemid "$release"
runuser -u klemid -- env PATH="$PATH" NEXT_TELEMETRY_DISABLED=1 npm --prefix "$release" run build:web
check_idle
backup=$(mktemp -d /var/backups/mcc-chat-management.XXXXXXXX)
cp -a "$runtime/apps/agentd/src/hub.ts" "$backup/hub.ts"
cp -a "$runtime/apps/agentd/src/store.ts" "$backup/store.ts"
cp -a "$runtime/packages/protocol/src/index.ts" "$backup/protocol.ts"
cp -a /home/klemid/.local/share/mcc-agents/state.json "$backup/state.json"
printf 'Резервная копия: %s\n' "$backup"
check_idle
systemctl stop mcc-agentd
rollback() {
  trap - ERR
  systemctl stop mcc-agentd mcc-agents-web || true
  cp -a "$backup/hub.ts" "$runtime/apps/agentd/src/hub.ts"
  cp -a "$backup/store.ts" "$runtime/apps/agentd/src/store.ts"
  cp -a "$backup/protocol.ts" "$runtime/packages/protocol/src/index.ts"
  if [[ -d $backup/next ]]; then
    if [[ -d apps/web/.next ]]; then mv apps/web/.next "$backup/failed-next"; fi
    mv "$backup/next" apps/web/.next
  fi
  systemctl start mcc-agentd mcc-agents-web
  echo "Ошибка установки. Runtime и сборка восстановлены из $backup" >&2
}
trap rollback ERR
cp apps/agentd/src/hub.ts apps/agentd/src/store.ts "$runtime/apps/agentd/src/"
cp packages/protocol/src/index.ts "$runtime/packages/protocol/src/index.ts"
chown klemid:klemid "$runtime/apps/agentd/src/hub.ts" "$runtime/apps/agentd/src/store.ts" "$runtime/packages/protocol/src/index.ts"
systemctl stop mcc-agents-web
if [[ -d apps/web/.next ]]; then mv apps/web/.next "$backup/next"; fi
cp -a "$release/apps/web/.next" apps/web/.next
systemctl start mcc-agentd mcc-agents-web
node --input-type=module <<'JS'
import {execFileSync} from 'node:child_process';
const until=Date.now()+45000;
let last='';
for (;;) {
  try {
    const health=JSON.parse(execFileSync('curl',['--fail','--silent','--show-error','--max-time','3','--unix-socket','/run/mcc-agents/local.sock','http://localhost/api/health'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    if(health.ok!==true) throw new Error('agentd health failed');
    execFileSync('curl',['--fail','--silent','--show-error','--max-time','3','http://127.0.0.1:3110/'],{stdio:'ignore'});
    console.log('agentd и web готовы');break;
  } catch(error) {last=error.message;}
  if(Date.now()>=until) throw new Error(last);
  await new Promise(resolve=>setTimeout(resolve,1000));
}
JS
trap - ERR
echo 'Панель обновлена. Перезагрузите вкладку браузера.'
