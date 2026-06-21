#!/usr/bin/env bash

json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1] ?? ""));' "$1"
}

operation_start_payload() {
  local request_id="$1"
  local server_key="$2"
  local mission_uid="$3"
  local mission_name="$4"
  local world_name="$5"

  printf '{"request_id":%s,"server_key":%s,"payload_version":1,"mission":{"mission_uid":%s,"mission_name":%s,"world_name":%s},"players":[]}' \
    "$(json_string "$request_id")" \
    "$(json_string "$server_key")" \
    "$(json_string "$mission_uid")" \
    "$(json_string "$mission_name")" \
    "$(json_string "$world_name")"
}

operation_finish_payload() {
  local request_id="$1"
  local server_key="$2"
  local mission_uid="$3"
  local mission_name="$4"
  local world_name="$5"
  local players_json="$6"
  local outcome="${7:-success}"

  printf '{"request_id":%s,"server_key":%s,"payload_version":1,"outcome":%s,"mission":{"mission_uid":%s,"mission_name":%s,"world_name":%s},"players":%s}' \
    "$(json_string "$request_id")" \
    "$(json_string "$server_key")" \
    "$(json_string "$outcome")" \
    "$(json_string "$mission_uid")" \
    "$(json_string "$mission_name")" \
    "$(json_string "$world_name")" \
    "$players_json"
}

two_player_payload_json() {
  local player_one_uid="$1"
  local player_one_name="$2"
  local player_two_uid="$3"
  local player_two_name="$4"

  printf '[{"player_uid":%s,"name":%s},{"player_uid":%s,"name":%s}]' \
    "$(json_string "$player_one_uid")" \
    "$(json_string "$player_one_name")" \
    "$(json_string "$player_two_uid")" \
    "$(json_string "$player_two_name")"
}

one_player_payload_json() {
  local player_uid="$1"
  local player_name="$2"

  printf '[{"player_uid":%s,"name":%s}]' \
    "$(json_string "$player_uid")" \
    "$(json_string "$player_name")"
}
