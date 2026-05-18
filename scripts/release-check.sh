#!/usr/bin/env bash
set -euo pipefail

run() {
  echo "[release:check] $*"
  "$@"
}

run pnpm typecheck
run pnpm lint
run pnpm build
run pnpm smoke:local

if [[ "${RUN_DB_SMOKE:-0}" == "1" ]]; then
  run pnpm db:status
  run pnpm smoke:db
  run pnpm smoke:operations
  run pnpm smoke:operations:observability
  run pnpm smoke:attendance
  run pnpm smoke:dashboard
  run pnpm smoke:exports
  run pnpm smoke:data-quality
  run pnpm smoke:discord
  run pnpm smoke:auth
fi

echo "[release:check] OK"
