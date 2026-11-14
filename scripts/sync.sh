#!/usr/bin/env bash
# Mac → server: push the working tree into ~/dev/mcc-agents on the server (dev loop, no commit needed).
# Usage: scripts/sync.sh            — push sources
#        scripts/sync.sh --pull     — pull files generated on the server (lockfile, shadcn components)
set -euo pipefail
HOST="${MCC_HOST:-dev@SERVER_IP}"
REMOTE="${MCC_REMOTE:-/home/dev/dev/mcc-agents}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXCLUDES=(--exclude node_modules --exclude .next --exclude .git --exclude '*.tsbuildinfo' --exclude next-env.d.ts --exclude test-results --exclude playwright-report)

if [[ "${1:-}" == "--pull" ]]; then
  rsync -az "${EXCLUDES[@]}" "$HOST:$REMOTE/" "$ROOT/"
else
  # --delete: files removed on the Mac disappear on the server too (excluded paths are kept)
  rsync -az --delete "${EXCLUDES[@]}" "$ROOT/" "$HOST:$REMOTE/"
fi
