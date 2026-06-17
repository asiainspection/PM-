#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REPORT_DATE="${1:-$(date -u +%F)}"

bash scripts/prepare-pages.sh

git add docs/
if git diff --staged --quiet; then
  echo "Docs already in sync; no publish commit created."
  exit 0
fi

git commit -m "Publish weekly TIC market report ${REPORT_DATE}"
git push origin HEAD

echo "Published docs for ${REPORT_DATE}. GitHub Pages deploy will run on push."
