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
  echo "[db:migrate] Migration directory not found: $MIGRATIONS_DIR" >&2
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

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)

if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "[db:migrate] No migrations found in $MIGRATIONS_DIR"
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

  if [[ -n "${applied_checksum:-}" ]]; then
    if [[ "$applied_checksum" != "$checksum" ]]; then
      echo "[db:migrate] Checksum mismatch for already-applied migration $filename" >&2
      echo "[db:migrate] DB checksum:   $applied_checksum" >&2
      echo "[db:migrate] File checksum: $checksum" >&2
      exit 1
    fi

    echo "[db:migrate] Skipping already-applied migration $filename"
    continue
  fi

  echo "[db:migrate] Applying $filename"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v version="$version" \
    -v name="$filename" \
    -v checksum="$checksum" <<'SQL'
INSERT INTO schema_migrations (version, name, checksum)
VALUES (:version, :'name', :'checksum');
SQL
done

current_version="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c 'SELECT COALESCE(MAX(version), 0) FROM schema_migrations;')"
echo "[db:migrate] Done. Current DB schema version: $current_version"
