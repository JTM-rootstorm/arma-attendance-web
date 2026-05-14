#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/arma-attendance}"
SERVICE_NAME="${SERVICE_NAME:-arma-attendance-api}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"

cd "$APP_DIR"

echo "[deploy] Pulling latest source"
git pull --ff-only

run_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
  else
    npm exec pnpm@10.0.0 -- "$@"
  fi
}

if command -v corepack >/dev/null 2>&1; then
  echo "[deploy] Enabling Corepack"
  corepack enable
else
  echo "[deploy] Corepack not found; falling back to npm exec pnpm@10.0.0"
fi

echo "[deploy] Installing dependencies"
run_pnpm install --frozen-lockfile

echo "[deploy] Building"
run_pnpm build

echo "[deploy] Restarting ${SERVICE_NAME}"
systemctl restart "$SERVICE_NAME"

echo "[deploy] Service status"
systemctl --no-pager --full status "$SERVICE_NAME"

echo "[deploy] Health check"
curl -fsS "${BASE_URL}/health"

echo
echo "[deploy] Done"
