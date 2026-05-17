#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
BOT_API_TOKEN="${BOT_API_TOKEN:-$API_TOKEN}"
SERVER_KEY="${SERVER_KEY:-discord-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
GUILD_ID="${GUILD_ID:-guild-$STAMP}"
ROLE_ID="${ROLE_ID:-role-attended-$STAMP}"
DISCORD_USER_ID="${DISCORD_USER_ID:-discord-user-$STAMP}"
MISSION_UID="${MISSION_UID:-discord-smoke-$STAMP}"
PLAYER_UID="${PLAYER_UID:-discord-smoke-player-$STAMP}"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:discord] API_TOKEN is required." >&2
  exit 1
fi

print_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
    printf '\n'
  fi
}

json_value() {
  local expression="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -r "$expression"
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
expression = sys.argv[1]

for part in expression.removeprefix(".").split("."):
    if not part:
        continue

    if "[" in part and part.endswith("]"):
        name, index = part[:-1].split("[", 1)
        if name:
            data = data[name]
        data = data[int(index)]
    else:
        data = data[part]

if isinstance(data, bool):
    print("true" if data else "false")
elif data is None:
    print("null")
else:
    print(data)
' "$expression"
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

assert_ok() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true' >/dev/null
  else
    python3 -c '
import json
import sys

if json.load(sys.stdin).get("ok") is not True:
    raise SystemExit(1)
'
  fi
}

assert_role_action_grant() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true and (.actions | length) >= 1 and any(.actions[]; .action == "grant")' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
actions = data.get("actions", [])
if not (data.get("ok") is True and any(action.get("action") == "grant" for action in actions)):
    raise SystemExit(1)
'
  fi
}

role_action_result_body() {
  python3 -c '
import json
import sys

data = json.load(sys.stdin)
actions = data.get("actions", [])
if not actions:
    raise SystemExit("no role actions returned")

action = actions[0]
body = {
    "evaluation_id": data["evaluation_id"],
    "results": [
        {
            "audit_id": action.get("audit_id"),
            "action": action["action"],
            "player_uid": action["player_uid"],
            "discord_user_id": action["discord_user_id"],
            "role_id": action["role_id"],
            "status": "reported_success"
        }
    ]
}
print(json.dumps(body))
'
}

echo "[smoke:discord] Creating synthetic operation attendance..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$START_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Discord Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_UID\",
          \"name\": \"Discord Smoke Player\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-1\",
          \"role\": \"Rifleman\"
        }
      ]
    }"
)"
printf '%s\n' "$start_response" | print_json
operation_id="$(printf '%s\n' "$start_response" | json_value ".operation_id")"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:discord] Missing operation_id from start response." >&2
  exit 1
fi

finish_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$FINISH_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Discord Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_UID\",
          \"name\": \"Discord Smoke Player\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-1\",
          \"role\": \"Team Leader\"
        }
      ]
    }"
)"
printf '%s\n' "$finish_response" | print_json

echo "[smoke:discord] Syncing fake guild and role..."
sync_response="$(
  curl -fsS -X POST "$BASE_URL/v1/discord/guilds/sync" \
    -H "Authorization: Bearer $BOT_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"guild\": {
        \"guild_id\": \"$GUILD_ID\",
        \"name\": \"Attendance Smoke Guild\",
        \"bot_user_id\": \"bot-$STAMP\",
        \"bot_present\": true
      },
      \"roles\": [
        {
          \"role_id\": \"$ROLE_ID\",
          \"name\": \"Attended Ops\",
          \"color\": 3447003,
          \"position\": 10,
          \"managed\": false,
          \"assignable\": true
        }
      ]
    }"
)"
printf '%s\n' "$sync_response" | print_json
printf '%s\n' "$sync_response" | assert_ok

echo "[smoke:discord] Linking player to Discord user..."
link_response="$(
  curl -fsS -X POST "$BASE_URL/v1/discord/player-links" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"player_uid\": \"$PLAYER_UID\",
      \"discord_user_id\": \"$DISCORD_USER_ID\",
      \"discord_display_name\": \"Discord Smoke Player\",
      \"source\": \"manual\",
      \"verified\": true
    }"
)"
printf '%s\n' "$link_response" | print_json
printf '%s\n' "$link_response" | assert_ok

echo "[smoke:discord] Creating attendance rule..."
rule_response="$(
  curl -fsS -X POST "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/rules" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"role_id\": \"$ROLE_ID\",
      \"name\": \"Discord Smoke Attendance\",
      \"description\": \"Synthetic smoke-test rule\",
      \"min_attendance_points\": 1,
      \"min_operation_count\": 1,
      \"min_attendance_percent\": 50,
      \"server_key\": \"$SERVER_KEY\",
      \"require_present_at_end\": true,
      \"include_started_operations\": false,
      \"grant_mode\": \"grant_and_revoke_preview\"
    }"
)"
printf '%s\n' "$rule_response" | print_json
printf '%s\n' "$rule_response" | assert_ok

echo "[smoke:discord] Reading Discord readiness surfaces..."
curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")" -H "Authorization: Bearer $API_TOKEN" | assert_ok
curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/roles" -H "Authorization: Bearer $API_TOKEN" | assert_ok
curl -fsS "$BASE_URL/v1/discord/player-links?q=$(urlencode "$PLAYER_UID")" -H "Authorization: Bearer $API_TOKEN" | assert_ok
curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/rules" -H "Authorization: Bearer $API_TOKEN" | assert_ok

echo "[smoke:discord] Evaluating dry-run role actions..."
dry_run_response="$(
  curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/role-actions?dry_run=true&persist=false" \
    -H "Authorization: Bearer $BOT_API_TOKEN"
)"
printf '%s\n' "$dry_run_response" | print_json
printf '%s\n' "$dry_run_response" | assert_role_action_grant

echo "[smoke:discord] Persisting role action audit..."
persist_response="$(
  curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/role-actions?dry_run=false&persist=true" \
    -H "Authorization: Bearer $BOT_API_TOKEN"
)"
printf '%s\n' "$persist_response" | print_json
printf '%s\n' "$persist_response" | assert_role_action_grant

result_body="$(printf '%s\n' "$persist_response" | role_action_result_body)"

echo "[smoke:discord] Reporting role action result..."
result_response="$(
  curl -fsS -X POST "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/role-action-results" \
    -H "Authorization: Bearer $BOT_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$result_body"
)"
printf '%s\n' "$result_response" | print_json
printf '%s\n' "$result_response" | assert_ok

echo "[smoke:discord] Fetching audit trail..."
audits_response="$(
  curl -fsS "$BASE_URL/v1/discord/guilds/$(urlencode "$GUILD_ID")/role-action-audits" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$audits_response" | print_json
printf '%s\n' "$audits_response" | assert_ok

echo "[smoke:discord] OK guild_id=$GUILD_ID player_uid=$PLAYER_UID"
