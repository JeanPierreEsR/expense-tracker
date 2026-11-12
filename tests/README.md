# Tests (fake backend, made-up data)

Runs the REAL backend (`backend/*.gs`) against an in-memory imitation of Google
(`tests/harness/fake-google.js`) filled with ~7,000 made-up entries
(`tests/harness/seed.js`). Nothing touches Google, Telegram or real data.

| Command | What it does |
|---|---|
| `node --test tests/backend/` | All regression tests (also run by `ship.sh`; a failure blocks the ship) |
| `node tests/perf-report.js` | Sheet reads per request — the number that predicts real slowness |
| `node tests/harness/server.js` | The real app on http://localhost:4180 against the fake backend (access code `test-access-code`) |
| `BACKEND_DIR=/path/to/old/backend node --test tests/backend/` | Run the tests against an older copy, to prove a new test fails on the old bug |

If a test fails with `FAKE-GOOGLE: ... not supported`, the backend started using
a Google feature the fake lacks — add it to `fake-google.js`.
The fake is much faster than real Sheets, so wall-clock times understate the
real app; compare read COUNTS instead. It also can't cover real Gmail, Telegram
or iPhone behaviour.

**Demo data for trying features by hand (2026-11-01).** `node tests/harness/server.js` also adds made-up demo scenarios (`tests/harness/demo-data.js`): friends to delete / hide / keep,
programmed items in every state, and legacy PAUSED items for the heal (`NO_DEMO=1` leaves them out; the automated tests never use them). **Since 2026-11-07 the six paused items (and the forced "Pause has been replaced" sheet they open at every start, which blocks every tab) come only with `PAUSE_DEMO=1`**; the demo shared rent is saved through the real split save, so its friend's share is a debt in Loans too. `POST /__pending` with `{description, amount, currency?, category? (name or id), date?, type?}` adds an entry waiting in Needs review, as if a bank e-mail had brought it (the app's own saves are always confirmed). `version.json` is served as it was when the server started, so a ship by another chat no longer shows the "tap to reload" banner on an open test copy; `LIVE_VERSION=1` serves the real file. `FRIEND_COPY=1` behaves like a friend's copy
(the heal runs on its first open; on the default copy the app converts once for the owner). `EMPTY=1 FRIEND_COPY=1` starts like a brand-new
person's copy: only the starter categories and banks, the built-in Cash account, no friends, no entries (the welcome questions show first).
**Categories (owner, 2026-11-04):** the blank copy (`EMPTY=1`) is built the way the installer builds one — the SHORT starter list (8 expense +
5 income) and the bank catalogue — so the welcome's "What fits me" decides the rest. The everyday copies (no `EMPTY`) use the categories
a person gets by ticking EVERY "What fits me" choice (starter list + one per pick; Settings `profile` = all picks), and the made-up entries
are spread over those. `OWNER_CATEGORIES=1` brings back the owner's own long list. Open `http://<this computer>:<port>/login` once to sign a browser in (works from a phone on
the same Wi-Fi). Restart the server to get the data back exactly as it was. **Friend-style copy and "owner's copy" (2026-11-04):** the server rewrites the owner's web address in `app.js` to `/api`, and the app treats a copy using exactly the owner's address as the owner's (`perfIsOwnerCopy_`), so friends-only rows (Feedback & privacy and others) stayed hidden even with `FRIEND_COPY=1`. With `FRIEND_COPY=1` the `/login` page now also stores a full address (`<origin>/api`), so the app sees a friend's phone; open `/login` again on a copy started before this change. In a desktop browser the same is `localStorage.setItem("apiUrl", location.origin + "/api")`.

## Screen-fit check (2026-11-07)

`node tests/screen-fit/check.js` starts its own test server on a free port, opens the real app at 375 px wide (iPhone SE 2nd/3rd gen,
12/13 mini) in English and then Spanish, and goes through Home, Overview, Budgets, Projections, Loans, More, the new-entry window and
every More screen (My data's screens included). It lists anything that runs off the right edge, text cut by its box, and any number
shortened with "…" (a name may be; an amount may not). `ship.sh` runs it before publishing an app change and stops on a finding; it
only measures, so a screen that fits but looks crowded is the testers' job. `WIDTH=320` tries another width by hand;
`SCREEN_FIT_SELFTEST=1` adds a too-wide box to every screen to prove the check still sees one. It needs Playwright, installed once
outside the repo: `npm install --prefix ~/.expense-tracker-tools playwright@1.65.0` then, in that folder, `npx playwright install
chromium-headless-shell`. Without it, `ship.sh` warns and ships anyway. A new More screen: add its row's id to `MORE_ROWS` (or
`MY_DATA_ROWS`) in the script.

**Edit-mode bars (2026-11-12):** it also takes every Edit-mode bar (`.friends-editbar`: Home, Needs review, Budgets, Programmed
items, Accounts, Categories, Trips, Companies, People, Friends) and tries EVERY combination of the labels its buttons can show, with
big counts ("Select all 99999 matches", "Delete (999)", Home with and without Change), and fails on two buttons overlapping, one
running off the bar, a cut label or a button under 44 px. A new label for a bar button goes in `SLOTS` (every bar) or `EXTRA` (one
button) in the script.

**`REAL_NEW=1` (2026-11-09, with `FRIEND_COPY=1`):** opening `/login` makes this browser look like a person who finished the welcome and the first entry and has met no real tutorial yet, so Needs review and transfers can be tried on the demo data. Opening `/login` again starts over.

**`POP_MONTH_OLD=1` (2026-11-09):** opening `/login` also makes this browser count as having used the app for 40 days, and gets every pop-up tip again with no 3-visit wait and no daily limit for that day, so all of them can be walked at once on a test copy (open `/login` again the next day). Since 2026-11-11 it also restarts every bubble series, offers the idle bubbles again (7 seconds since 2026-11-12), and makes the Projections method reminder due (as if 6 complete months had been reached 20 days ago). Since 2026-11-12 it also passes the basics gate (8 active days, 40 entries), makes the receipt-photo and bring-back moments due, and sets Overview and Projections to their 2nd visit, so the month-bars and own-amount bubbles come on the next one. **`SKIP_WELCOME=1` (2026-11-11):** opening `/login` marks the welcome screens as done, so a friend-style copy opens straight on Home.
