#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT/docs/assets" "$ROOT/docs/reports"
cp "$ROOT/logo.svg" "$ROOT/docs/assets/logo.svg"

if compgen -G "$ROOT/reports/*.html" > /dev/null; then
  cp "$ROOT/reports/"*.html "$ROOT/docs/reports/"
  sed -i 's|src="../logo.svg"|src="../assets/logo.svg"|g' "$ROOT/docs/reports/"*.html
fi

echo "Prepared GitHub Pages site in docs/"
