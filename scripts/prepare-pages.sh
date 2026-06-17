#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT/assets" "$ROOT/docs/assets" "$ROOT/docs/reports"
cp "$ROOT/logo.svg" "$ROOT/assets/logo.svg"
cp "$ROOT/logo.svg" "$ROOT/docs/assets/logo.svg"

bash "$ROOT/scripts/generate-pages-index.sh"

if compgen -G "$ROOT/reports/*.html" > /dev/null; then
  cp "$ROOT/reports/"*.html "$ROOT/docs/reports/"
  sed -i 's|src="../logo.svg"|src="../assets/logo.svg"|g' "$ROOT/docs/reports/"*.html
fi

echo "Prepared GitHub Pages site in docs/"
