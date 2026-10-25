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
#   3. copies its screens into docs/stable/ (not setup/, setup-test/, vendor/) and marks them "stable"; if the backend pin moves, the screens
#      friends had until now are first kept as docs/stable-<pin>/ ("paired screens": a friend whose backend is not updated yet keeps the screens tested with it)
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

# Paired screens helpers.
# set_metas FILE PIN PAIRS ARCHIVED_AT — writes the app-pin / app-pairs / app-archived tags right after the app-channel tag of an index.html
# (PAIRS = comma list of kept older pins, first 7 letters each; ARCHIVED_AT empty = this is the current stable/ copy, not a kept older one).
set_metas() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import re, sys
f, pin, pairs, arch = sys.argv[1:5]
s = open(f).read()
s = re.sub(r'[ \t]*<meta name="app-(pin|pairs|archived)"[^>]*>\n?', '', s)
tags = '<meta name="app-pin" content="%s">' % pin
if arch: tags += '<meta name="app-archived" content="%s">' % arch
elif pairs: tags += '<meta name="app-pairs" content="%s">' % pairs
s, n = re.subn(r'(<meta name="app-channel" content="stable">)', lambda m: m.group(1) + tags, s, count=1)
if n != 1: sys.exit("no app-channel tag")
open(f, 'w').write(s)
PY
}
# kept_pairs ROOT KEEP COPIES_JSON — prunes the older kept copies and prints the ones that stay as a comma list. A copy stays when it is among the
# newest KEEP (by when it was kept) OR a friend used it in the last 30 days (COPIES_JSON, written by tools/friends-copies.py from the app-speed
# reports; absent = nobody is known to use any). What it removes and what it keeps because someone still uses it goes to stderr.
kept_pairs() {
  python3 - "$1" "$2" "$3" <<'PY'
import datetime, glob, json, os, re, shutil, sys
root, keep, copies = sys.argv[1], int(sys.argv[2]), sys.argv[3]
STALE_DAYS = 30
inuse = {}
try:
    data = json.load(open(copies))
    today = datetime.date.today()
    for pin, v in (data.get('pins') or {}).items():
        try: age = (today - datetime.date.fromisoformat(v.get('lastSeen', ''))).days
        except ValueError: continue
        if age <= STALE_DAYS: inuse[pin[:7]] = v
except (OSError, ValueError): pass
found = []
for d in glob.glob(os.path.join(root, 'docs', 'stable-*')):
    try: m = re.search(r'name="app-archived" content="([^"]*)"', open(os.path.join(d, 'index.html')).read())
    except OSError: m = None
    found.append((m.group(1) if m else '', d))
found.sort(reverse=True)
kept = []
for i, (_, d) in enumerate(found):
    pin = os.path.basename(d)[len('stable-'):]
    if i < keep or pin in inuse:
        kept.append(d)
        if i >= keep: print('Keeping %s: %d friend phone(s) used it in the last %d days.' % (os.path.basename(d), inuse[pin].get('installs', 1), STALE_DAYS), file=sys.stderr)
    else:
        shutil.rmtree(d)
        print('Removing %s: no friend is known to use it.' % os.path.basename(d), file=sys.stderr)
print(','.join(os.path.basename(d)[len('stable-'):] for d in kept))
PY
}

# in_use_pins COPIES_JSON — the pins (7 letters) a friend used in the last 30 days, one per line (nothing when there is no list).
in_use_pins() {
  python3 - "$1" <<'PY'
import datetime, json, sys
try:
    data = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    sys.exit(0)
today = datetime.date.today()
for pin, v in (data.get('pins') or {}).items():
    try: age = (today - datetime.date.fromisoformat(v.get('lastSeen', ''))).days
    except ValueError: continue
    if age <= 30: print(pin[:7])
PY
}

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
  # Paired screens: when the backend pin moves, the screens friends had until now stay available as stable-<first 7 of the old pin>/, so a friend whose
  # backend is not updated yet keeps running the screens that were tested with it (at most KEEP such copies; the oldest go).
  PAIRS_KEEP=3
  # Who still uses a kept copy: tools/friends-copies.py writes this list from the app-speed reports. With the list the newest 2 stay as a safety
  # net (friends who share nothing cannot be seen) plus every copy used in the last 30 days; without it the newest 3 stay.
  COPIES_FILE="${FRIENDS_COPIES_FILE:-$(dirname "$COMMON")/../FRIENDS_COPIES.json}"
  if [ -f "$COPIES_FILE" ]; then
    PAIRS_KEEP=2
    [ -n "$(find "$COPIES_FILE" -mtime +14 2>/dev/null)" ] && echo "⚠ The list of copies friends use is over 14 days old: refresh it first (download the Sheet's 'Perf Reports' tab as CSV and run tools/friends-copies.py), or a copy a friend moved onto since could be removed." >&2
  fi
  if [ -n "$OLDPIN" ] && [ "$OLDPIN" != "$PIN" ] && [ -f "$W/docs/stable/index.html" ]; then
    A="$W/docs/stable-$(echo "$OLDPIN" | cut -c1-7)"
    say "The backend pin moves, so the screens friends have now are kept as $(basename "$A")/ for friends who have not updated."
    rm -rf "$A"; mkdir -p "$A"; rsync -a "$W/docs/stable/" "$A/"
    # milliseconds, so two promotes in the same second still sort in the order they happened
    set_metas "$A/index.html" "$OLDPIN" "" "$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%f')[:18] + 'Z')")"
  fi
  rm -rf "$W/docs/stable-$(echo "$PIN" | cut -c1-7)"   # the copy for the pin being promoted is stable/ itself
  rm -rf "$W/docs/stable"; mkdir -p "$W/docs/stable"
  rsync -a --exclude='/setup/' --exclude='/setup-test/' --exclude='/vendor/' --exclude='/stable/' --exclude='/stable-*/' "$SRC/docs/" "$W/docs/stable/"
  sed -i '' -E 's/(<meta name="app-channel" content=")[^"]*"/\1stable"/' "$W/docs/stable/index.html"
  grep -q '<meta name="app-channel" content="stable">' "$W/docs/stable/index.html" || die "Could not mark stable/index.html as the stable copy — nothing was published."
  [ -f "$W/docs/stable/version.json" ] && [ -f "$W/docs/stable/app.js" ] || die "The copy in stable/ is incomplete — nothing was published."
  # A copy a friend still uses is never lost: if an earlier promote already removed it (before the list existed), it is brought back
  # from the commit that removed it, as it was.
  if [ -f "$COPIES_FILE" ]; then
    for P in $(in_use_pins "$COPIES_FILE"); do
      [ "$P" = "$(echo "$PIN" | cut -c1-7)" ] && continue                 # that is stable/ itself
      [ -d "$W/docs/stable-$P" ] && continue
      GONE="$(G log -1 --diff-filter=D --format=%H -- "docs/stable-$P" 2>/dev/null || true)"
      if [ -n "$GONE" ]; then
        say "Bringing back stable-$P/: a friend used it in the last 30 days and an earlier promote had removed it."
        G checkout -q "$GONE^" -- "docs/stable-$P"
      fi
    done
  fi
  PAIRS="$(kept_pairs "$W" "$PAIRS_KEEP" "$COPIES_FILE")"
  set_metas "$W/docs/stable/index.html" "$PIN" "$PAIRS" ""

  # ------------------------------------------------- 4. the matching backend
  printf '{ "pin": "%s" }\n' "$PIN" > "$W/docs/setup/pin.json"

  # 'docs/stable-*' (a pattern, not a list of folders) also stages the copies kept_pairs just pruned: a folder that no longer exists cannot be
  # listed by name, and without this the removal stayed on disk as loose changes in the main folder after every promote (found 2026-10-24).
  PATHS=(docs/stable docs/setup/pin.json)
  # (git refuses a pattern that matches nothing at all, e.g. the very first promote, so it is added only when some copy exists or existed.)
  if [ -n "$(G ls-files -- 'docs/stable-*')" ] || ls -d "$W"/docs/stable-*/ >/dev/null 2>&1; then PATHS+=('docs/stable-*'); fi
  G add -A -- "${PATHS[@]}"
  if [ -z "$(G status --porcelain -- "${PATHS[@]}")" ]; then
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
