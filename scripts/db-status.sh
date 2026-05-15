#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT/sql/migrations}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required. Export it or place it in the root .env file.}"

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "[db:status] Migration directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

echo "[db:status] Applied migrations:"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  'SELECT version, name, applied_at FROM schema_migrations ORDER BY version;'

echo "[db:status] File status:"
mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)

if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "  no migration files found"
  exit 0
fi

for migration in "${migrations[@]}"; do
  filename="$(basename "$migration")"
  version_prefix="${filename%%_*}"
  version="$((10#$version_prefix))"
  checksum="$(sha256sum "$migration" | awk '{print $1}')"

  read -r applied_checksum < <(
    psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
      -c "SELECT checksum FROM schema_migrations WHERE version = $version;"
  ) || true

  if [[ -z "${applied_checksum:-}" ]]; then
    echo "  pending  $filename"
  elif [[ "$applied_checksum" == "$checksum" ]]; then
    echo "  applied  $filename"
  else
    echo "  changed  $filename checksum mismatch" >&2
    exit 1
  fi
done
