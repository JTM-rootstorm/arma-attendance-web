#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

run() {
  echo "[release:check] $*"
  "$@"
}

require_env() {
  local name="$1"
  local help="$2"

  if [[ -z "${!name:-}" ]]; then
    echo "[release:check] $name is required for DB smoke. $help" >&2
    exit 1
  fi
}

run pnpm typecheck
echo "[release:check] lint is not configured; pnpm typecheck is the current static gate"
run pnpm drizzle:check
run pnpm drizzle:boundary
run pnpm build
run pnpm smoke:local

if [[ "${RUN_DB_SMOKE:-0}" == "1" ]]; then
  require_env DATABASE_URL "Export it or place it in the root .env file."
  require_env API_TOKEN "It must match the API server used by BASE_URL."
  require_env ENABLE_TEST_AUTH "Set ENABLE_TEST_AUTH=true for synthetic auth smoke routes."

  if [[ "$ENABLE_TEST_AUTH" != "true" ]]; then
    echo "[release:check] ENABLE_TEST_AUTH must be true for DB smoke synthetic auth routes." >&2
    exit 1
  fi

  run pnpm db:status
  run pnpm smoke:db
  run pnpm smoke:operations
  run pnpm smoke:operations:observability
  run pnpm smoke:attendance
  run pnpm smoke:scoreboard
  run pnpm smoke:battalions
  run pnpm smoke:leaderboard
  run pnpm smoke:leaderboard:public
  run pnpm smoke:xp-rewards
  run pnpm smoke:xp-award-on-finish
  run pnpm smoke:xp-award-delete-reversal
  run pnpm smoke:dashboard
  run pnpm smoke:exports
  run pnpm smoke:data-quality
  run pnpm smoke:discord
  run pnpm smoke:auth
  run pnpm smoke:rbac
fi

echo "[release:check] OK"
