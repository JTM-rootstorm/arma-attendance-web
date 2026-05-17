#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONT_URL="${AUREBESHAF_FONT_URL:-https://aurekfonts.github.io/AurebeshAF/AurebeshAF.zip}"
OUT_DIR="$ROOT/apps/web/public/fonts/aurebesh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

echo "[fonts] Downloading AurebeshAF package..."
curl -fsSL "$FONT_URL" -o "$TMP_DIR/AurebeshAF.zip"

echo "[fonts] Unpacking..."
unzip -q "$TMP_DIR/AurebeshAF.zip" -d "$TMP_DIR/unpacked"

echo "[fonts] Copying font files..."
find "$TMP_DIR/unpacked" -type f \( -iname "*.otf" -o -iname "*.ttf" \) -print0 |
  while IFS= read -r -d "" font_file; do
    cp "$font_file" "$OUT_DIR/$(basename "$font_file")"
  done

if [[ ! -f "$OUT_DIR/AurebeshAF-Canon.otf" ]]; then
  echo "[fonts] Expected AurebeshAF-Canon.otf but it was not found." >&2
  echo "[fonts] Found:" >&2
  find "$OUT_DIR" -maxdepth 1 -type f -print >&2
  exit 1
fi

font_count="$(find "$OUT_DIR" -maxdepth 1 -type f \( -iname "*.otf" -o -iname "*.ttf" \) | wc -l | tr -d " ")"

if [[ "$font_count" -lt 4 ]]; then
  echo "[fonts] Expected at least four font files from the package; found $font_count." >&2
  find "$OUT_DIR" -maxdepth 1 -type f -print >&2
  exit 1
fi

cat > "$OUT_DIR/AUREBESHAF-SOURCE.txt" <<'EOF'
Aurebesh AF font package

Source page:
https://aurekfonts.github.io/?font=AurebeshAF

Download package:
https://aurekfonts.github.io/AurebeshAF/AurebeshAF.zip

Catalog source:
https://github.com/AurekFonts/AurekFonts.github.io/blob/master/src/fonts.js

License text from AurekFonts catalog metadata:
Free for all personal and commercial uses.

Integration note:
The dashboard uses AurebeshAF-Canon.otf by default. Other package fonts are retained for future decorative UI variants.
EOF

echo "[fonts] Installed $font_count font files into $OUT_DIR"
find "$OUT_DIR" -maxdepth 1 -type f -print | sort
