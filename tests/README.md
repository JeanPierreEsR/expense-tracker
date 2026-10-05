# Tests (fake backend, made-up data)

Runs the REAL backend (`backend/*.gs`) against an in-memory imitation of Google
(`tests/harness/fake-google.js`) filled with ~7,000 made-up entries
(`tests/harness/seed.js`). Nothing touches Google, Telegram or real data.

| Command | What it does |
|---|---|
| `node --test tests/backend/` | All regression tests (also run by `deploy.sh`; a failure blocks the deploy) |
| `node tests/perf-report.js` | Sheet reads per request — the number that predicts real slowness |
| `node tests/harness/server.js` | The real app on http://localhost:4180 against the fake backend (access code `test-access-code`) |
| `BACKEND_DIR=/path/to/old/backend node --test tests/backend/` | Run the tests against an older copy, to prove a new test fails on the old bug |

If a test fails with `FAKE-GOOGLE: ... not supported`, the backend started using
a Google feature the fake lacks — add it to `fake-google.js`.
The fake is much faster than real Sheets, so wall-clock times understate the
real app; compare read COUNTS instead. It also can't cover real Gmail, Telegram
or iPhone behaviour.
