#!/usr/bin/env bash
# On the server: put ~/dev/mcc-agents on origin/main when its files are exactly what is in origin/main.
#   Run by scripts/sync.sh after it copies the Mac working tree. Same check as deploy.sh: a temporary index with the
#   origin/main tree compared with the files on disk (new, not yet tracked files included). Nothing is lost: if a single
#   file differs, git is left alone and the differing files are listed.
# Why: files arrive by rsync, git does not — without this the server shows «changed files» that are already committed
#   and «behind origin», and the next `deploy.sh` (git mode) refuses to run (2026-11-18).
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch -q origin
tmpidx=$(mktemp)
trap 'rm -f "$tmpidx"' EXIT
GIT_INDEX_FILE=$tmpidx git read-tree origin/main
GIT_INDEX_FILE=$tmpidx git update-index -q --refresh >/dev/null 2>&1 || true
if GIT_INDEX_FILE=$tmpidx git diff-files --quiet; then
  if [[ $(git rev-parse HEAD) != $(git rev-parse origin/main) ]] || ! git diff --quiet HEAD; then
    git reset -q --hard origin/main
  fi
  echo "git: сервер на origin/main ($(git log --oneline -1))"
else
  echo "git: файлы на сервере отличаются от origin/main — git не тронут. Закоммитьте и запушьте на Mac, потом снова scripts/sync.sh:" >&2
  GIT_INDEX_FILE=$tmpidx git diff-files --name-only | head -20 | sed 's/^/  /' >&2
fi
