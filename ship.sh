#!/bin/bash
# ship.sh — the ONE way to publish work (replaces the old deploy.sh).
#
# Why it exists: several chats can work at the same time. Each chat works in
# its OWN git worktree/branch; nothing is published until it is "shipped" from
# the main folder, which only ever contains work that has been merged.
#
# Usage (real, from the main folder, on branch main):
#   ./ship.sh <branch> "commit message" [--minor | --major | --release X.Y.Z]
#       release number (shown in More, logged in ../VERSIONS.md, tagged vX.Y.Z in git):
#       no flag = patch (small fix, 0.9.1 → 0.9.2); --minor = new feature (0.9.2 → 0.10.0);
#       --major = big milestone (0.10.0 → 1.0.0); --release sets it exactly.
#       Only ships that change docs/ get a new number. The very first one is 0.9.0.
#   ./ship.sh                      finish an interrupted ship (merged but not pushed)
# Preview (safe from ANYWHERE — works in a throwaway copy, touches nothing):
#   ./ship.sh [<branch>] "commit message" --dry-run
#
# What it does, in order (stops at the first problem; nothing is half-done):
#   1. guards: main folder only, on main, no loose changes, one ship at a time
#   2. merges <branch> into main (a conflict stops here, main is left as it was)
#   3. runs the backend tests twice (a failure undoes the merge)
#   4. bumps docs/version.json + the ?v= in docs/index.html if the app changed
#      (chats must NEVER touch those two — only this script does)
#   5. clasp push + clasp deploy to the live deployment if backend/ changed
#   6. git push (GitHub Pages then serves docs/)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

DRY=""; POS=(); KIND="patch"; SETREL=""; EXPECT_REL=""
for a in "$@"; do
  if [ -n "$EXPECT_REL" ]; then SETREL="$a"; EXPECT_REL=""; continue; fi
  case "$a" in
    --dry-run) DRY=1 ;;
    --minor) KIND="minor" ;;
    --major) KIND="major" ;;
    --release) EXPECT_REL=1 ;;
    *) POS+=("$a") ;;
  esac
done
[ -z "$EXPECT_REL" ] || { echo "✋ --release needs a number, e.g. --release 1.0.0" >&2; exit 1; }
if [ -n "$SETREL" ] && ! echo "$SETREL" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "✋ --release must look like 1.4.2 (three numbers with dots)." >&2; exit 1
fi
BRANCH="${POS[0]:-}"; MSG="${POS[1]:-}"

die() { echo "✋ $*" >&2; exit 1; }
say() { echo "▶ $*"; }

GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
CUR="$(git branch --show-current)"
IN_WORKTREE=""; [ "$GIT_DIR_ABS" != "$COMMON" ] && IN_WORKTREE=1

# A dry run from inside a chat's own worktree may leave the branch (and the message) out.
if [ -n "$DRY" ] && [ -n "$CUR" ] && [ "$CUR" != "main" ]; then
  if [ -z "$BRANCH" ]; then BRANCH="$CUR"
  elif ! git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null && [ -z "$MSG" ]; then MSG="$BRANCH"; BRANCH="$CUR"; fi
fi
[ -z "$DRY" ] || MSG="${MSG:-dry run}"

TMP=""; LOCK=""; W="$HERE"
cleanup() {
  if [ -n "$TMP" ]; then git -C "$HERE" worktree remove --force "$TMP" >/dev/null 2>&1 || true; rm -rf "$TMP"; fi
  if [ -n "$LOCK" ]; then rm -rf "$LOCK"; fi
}
trap cleanup EXIT

untracked_code() { git -C "$1" status --porcelain | grep -E '^\?\? (backend|docs|tests|cloudflare-worker)/' || true; }

# ---------------------------------------------------------------- 1. guards
git fetch -q origin || die "Could not reach GitHub (git fetch failed). Check the internet and try again."

if [ -z "$DRY" ]; then
  [ -z "$IN_WORKTREE" ] || die "This is a chat's own working copy. Shipping happens ONLY from the main folder:
   $(dirname "$COMMON")
   (here you can safely preview with:  ./ship.sh --dry-run)"
  [ "$CUR" = "main" ] || die "The main folder is on branch '$CUR', not 'main'. Run:  git switch main
   (if you have uncommitted work here, first commit it on its own branch: git switch -c <name> && git add -A && git commit)"
  DIRTY="$(git status --porcelain --untracked-files=no)"; UNT="$(untracked_code "$HERE")"
  if [ -n "$DIRTY$UNT" ]; then
    echo "$DIRTY"; echo "$UNT"
    die "The main folder has loose changes (listed above) that are not part of any branch.
   They would be published by accident. Move them to a branch first:
     git switch -c <a-name> && git add -A && git commit -m \"...\" && git switch main
   then ship that branch:  ./ship.sh <a-name> \"message\""
  fi
  LOCK="$COMMON/ship.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    OLDPID="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
      LOCK=""; die "Another ship is running right now (process $OLDPID). Wait for it to finish, then try again."
    fi
    rm -rf "$LOCK"; mkdir "$LOCK"   # stale lock from a crashed ship
  fi
  echo $$ > "$LOCK/pid"
else
  say "DRY RUN — working in a throwaway copy; main, GitHub and Google are not touched."
  TMP="$(mktemp -d)"; rm -rf "$TMP"
  git worktree add -q --detach "$TMP" main
  W="$TMP"
fi
G() { git -C "$W" "$@"; }

G merge --ff-only -q origin/main 2>/dev/null || die "Local 'main' and GitHub's 'main' have diverged. Ask for help before shipping (nothing was changed)."
AHEAD="$(G rev-list --count origin/main..HEAD)"

RESUME=""
if [ -z "$BRANCH" ]; then
  [ "$AHEAD" -gt 0 ] || die "Usage: ./ship.sh <branch> \"commit message\"   (add --dry-run to preview)"
  RESUME=1
  say "Finishing an interrupted ship ($AHEAD commit(s) on main not yet on GitHub)."
else
  [ "$AHEAD" -eq 0 ] || die "An earlier ship was interrupted ($AHEAD commit(s) on main are not on GitHub yet). Finish it first with:  ./ship.sh"
  [ -n "$MSG" ] || die "Usage: ./ship.sh $BRANCH \"commit message\"   (the message is required)"
  [ "$BRANCH" != "main" ] || die "Give the chat's branch name, not 'main'."
  git rev-parse --verify -q "refs/heads/$BRANCH" >/dev/null || die "There is no branch called '$BRANCH'. (See them with: git branch)"
  # The branch's own working copy must be fully committed — otherwise part of the work would be left behind.
  BWT="$(git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '/^worktree /{p=substr($0,10)} $0=="branch " b {print p}')"
  if [ -n "$BWT" ] && [ "$BWT" != "$HERE" ]; then
    BD="$(git -C "$BWT" status --porcelain --untracked-files=no)"; BU="$(untracked_code "$BWT")"
    if [ -n "$BD$BU" ]; then
      echo "$BD"; echo "$BU"
      die "Branch '$BRANCH' has changes that are not committed yet (listed above, in $BWT).
   Commit them first (git add -A && git commit) — new files must be added too — then ship again."
    fi
  fi
  G merge-base --is-ancestor "refs/heads/$BRANCH" HEAD && die "Branch '$BRANCH' has nothing new — it is already in main."
fi

# ----------------------------------------------------------------- 2. merge
PRE="$(G rev-parse HEAD)"
rollback() { G reset --hard -q "$PRE"; }
if [ -z "$RESUME" ]; then
  say "Merging '$BRANCH' into main…"
  if ! G merge --no-ff -q -m "$MSG

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" "refs/heads/$BRANCH" >/dev/null 2>&1; then
    CONF="$(G diff --name-only --diff-filter=U | sed 's/^/     /')"
    G merge --abort >/dev/null 2>&1 || true
    die "'$BRANCH' conflicts with newer work already in main (main was left untouched). Files:
$CONF
   Fix it in the chat that owns '$BRANCH':  git merge main   → resolve → re-test → commit → then ship again."
  fi
fi

# ---------------------------------------------------------------- 3. tests
say "Running backend tests…"
LOG1="$(mktemp)"; LOG2="$(mktemp)"
if ! (cd "$W" && node --test tests/backend/ > "$LOG1" 2>&1); then
  tail -40 "$LOG1"; [ -z "$RESUME" ] && rollback
  die "Tests FAILED — nothing was published$([ -z "$RESUME" ] && echo "; the merge was undone")."
fi
grep -E "^ℹ (tests|pass|fail)" "$LOG1"
if ! (cd "$W" && GMAIL_READER=readonly node --test tests/backend/ > "$LOG2" 2>&1); then
  tail -40 "$LOG2"; [ -z "$RESUME" ] && rollback
  die "Tests FAILED with the new e-mail reader — nothing was published$([ -z "$RESUME" ] && echo "; the merge was undone")."
fi
grep -E "^ℹ (pass|fail)" "$LOG2" | sed 's/^/  (new e-mail reader) /'

# ------------------------------------------------------ 4. version bump
CHANGED="$(G diff --name-only origin/main HEAD)"
if echo "$CHANGED" | grep -E '^docs/.*\.(html|js|css)$' | grep -qv 'version.json'; then
  OLD="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$W/docs/version.json")"
  NEW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # Release number (MAJOR.MINOR.PATCH): none recorded yet → this ship is 0.9.0.
  REL="$(python3 -c "
import json,sys,re
old=json.load(open(sys.argv[1])).get('release'); kind,setrel=sys.argv[2],sys.argv[3]
if setrel: print(setrel)
elif not old: print('0.9.0')
else:
    a,b,c=map(int,old.split('.'))
    print({'major':'%d.0.0'%(a+1),'minor':'%d.%d.0'%(a,b+1),'patch':'%d.%d.%d'%(a,b,c+1)}[kind])
" "$W/docs/version.json" "$KIND" "$SETREL")"
  say "Bumping app version $OLD → $NEW (release $REL)"
  sed -i '' "s/$OLD/$NEW/g" "$W/docs/index.html"
  sed -i '' -E "s/(<meta name=\"app-release\" content=\")[^\"]*\"/\1$REL\"/" "$W/docs/index.html"
  grep -q "<meta name=\"app-release\" content=\"$REL\"" "$W/docs/index.html" || { [ -z "$RESUME" ] && rollback; die "index.html's app-release tag did not take the release number — nothing was published."; }
  echo "{ \"version\": \"$NEW\", \"release\": \"$REL\" }" > "$W/docs/version.json"
  TOTAL="$(grep -c '?v=' "$W/docs/index.html" || true)"; GOOD="$(grep -c "?v=$NEW" "$W/docs/index.html" || true)"
  [ "$TOTAL" = "$GOOD" ] && [ "$GOOD" -gt 0 ] || { [ -z "$RESUME" ] && rollback; die "index.html's ?v= tags did not all take the new version ($GOOD of $TOTAL) — nothing was published."; }
  G add docs/index.html docs/version.json
  G commit -q -m "Version bump $NEW (release $REL)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
else
  say "No app (docs/) changes — version not bumped."
  [ "$KIND" = "patch" ] && [ -z "$SETREL" ] || echo "⚠ --minor/--major/--release ignored: no app (docs/) changes, so there is no new release number."
fi

# ------------------------------------------------------- 5. backend (Google)
if echo "$CHANGED" | grep -q '^backend/'; then
  if [ -n "$DRY" ]; then
    say "[dry-run] would run: clasp push -f && clasp deploy -i <live id> (backend/ changed)"
  else
    ID_FILE="$HERE/../deploy-id.txt"
    [ -f "$ID_FILE" ] || die "Missing $ID_FILE (live deployment id). Merged on main but NOT published; fix and re-run ./ship.sh"
    [ -f "$HERE/backend/.clasp.json" ] || die "Missing backend/.clasp.json in the main folder. Merged on main but NOT published; fix and re-run ./ship.sh"
    DEPLOY_ID="$(tr -d '[:space:]' < "$ID_FILE")"
    say "Uploading backend to Google and pointing the live deployment at it…"
    (cd "$HERE/backend" && clasp push -f && clasp deploy -i "$DEPLOY_ID" -d "${MSG:-ship}") \
      || die "Google upload failed. Main has the merge but nothing is on GitHub; fix the problem and re-run ./ship.sh (no arguments) to finish."
  fi
else
  say "No backend changes — skipping Google upload."
fi
if echo "$CHANGED" | grep -q '^cloudflare-worker/'; then
  echo "⚠ cloudflare-worker/ changed: that file must still be pasted into Cloudflare by hand."
fi

# ------------------------------------------------------------- 6. publish
if [ -n "$DRY" ]; then
  say "[dry-run] would run: git push origin main. Files that would go out:"
  echo "$CHANGED" | sed 's/^/     /'
  say "DRY RUN OK — everything above passed in the throwaway copy."
else
  say "Pushing to GitHub…"
  git push -q origin main || die "git push failed. Everything is deployed to Google; re-run ./ship.sh (no arguments) to retry the push."
  # Release bookkeeping (a failure here never undoes the ship): git tag vX.Y.Z + one line in ../VERSIONS.md.
  if git log -1 --format=%s | grep -q '^Version bump '; then
    REL="$(python3 -c "import json;print(json.load(open('docs/version.json')).get('release',''))")"
    if [ -n "$REL" ] && ! git rev-parse -q --verify "refs/tags/v$REL" >/dev/null; then
      git tag -a "v$REL" -m "Release $REL" && git push -q origin "v$REL" || echo "⚠ Could not tag/push v$REL (the ship itself is fine)."
      VLOG="$HERE/../VERSIONS.md"
      if [ -f "$VLOG" ] && ! grep -q "^| $REL |" "$VLOG"; then
        SUBJ="$(git log -2 --format=%s | sed -n 2p | tr '|' '/')"
        echo "| $REL | $(date +%Y-%m-%d) | $SUBJ |" >> "$VLOG"
      fi
      say "Release $REL (tag v$REL)."
    fi
  fi
  say "DONE. Shipped:"
  echo "$CHANGED" | sed 's/^/     /'
  echo "Other chats still open: they should run 'git merge main' in their own folder before their next ship."
fi
