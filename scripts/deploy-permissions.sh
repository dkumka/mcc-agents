#!/usr/bin/env bash
# Run through SSH after active panel tasks have finished.
set -euo pipefail
# Non-interactive SSH shells do not load nvm or the interactive shell's PATH.
# Use the same Node installation as the deployed systemd services.
node_bin="$HOME/.local/share/node/node-v24.22.3-linux-x64/bin"
if [[ -x "$node_bin/node" ]]; then
  export PATH="$node_bin:$PATH"
fi
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Не найдены node/npm. Ожидается Node.js 24 в ~/.local/share/node/node-v24.22.3-linux-x64/bin.' >&2
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Для развёртывания требуется Node.js 24 или новее.' >&2
  exit 1
fi
if [[ -z ${SSH_CONNECTION:-} ]]; then
  echo 'Запустите через SSH после окончания задач панели.' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
runtime=/home/klemid/.local/share/mcc-klemid/agents
check_idle() {
  local health
  health=$(curl --fail --silent --show-error --unix-socket /run/mcc-agents/local.sock http://localhost/api/health)
  node -e 'const h=JSON.parse(process.argv[1]); if(h.ok!==true || h.busy!==0) { console.error("Демон занят или health не подтверждён:", h.busy); process.exit(1); }' "$health"
}
check_idle
echo 'План: резервная копия → проверки и сборка → повторная проверка busy → копирование адаптеров → перезапуск agentd и web.'
backup="$runtime/../backups/permissions-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup/codex" "$backup/claude"
cp "$runtime/apps/agentd/src/codex/index.ts" "$backup/codex/index.ts"
cp "$runtime/apps/agentd/src/claude/index.ts" "$backup/claude/index.ts"
if [[ -f "$runtime/apps/agentd/src/codex/permissions.ts" ]]; then
  cp "$runtime/apps/agentd/src/codex/permissions.ts" "$backup/codex/permissions.ts"
fi
if [[ -d apps/web/.next ]]; then cp -a apps/web/.next "$backup/web-next"; fi
echo "Резервная копия: $backup"
npm run typecheck
node scripts/permissions-test.mjs
if ! npm run build:web; then
  if [[ -d "$backup/web-next" ]]; then
    mv apps/web/.next "$backup/failed-web-next"
    cp -a "$backup/web-next" apps/web/.next
  fi
  echo 'Сборка не прошла, службы не перезапускались.' >&2
  exit 1
fi
check_idle
# The adapters also depend on task-prompt.ts from the preceding panel task.
if ! cmp -s apps/agentd/src/task-prompt.ts "$runtime/apps/agentd/src/task-prompt.ts"; then
  echo 'task-prompt.ts отличается от развёрнутого: сначала согласуйте отдельную правку.' >&2
  exit 1
fi
cp apps/agentd/src/codex/index.ts apps/agentd/src/codex/permissions.ts "$runtime/apps/agentd/src/codex/"
cp apps/agentd/src/claude/index.ts "$runtime/apps/agentd/src/claude/"
check_idle
sudo systemctl restart mcc-agentd
sudo systemctl restart mcc-agents-web
systemctl is-active mcc-agentd mcc-agents-web
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 --unix-socket /run/mcc-agents/local.sock http://localhost/api/health
echo
echo 'Обновите панель; кнопка со щитом → Полный доступ. Проверьте оба агента.'
