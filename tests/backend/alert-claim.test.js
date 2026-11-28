// One alert check at a time without holding the app's lock (backend/Notices.gs withAlertClaim_, owner 2026-11-28). The three alert
// checks used to hold the script-wide lock for their whole run, so saves waited behind them past the phone's 25 s and were resent.
// Now the lock is held only to set a claim marker and read a snapshot of the sheets. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const RUNNING = "ALERT_CHECK_RUNNING_AT";
const app = () => {
  const a = freshApp({ small: true });
  a.rt.svc.props.set("FEATURES", "base");
  return a;
};
const overdueLoan = (rt, due = "2020-02-01", amount = 100) => {
  const friend = rt.rows("Friends")[0];
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount, currency: "PEN", date: "2020-01-01", due_date: due });
  return friend;
};
const guarded = (rt) => JSON.parse(rt.run("JSON.stringify(checkAlertsGuarded_('app'))"));
// A script lock that records what was read while it was held.
const watchLock = (rt) => {
  rt.run(`var __lockLog = { held: false, takes: 0, readsHeld: 0, readsFree: 0 };
    LockService = { getScriptLock: function () { return {
      hasLock: function () { return __lockLog.held; },
      tryLock: function () { __lockLog.held = true; __lockLog.takes++; return true; },
      waitLock: function () { __lockLog.held = true; __lockLog.takes++; },
      releaseLock: function () { __lockLog.held = false; } }; } };
    var __readAll = readAllRows_;
    readAllRows_ = function (name) { if (__lockLog.held) __lockLog.readsHeld++; else __lockLog.readsFree++; return __readAll(name); };
    0`);
  return () => JSON.parse(rt.run("JSON.stringify(__lockLog)"));
};

test("the checks read their sheets while the lock is held, then run with the lock free", () => {
  const { rt } = app();
  overdueLoan(rt);
  const log = watchLock(rt);
  const out = rt.api("checkAlertsNow");
  assert.equal(out.ran, true);
  assert.ok(out.notices.some((n) => n.kind === "loan"), "the overdue loan is still found");
  const l = log();
  assert.equal(l.held, false, "the lock is let go");
  assert.equal(l.takes, 1, "one short turn for the three checks");
  assert.ok(l.readsHeld >= 5, "the snapshot is read under the lock");
  assert.ok(rt.svc.props.get(RUNNING) == null, "the claim is cleared after the run");
});

test("while another alert check runs, a second one stands down as busy and sends nothing", () => {
  const { rt } = app();
  overdueLoan(rt);
  rt.svc.props.set(RUNNING, String(Date.now()));
  rt.run("ALERT_CLAIM_WAIT_MS_ = 0; 0");
  const run = guarded(rt);
  assert.equal(run.failed, 3, "all three skipped");
  assert.equal(rt.svc.ss.getSheetByName("Notices"), null, "nothing sent twice (not even the Notices tab made)");
  assert.ok(rt.svc.props.get(RUNNING), "the other check's claim is left alone");
  assert.throws(() => rt.run("checkBudgets()"), (e) => /busy|moment|ocupad/i.test(String(e.message)), "a direct call is busy in plain words");
});

test("a claim left by a check cut off more than 7 minutes ago does not block the next one", () => {
  const { rt } = app();
  overdueLoan(rt);
  rt.svc.props.set(RUNNING, String(Date.now() - 8 * 60 * 1000));
  assert.equal(guarded(rt).failed, 0);
  assert.ok(rt.rows("Notices").some((n) => n.kind === "loan"));
  assert.ok(rt.svc.props.get(RUNNING) == null);
});

test("a check that throws still clears its claim", () => {
  const { rt } = app();
  rt.run("var __orig = checkBudgetsLocked_; checkBudgetsLocked_ = function () { throw new Error('boom'); }; 0");
  assert.equal(guarded(rt).failed, 1, "only the broken one");
  assert.ok(rt.svc.props.get(RUNNING) == null);
  assert.throws(() => rt.run("checkBudgets()"), /boom/);
  assert.ok(rt.svc.props.get(RUNNING) == null, "also on a direct call");
});

test("an alert is still sent once: running the checks again does not repeat it", () => {
  const { rt } = app();
  overdueLoan(rt);
  rt.run("checkOverdueLoans(); checkOverdueLoans(); 0");
  assert.equal(rt.rows("Notices").filter((n) => n.kind === "loan").length, 1);
  assert.equal(rt.rows("Loan Alert Log").length, 1);
});
