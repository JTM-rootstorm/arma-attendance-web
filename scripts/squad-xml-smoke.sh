#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required. Export it or place it in the root .env file.}"

UNIT_SLUG="${UNIT_SLUG:-squad-xml-smoke-$STAMP}"
PICTURE_FILENAME="${SQUAD_XML_DEFAULT_PICTURE:-logo.paa}"
PLAYER_UID="7656119${STAMP}77"
XML_FILE="$TMP_DIR/squad.xml"
DTD_FILE="$TMP_DIR/squad.dtd"
XML_HEADERS="$TMP_DIR/squad-xml.headers"
DTD_HEADERS="$TMP_DIR/squad-dtd.headers"
TCWA3_XML_FILE="$TMP_DIR/tcwa3-squad.xml"
TCWA3_XML_HEADERS="$TMP_DIR/tcwa3-squad-xml.headers"

if [[ ! "$PICTURE_FILENAME" =~ ^[A-Za-z0-9._-]+\.paa$ ]]; then
  echo "[squad-xml-smoke] SQUAD_XML_DEFAULT_PICTURE must be a simple .paa filename." >&2
  exit 1
fi

echo "[squad-xml-smoke] Seeding unit, rank, squad, and member..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v unit_slug="$UNIT_SLUG" \
  -v player_uid="$PLAYER_UID" \
  -v base_url="$BASE_URL" \
  -v picture_filename="$PICTURE_FILENAME" <<'SQL'
WITH seeded_unit AS (
  INSERT INTO units (
    unit_key,
    slug,
    name,
    display_name,
    callsign,
    squad_xml_title,
    squad_xml_web_url,
    squad_xml_picture_filename,
    is_active,
    deleted_at
  )
  VALUES (
    :'unit_slug',
    :'unit_slug',
    'Squad XML Smoke Battalion',
    'Squad XML Smoke Battalion',
    'SXML',
    'Squad XML Smoke',
    :'base_url',
    :'picture_filename',
    true,
    NULL
  )
  ON CONFLICT (unit_key) DO UPDATE SET
    slug = EXCLUDED.slug,
    name = EXCLUDED.name,
    display_name = EXCLUDED.display_name,
    callsign = EXCLUDED.callsign,
    squad_xml_title = EXCLUDED.squad_xml_title,
    squad_xml_web_url = EXCLUDED.squad_xml_web_url,
    squad_xml_picture_filename = EXCLUDED.squad_xml_picture_filename,
    is_active = true,
    deleted_at = NULL,
    updated_at = now()
  RETURNING id
),
seeded_player AS (
  INSERT INTO players (player_uid, last_name, specialization, raw_last_player)
  VALUES (:'player_uid', 'Smoke <Pilot> & "Ace"', 3, '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET
    last_name = EXCLUDED.last_name,
    specialization = EXCLUDED.specialization,
    updated_at = now()
  RETURNING player_uid
),
seeded_rank AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, short_name, sort_order, is_active)
  SELECT seeded_unit.id, 'cpl', 'Corporal', 'CPL', 10, true
  FROM seeded_unit
  ON CONFLICT (unit_id, rank_key) DO UPDATE SET
    name = EXCLUDED.name,
    short_name = EXCLUDED.short_name,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    updated_at = now()
  RETURNING id, unit_id
),
seeded_squad AS (
  INSERT INTO unit_squads (unit_id, squad_key, name, squad_type, hierarchy_mode, sort_order, is_active)
  SELECT seeded_unit.id, 'phoenix', 'Phoenix Squad', 'squad', 'flat', 20, true
  FROM seeded_unit
  ON CONFLICT (unit_id, squad_key) DO UPDATE SET
    name = EXCLUDED.name,
    squad_type = EXCLUDED.squad_type,
    hierarchy_mode = EXCLUDED.hierarchy_mode,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    updated_at = now()
  RETURNING id, unit_id
),
seeded_unit_player AS (
  INSERT INTO unit_players (unit_id, player_uid, rank, roster_name, rank_sort, roster_status, rank_id, is_active)
  SELECT seeded_unit.id, seeded_player.player_uid, 'CPL', 'Smoke & Mirrors', 10, 'active', seeded_rank.id, true
  FROM seeded_unit, seeded_player, seeded_rank
  ON CONFLICT (unit_id, player_uid) DO UPDATE SET
    rank = EXCLUDED.rank,
    roster_name = EXCLUDED.roster_name,
    rank_sort = EXCLUDED.rank_sort,
    roster_status = 'active',
    rank_id = EXCLUDED.rank_id,
    is_active = true,
    updated_at = now()
  RETURNING unit_id, player_uid
)
INSERT INTO unit_roster_assignments (unit_id, player_uid, squad_id, billet, sort_order, is_primary, assignment_source)
SELECT seeded_unit_player.unit_id, seeded_unit_player.player_uid, seeded_squad.id, 'squad_lead', 10, true, 'manual'
FROM seeded_unit_player
JOIN seeded_squad ON seeded_squad.unit_id = seeded_unit_player.unit_id
ON CONFLICT (unit_id, player_uid) WHERE ended_at IS NULL AND is_primary = true DO UPDATE SET
  squad_id = EXCLUDED.squad_id,
  billet = EXCLUDED.billet,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
SQL

echo "[squad-xml-smoke] Fetching DTD and XML..."
curl -fsS -D "$DTD_HEADERS" "$BASE_URL/public/squads/$UNIT_SLUG/squad.dtd" -o "$DTD_FILE"
curl -fsS -D "$XML_HEADERS" "$BASE_URL/public/squads/$UNIT_SLUG/squad.xml" -o "$XML_FILE"
curl -fsS -D "$TCWA3_XML_HEADERS" "$BASE_URL/public/squads/tcwa3/squad.xml" -o "$TCWA3_XML_FILE"

if ! grep -i '^content-type: .*xml' "$DTD_HEADERS" >/dev/null; then
  echo "[squad-xml-smoke] DTD response content type is not XML-ish." >&2
  cat "$DTD_HEADERS" >&2
  exit 1
fi

if ! grep -i '^content-type: .*xml' "$XML_HEADERS" >/dev/null; then
  echo "[squad-xml-smoke] squad.xml response content type is not XML-ish." >&2
  cat "$XML_HEADERS" >&2
  exit 1
fi

if ! grep -i '^content-type: .*xml' "$TCWA3_XML_HEADERS" >/dev/null; then
  echo "[squad-xml-smoke] TCWA3 squad.xml response content type is not XML-ish." >&2
  cat "$TCWA3_XML_HEADERS" >&2
  exit 1
fi

grep -F '<!ELEMENT squad (name,email,web,picture,title,member*)>' "$DTD_FILE" >/dev/null
grep -F '<!ELEMENT member (name,email,icq,remark)>' "$DTD_FILE" >/dev/null

if grep -E 'web\?|picture\?|title\?|icq\?|remark\?' "$DTD_FILE" >/dev/null; then
  echo "[squad-xml-smoke] DTD marks required fields optional." >&2
  exit 1
fi

python3 - "$XML_FILE" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

xml_path = Path(sys.argv[1])
raw = xml_path.read_text(encoding="utf-8")

if not raw.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE squad SYSTEM "squad.dtd">\n'):
    raise SystemExit("squad.xml does not begin with the required XML declaration and DOCTYPE")

root = ET.fromstring(raw)
if root.tag != "squad":
    raise SystemExit(f"root tag is {root.tag}, expected squad")

if set(root.attrib.keys()) != {"nick"}:
    raise SystemExit(f"unexpected squad attributes: {root.attrib}")

children = list(root)
expected_head = ["name", "email", "web", "picture", "title"]
actual_head = [child.tag for child in children[:5]]
if actual_head != expected_head:
    raise SystemExit(f"wrong squad child order: {actual_head}")

allowed_tags = set(expected_head + ["member"])
for child in children:
    if child.tag not in allowed_tags:
        raise SystemExit(f"custom squad child found: {child.tag}")

for tag in expected_head:
    node = root.find(tag)
    if node is None:
        raise SystemExit(f"missing squad/{tag}")
    if (node.text or "").strip() == "":
        raise SystemExit(f"empty squad/{tag}")

if root.find("email").text != "N/A":
    raise SystemExit("squad/email must be N/A")

picture = (root.find("picture").text or "").strip()
if not picture.endswith(".paa") or "/" in picture or "\\" in picture:
    raise SystemExit(f"picture must be a simple .paa filename, got {picture!r}")

members = root.findall("member")
if not members:
    raise SystemExit("expected at least one member")

for member in members:
    if set(member.attrib.keys()) != {"id", "nick"}:
        raise SystemExit(f"unexpected member attributes: {member.attrib}")
    if not member.attrib["id"].strip():
        raise SystemExit("member id is empty")
    if not member.attrib["nick"].strip():
        raise SystemExit("member nick is empty")
    member_tags = [child.tag for child in list(member)]
    if member_tags != ["name", "email", "icq", "remark"]:
        raise SystemExit(f"wrong member child order: {member_tags}")
    if member.find("name").text != "N/A":
        raise SystemExit("member/name must be N/A")
    if member.find("email").text != "N/A":
        raise SystemExit("member/email must be N/A")
    if member.find("icq").text != "N/A":
        raise SystemExit("member/icq must be N/A")
    if not (member.find("remark").text or "").strip():
        raise SystemExit("member/remark must not be empty")
    if member.find("remark").text != "SXML,CPL,3":
        raise SystemExit(f"member/remark must be BATTALION_CALLSIGN,RANK,SPECIALIZATION, got {member.find('remark').text!r}")

print("[squad-xml-smoke] strict XML shape OK")
PY

python3 - "$TCWA3_XML_FILE" "$PLAYER_UID" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

xml_path = Path(sys.argv[1])
player_uid = sys.argv[2]
raw = xml_path.read_text(encoding="utf-8")

if not raw.startswith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE squad SYSTEM "squad.dtd">\n'):
    raise SystemExit("TCWA3 squad.xml does not begin with the required XML declaration and DOCTYPE")

root = ET.fromstring(raw)
if root.attrib.get("nick") != "TCWA3":
    raise SystemExit(f"TCWA3 squad nick must be TCWA3, got {root.attrib.get('nick')!r}")
if root.find("name") is None or root.find("name").text != "The Clone Wars ARMA 3":
    raise SystemExit("TCWA3 squad/name must be The Clone Wars ARMA 3")

member = next((candidate for candidate in root.findall("member") if candidate.attrib.get("id") == player_uid), None)
if member is None:
    raise SystemExit("TCWA3 squad.xml does not include the seeded member")
if member.find("remark") is None or member.find("remark").text != "SXML,CPL,3":
    raise SystemExit(f"TCWA3 member/remark must preserve battalion callsign, got {member.find('remark').text if member.find('remark') is not None else None!r}")

print("[squad-xml-smoke] TCWA3 aggregate XML shape OK")
PY

picture="$(python3 - "$XML_FILE" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
print(root.find("picture").text)
PY
)"

curl -fsS "$BASE_URL/public/squads/$UNIT_SLUG/$picture" -o "$TMP_DIR/$picture"
echo "[squad-xml-smoke] PAA fetch OK: $picture"
