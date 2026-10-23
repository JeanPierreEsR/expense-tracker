#!/bin/bash
# promote.sh — send a tested release to the FRIENDS (called as: ./ship.sh --promote [release]).
#
# Why it exists: the app screens on GitHub Pages are shared, so every ship reaches everyone. Friends use a
# frozen copy in docs/stable/ instead; only this script changes it. It also moves docs/setup/pin.json to the
# backend commit that belongs to the same release, so screens and backend always move as one tested pair.
# Run it ONLY when the owner says "promote" (same rule as "run deploy").
#
# Usage (real, from the main folder, on branch main):
#   ./ship.sh --promote                 promote what is live on main now
#   ./ship.sh --promote 0.22.1          promote (or roll back to) that release (tag v0.22.1)
# Preview (safe from anywhere, works in a throwaway copy):
#   ./ship.sh --promote [release] --dry-run
#
# Steps (stops at the first problem):
#   1. guards: main folder only, on main, no loose changes, nothing unpublished, one ship at a time
#   2. checks the chosen release can run from stable/ and passes the backend tests (both e-mail readers)
#   3. copies its screens into docs/stable/ (not setup/, setup-test/, vendor/) and marks them "stable"
#   4. sets docs/setup/pin.json to the last commit that changed backend/ at that release
#   5. commits, pushes, tags stable-vX.Y.Z and adds a line to ../FRIENDS_VERSIONS.md
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

DRY=""; WANT=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --*) echo "✋ Unknown option $a" >&2; exit 1 ;;
    *) WANT="${a#v}" ;;
  esac
done

die() { echo "✋ $*" >&2; exit 1; }
say() { echo "▶ $*"; }

GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
CUR="$(git branch --show-current)"
IN_WORKTREE=""; [ "$GIT_DIR_ABS" != "$COMMON" ] && IN_WORKTREE=1

TMP=""; SRC=""; LOCK=""; W="$HERE"
cleanup() {
  for d in "$TMP" "$SRC"; do
    if [ -n "$d" ]; then git -C "$HERE" worktree remove --force "$d" >/dev/null 2>&1 || true; rm -rf "$d"; fi
  done
  if [ -n "$LOCK" ]; then rm -rf "$LOCK"; fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 1. guards
git fetch -q origin || die "Could not reach GitHub (git fetch failed). Check the internet and try again."

if [ -z "$DRY" ]; then
  [ -z "$IN_WORKTREE" ] || die "Promoting happens ONLY from the main folder:
   $(dirname "$COMMON")
   (here you can safely preview with:  ./ship.sh --promote --dry-run)"
  [ "$CUR" = "main" ] || die "The main folder is on branch '$CUR', not 'main'. Run:  git switch main"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "The main folder has loose changes. Move them to a branch first (see ship.sh)."
  LOCK="$COMMON/ship.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    OLDPID="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
      LOCK=""; die "A ship is running right now (process $OLDPID). Wait for it to finish, then try again."
    fi
    rm -rf "$LOCK"; mkdir "$LOCK"
  fi
  echo $$ > "$LOCK/pid"
else
  say "DRY RUN — working in a throwaway copy; main, GitHub and the friends are not touched."
  TMP="$(mktemp -d)"; rm -rf "$TMP"
  git worktree add -q --detach "$TMP" main
  W="$TMP"
fi
G() { git -C "$W" "$@"; }

G merge --ff-only -q origin/main 2>/dev/null || die "Local 'main' and GitHub's 'main' have diverged. Ask for help (nothing was changed)."
AHEAD="$(G rev-list --count origin/main..HEAD)"
if [ "$AHEAD" -gt 0 ]; then
  # An interrupted promote (committed, not pushed) is finished by running the same command again.
  if G log -1 --format=%s | grep -q '^Promote release '; then
    say "Finishing an interrupted promote (committed but not pushed)."
    RESUME=1
  else
    die "main has $AHEAD commit(s) not on GitHub yet (an interrupted ship). Finish it first with:  ./ship.sh"
  fi
else
  RESUME=""
fi

# ----------------------------------------------- 2. which release, and is it fit
if [ -z "$RESUME" ]; then
  if [ -z "$WANT" ]; then
    REF="$(G rev-parse HEAD)"
    REL="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('release',''))" "$W/docs/version.json")"
  else
    echo "$WANT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "Give a release like 0.22.1 (or nothing to promote what is live now)."
    G rev-parse -q --verify "refs/tags/v$WANT^{commit}" >/dev/null || die "There is no release v$WANT (see them with: git tag)."
    REF="$(G rev-parse "refs/tags/v$WANT^{commit}")"; REL="$WANT"
  fi
  [ -n "$REL" ] || die "That version has no release number."

  SRC="$(mktemp -d)"; rm -rf "$SRC"
  git worktree add -q --detach "$SRC" "$REF"
  grep -q 'etSiteUrl' "$SRC/docs/index.html" || die "Release $REL cannot run from stable/ yet (it is older than the stable/live split). Promote a newer one."

  say "Promoting release $REL ($(echo "$REF" | cut -c1-7)). Running its backend tests…"
  LOG1="$(mktemp)"; LOG2="$(mktemp)"
  (cd "$SRC" && node --test tests/backend/ > "$LOG1" 2>&1) || { tail -40 "$LOG1"; die "Tests FAILED for release $REL — nothing was changed."; }
  grep -E "^ℹ (tests|pass|fail)" "$LOG1" || true
  (cd "$SRC" && GMAIL_READER=readonly node --test tests/backend/ > "$LOG2" 2>&1) || { tail -40 "$LOG2"; die "Tests FAILED with the new e-mail reader for release $REL — nothing was changed."; }

  PIN="$(git -C "$SRC" log -1 --format=%H -- backend/)"
  [ -n "$PIN" ] || die "Could not find the backend commit for release $REL."
  OLDPIN="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pin',''))" "$W/docs/setup/pin.json" 2>/dev/null || true)"

  # ------------------------------------------------- 3. copy the screens
  say "Copying release $REL's screens into docs/stable/…"
  rm -rf "$W/docs/stable"; mkdir -p "$W/docs/stable"
  rsync -a --exclude='/setup/' --exclude='/setup-test/' --exclude='/vendor/' --exclude='/stable/' "$SRC/docs/" "$W/docs/stable/"
  sed -i '' -E 's/(<meta name="app-channel" content=")[^"]*"/\1stable"/' "$W/docs/stable/index.html"
  grep -q '<meta name="app-channel" content="stable">' "$W/docs/stable/index.html" || die "Could not mark stable/index.html as the stable copy — nothing was published."
  [ -f "$W/docs/stable/version.json" ] && [ -f "$W/docs/stable/app.js" ] || die "The copy in stable/ is incomplete — nothing was published."

  # ------------------------------------------------- 4. the matching backend
  printf '{ "pin": "%s" }\n' "$PIN" > "$W/docs/setup/pin.json"

  G add -A docs/stable docs/setup/pin.json
  if [ -z "$(G status --porcelain docs/stable docs/setup/pin.json)" ]; then
    say "Nothing to change: friends already have release $REL with this backend."
    exit 0
  fi
  G commit -q -m "Promote release $REL to friends (stable/, backend pin $(echo "$PIN" | cut -c1-7))

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
else
  REL="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('release',''))" "$W/docs/stable/version.json")"
  PIN="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('pin',''))" "$W/docs/setup/pin.json")"; OLDPIN="$PIN"
fi

# --------------------------------------------------------------- 5. publish
if [ -n "$DRY" ]; then
  say "[dry-run] would push to GitHub and tag stable-v$REL. Files that would go out:"
  G diff --stat origin/main HEAD | tail -5
  [ "$OLDPIN" = "$PIN" ] && say "The backend pin would stay at $(echo "$PIN" | cut -c1-7)." || say "The backend pin would move $(echo "$OLDPIN" | cut -c1-7) → $(echo "$PIN" | cut -c1-7): friends would be offered 'Update my app'."
  say "DRY RUN OK."
else
  say "Pushing to GitHub…"
  git push -q origin main || die "git push failed. Re-run  ./ship.sh --promote  to retry the push."
  if ! git rev-parse -q --verify "refs/tags/stable-v$REL" >/dev/null; then
    git tag -a "stable-v$REL" -m "Friends' release $REL" && git push -q origin "stable-v$REL" || echo "⚠ Could not tag stable-v$REL (the promote itself is fine)."
  fi
  FLOG="$HERE/../FRIENDS_VERSIONS.md"
  if [ ! -f "$FLOG" ]; then
    printf '# What friends are on (one line per promote)\n\n| Date | Release | Backend pin | Note |\n|---|---|---|---|\n' > "$FLOG"
  fi
  echo "| $(date +%Y-%m-%d) | $REL | $(echo "$PIN" | cut -c1-7) | promoted |" >> "$FLOG"
  say "DONE. Friends are on release $REL (screens in stable/, backend pin $(echo "$PIN" | cut -c1-7))."
  [ "$OLDPIN" = "$PIN" ] || echo "Their backend pin moved, so the app will offer them 'Update my app' (More tab)."
  echo "They get the usual 'tap to reload' banner. Update 'Friends and their versions.md'."
fi
