#!/usr/bin/env bash
# Обновить mcc agents НА СЕРВЕРЕ: git → npm install → next build → перезапуск веб-интерфейса.
#   scripts/deploy.sh            — подтянуть origin/main, собрать и перезапустить веб (безопасно)
#   scripts/deploy.sh --local    — собрать то, что лежит в папке сейчас (после scripts/sync.sh с Mac), без git
#   scripts/deploy.sh --agentd   — плюс перезапустить демон. Демон перезапускается и сам, если менялись
#                                  apps/agentd или packages/protocol. Перезапуск ОБРЫВАЕТ идущие задачи агентов,
#                                  поэтому при занятых чатах скрипт откажется без --force.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.npm-global/bin:$PATH" NEXT_TELEMETRY_DISABLED=1

LOCAL=0 AGENTD=0 FORCE=0
for a in "$@"; do
  case "$a" in
    --local) LOCAL=1 ;;
    --agentd) AGENTD=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

if [[ $(hostname) != mcc ]]; then
  echo "Запускать на сервере: ssh serzhb@94.131.82.220 '~/dev/mcc-agents/scripts/deploy.sh'" >&2
  exit 1
fi

OLD=$(git rev-parse -q --verify HEAD || true)
if [[ $LOCAL == 0 ]]; then
  git fetch -q origin
  # рабочая копия могла прийти через rsync (scripts/sync.sh): если она совпадает с origin/main — просто переключаемся
  if git diff --quiet origin/main -- . ; then
    git reset -q --hard origin/main
  elif git diff --quiet HEAD -- . ; then
    git merge -q --ff-only origin/main
  else
    echo "В ~/dev/mcc-agents есть изменения, которых нет в origin/main. Закоммитьте их или запустите с --local." >&2
    git status --short | head -20 >&2
    exit 1
  fi
fi
NEW=$(git rev-parse -q --verify HEAD || true)

changed() { [[ $LOCAL == 1 || -z $OLD || -z $NEW ]] || ! git diff --quiet "$OLD" "$NEW" -- "$@"; }

if changed package.json package-lock.json apps/web/package.json apps/agentd/package.json; then
  echo "→ npm install"
  npm install --no-audit --no-fund
fi

echo "→ next build"
npm run build -w apps/web

echo "→ restart mcc-agents-web"
sudo systemctl restart mcc-agents-web

if [[ $AGENTD == 1 ]] || changed apps/agentd packages/protocol; then
  busy=$(curl -s --unix-socket /run/mcc-agents/local.sock http://x/api/health | sed -n 's/.*"busy":\([0-9]*\).*/\1/p')
  if [[ ${busy:-0} != 0 && $FORCE == 0 ]]; then
    echo "⚠ Демон не перезапущен: сейчас работают чаты ($busy). Повторите позже или с --force (оборвёт их)." >&2
  else
    echo "→ restart mcc-agentd"
    sudo systemctl restart mcc-agentd
  fi
fi

sleep 2
systemctl is-active mcc-agentd mcc-agents-web
echo "✓ $(git log -1 --format='%h %s')"
