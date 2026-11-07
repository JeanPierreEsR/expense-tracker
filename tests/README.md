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
