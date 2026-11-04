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
programmed items in every state, and legacy PAUSED items for the heal (`NO_DEMO=1` leaves them out; the automated tests never use them). `FRIEND_COPY=1` behaves like a friend's copy
(the heal runs on its first open; on the default copy the app converts once for the owner). `EMPTY=1 FRIEND_COPY=1` starts like a brand-new
person's copy: only the starter categories and banks, the built-in Cash account, no friends, no entries (the welcome questions show first). Open `http://<this computer>:<port>/login` once to sign a browser in (works from a phone on
the same Wi-Fi). Restart the server to get the data back exactly as it was.
