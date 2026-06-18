#!/usr/bin/env bash

smoke_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

smoke_load_env() {
  local env_file="${1:-}"

  if [[ -z "$env_file" ]]; then
    return
  fi

  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
}

smoke_require_env() {
  local script_name="$1"
  local name="$2"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    echo "[$script_name] $name is required." >&2
    exit 1
  fi
}

smoke_assert_equals() {
  local script_name="$1"
  local actual="$2"
  local expected="$3"
  local label="$4"

  if [[ "$actual" != "$expected" ]]; then
    echo "[$script_name] Expected $label to be '$expected', got '$actual'." >&2
    exit 1
  fi
}
