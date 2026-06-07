#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

assert_json() {
  local expression="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ok = Function("data", `return (${process.argv[1]});`)(data);
if (!ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}
' "$expression"
}

echo "[smoke:leaderboard:public] Checking /v1 leaderboard without auth..."
curl -fsS "$BASE_URL/v1/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.pagination.limit === 50'

echo "[smoke:leaderboard:public] Checking /v1 leaderboard with stale Authorization..."
curl -fsS -H "Authorization: Bearer undefined" "$BASE_URL/v1/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

echo "[smoke:leaderboard:public] Checking public alias without auth..."
curl -fsS -D "$TMP_DIR/public.headers" "$BASE_URL/public/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

if ! grep -iq '^cache-control: public, max-age=60' "$TMP_DIR/public.headers"; then
  echo "[smoke:leaderboard:public] Missing Cache-Control: public, max-age=60." >&2
  cat "$TMP_DIR/public.headers" >&2
  exit 1
fi

echo "[smoke:leaderboard:public] Checking public alias ignores stale Authorization..."
curl -fsS -H "Authorization: Bearer null" "$BASE_URL/public/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

echo "[smoke:leaderboard:public] OK"
