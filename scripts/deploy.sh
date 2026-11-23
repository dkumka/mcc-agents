#!/usr/bin/env bash
# Обновить mcc agents НА СЕРВЕРЕ: git → npm install → next build → перезапуск веб-интерфейса.
#   scripts/deploy.sh            — подтянуть origin/main, собрать и перезапустить веб (безопасно)
#   scripts/deploy.sh --local    — собрать то, что лежит в папке сейчас (после scripts/sync.sh с Mac), без git;
#                                  демон при этом перезапускается только с --agentd
#   scripts/deploy.sh --agentd   — плюс перезапустить демон. Демон перезапускается и сам, если apps/agentd или
#                                  packages/protocol изменились с коммита, с которого он запущен (.git/mcc-deploy/agentd).
#                                  Перезапуск ОБРЫВАЕТ идущие задачи агентов, поэтому при занятых чатах скрипт откажется
#                                  без --force.
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
  echo "Запускать на сервере: ssh dev@SERVER_IP '~/dev/mcc/mcc-agents/scripts/deploy.sh'" >&2
  exit 1
fi

if [[ $LOCAL == 0 ]]; then
  git fetch -q origin
  # рабочая копия могла прийти через rsync (scripts/sync.sh): если файлы совпадают с origin/main (включая ещё
  # не отслеживаемые git новые файлы) — просто переключаемся; сравниваем через временный индекс с деревом origin/main
  tmpidx=$(mktemp); trap 'rm -f "$tmpidx"' EXIT
  GIT_INDEX_FILE=$tmpidx git read-tree origin/main
  GIT_INDEX_FILE=$tmpidx git update-index -q --refresh >/dev/null 2>&1 || true
  if GIT_INDEX_FILE=$tmpidx git diff-files --quiet; then
    git reset -q --hard origin/main
  else
    echo "В ~/dev/mcc/mcc-agents есть изменения, которых нет в origin/main. Закоммитьте их или запустите с --local." >&2
    GIT_INDEX_FILE=$tmpidx git diff-files --name-only | head -20 >&2
    exit 1
  fi
fi
NEW=$(git rev-parse -q --verify HEAD || true)

# What is running now is recorded per part (the commit the web was built from / the daemon was started from) —
# not «HEAD before this run»: scripts/sync.sh already moves git to origin/main (git-align.sh), so HEAD before and after
# are the same and a changed daemon was not restarted (2026-11-23). No record / unknown commit → treat as changed.
STATE=.git/mcc-deploy
mkdir -p "$STATE"
WEB_REV=$(cat "$STATE/web" 2>/dev/null || true)
AGENTD_REV=$(cat "$STATE/agentd" 2>/dev/null || true)
changed() { # changed <base-commit> <paths…>
  local base=$1; shift
  [[ $LOCAL == 1 || -z $base || -z $NEW ]] && return 0
  git cat-file -e "$base^{commit}" 2>/dev/null || return 0
  ! git diff --quiet "$base" "$NEW" -- "$@"
}
record() { if [[ $LOCAL == 0 && -n $NEW ]]; then echo "$NEW" > "$STATE/$1"; else rm -f "$STATE/$1"; fi; }

if changed "$WEB_REV" package.json package-lock.json apps/web/package.json apps/agentd/package.json; then
  echo "→ npm install"
  npm install --no-audit --no-fund
fi

echo "→ next build"
npm run build -w apps/web

echo "→ restart mcc-agents-web"
sudo systemctl restart mcc-agents-web
record web

if [[ $AGENTD == 1 ]] || { [[ $LOCAL == 0 ]] && changed "$AGENTD_REV" apps/agentd packages/protocol; }; then
  busy=$(curl -s --unix-socket /run/mcc-agents/local.sock http://x/api/health | sed -n 's/.*"busy":\([0-9]*\).*/\1/p')
  if [[ ${busy:-0} != 0 && $FORCE == 0 ]]; then
    echo "⚠ Демон не перезапущен: сейчас работают чаты ($busy). Повторите позже (запомнено — следующий deploy.sh перезапустит) или с --force (оборвёт их)." >&2
  else
    echo "→ restart mcc-agentd"
    sudo systemctl restart mcc-agentd
    record agentd
  fi
fi

sleep 2
systemctl is-active mcc-agentd mcc-agents-web
echo "✓ $(git log -1 --format='%h %s')"
