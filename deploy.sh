#!/bin/bash
# One-command deploy. Usage: ./deploy.sh "commit message" [--dry-run]
# Steps: bump docs/version.json (+ index.html ?v=) if docs/ changed,
# clasp push, clasp deploy to the LIVE versioned deployment, commit, git push.
# The live deployment id is kept OUT of this public repo, in ../deploy-id.txt.
set -euo pipefail
cd "$(dirname "$0")"

MSG="${1:-}"; DRY="${2:-}"
[ -n "$MSG" ] || { echo "Usage: ./deploy.sh \"commit message\" [--dry-run]"; exit 1; }
ID_FILE="../deploy-id.txt"
[ -f "$ID_FILE" ] || { echo "Missing $ID_FILE (live deployment id)"; exit 1; }
DEPLOY_ID="$(tr -d '[:space:]' < "$ID_FILE")"

run() { if [ "$DRY" = "--dry-run" ]; then echo "[dry-run] $*"; else "$@"; fi; }

# 1. Version bump — only when frontend files changed (uncommitted changes).
if [ -n "$(git status --porcelain docs | grep -E '\.(html|js|css)$' | grep -v 'version.json' || true)" ]; then
  OLD="$(python3 -c "import json;print(json.load(open('docs/version.json'))['version'])")"
  NEW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Bumping version $OLD -> $NEW"
  if [ "$DRY" != "--dry-run" ]; then
    sed -i '' "s/$OLD/$NEW/g" docs/index.html
    echo "{ \"version\": \"$NEW\" }" > docs/version.json
  fi
else
  echo "No frontend changes — version not bumped."
fi

# 2. Backend: upload, then point the live deployment at it.
if [ -n "$(git status --porcelain backend)" ]; then
  (cd backend && run clasp push -f && run clasp deploy -i "$DEPLOY_ID" -d "$MSG")
else
  echo "No backend changes — skipping clasp."
fi

# 3. Commit + push (GitHub Pages serves docs/).
git add -A backend docs cloudflare-worker deploy.sh
if git diff --cached --quiet; then
  echo "Nothing new to commit."
else
  run git commit -m "$MSG

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
fi
run git push
echo "Done."
