// Checking alerts when the app is used (checkAlertsNow) and by the "open faster" timer (backend/Notices.gs § Checking alerts when the app is
// used). The alert checks used to run only inside the bank-e-mail job, so a copy without that extra never got an alert. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const LAST_KEY = "ALERT_CHECK_LAST_AT";
const overdueLoan = (rt, due = "2020-02-01", amount = 100) => {
  const friend = rt.rows("Friends")[0];
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount, currency: "PEN", date: "2020-01-01", due_date: due });
  return friend;
};
// A copy with no timer at all: only the base approval.
const noTimerApp = () => {
  const app = freshApp({ small: true });
  app.rt.svc.props.set("FEATURES", "base");
  return app;
};
const olderThan = (rt, ms) => rt.svc.props.set(LAST_KEY, String(Date.now() - ms));

test("a copy with no timer: the app's check finds the alert and answers with it in the same reply", () => {
  const { rt } = noTimerApp();
  const friend = overdueLoan(rt);
  assert.deepEqual(rt.api("listNotices").notices, [], "nothing looked yet");
  const out = rt.api("checkAlertsNow");
  assert.equal(out.ran, true);
  assert.ok(out.notices.some((n) => n.kind === "loan" && n.text.includes(friend.name)), "the notice is in the reply");
  assert.equal(rt.api("listNotices").notices.length, out.notices.length, "and stored");
});

test("a second check within two minutes is skipped, but still answers with the notices; after two minutes it runs again", () => {
  const { rt } = noTimerApp();
  const friend = overdueLoan(rt);
  rt.api("checkAlertsNow");
  const count = rt.rows("Notices").length;
  overdueLoan(rt, "2020-03-01", 50);
  const again = rt.api("checkAlertsNow");
  assert.equal(again.ran, false);
  assert.equal(again.reason, "recent");
  assert.equal(again.notices.length, count, "the new overdue loan is not looked at yet");
  olderThan(rt, 3 * 60 * 1000);
  const later = rt.api("checkAlertsNow");
  assert.equal(later.ran, true);
  assert.ok(later.notices.length > count, "now it is");
  assert.ok(friend);
});

test("right after a save the server waits only 30 seconds, so a crossing shows up fast", () => {
  const { rt } = noTimerApp();
  overdueLoan(rt);
  rt.api("checkAlertsNow");
  const count = rt.api("listNotices").notices.length;
  overdueLoan(rt, "2020-03-01", 50);
  olderThan(rt, 40 * 1000);
  assert.equal(rt.api("checkAlertsNow").ran, false, "opening the app 40 s later still waits (two minutes)");
  const out = rt.api("checkAlertsNow", { after_change: true });
  assert.equal(out.ran, true, "but a check right after a save goes through");
  assert.ok(out.notices.length > count);
  assert.equal(rt.api("checkAlertsNow", { after_change: true }).ran, false, "and not twice within 30 s");
});

test("the claim is written before the checks run, so a second caller arriving at once does not repeat them", () => {
  const { rt } = noTimerApp();
  overdueLoan(rt);
  // While the first check runs, a second request arrives: it must see the claim already there.
  rt.run("var __inner; var __orig = checkBudgets; checkBudgets = function () { __inner = checkAlertsGuarded_('app'); return __orig.apply(null, arguments); };");
  const out = rt.api("checkAlertsNow");
  assert.equal(out.ran, true);
  assert.equal(JSON.stringify(rt.run("__inner")), JSON.stringify({ ran: false, reason: "recent" }));
});

test("alerts only from now on still holds: on an existing copy the first app check writes old news down without a notice", () => {
  const { rt } = noTimerApp();
  rt.svc.props.delete("ALERTS_BASELINE_DONE");
  overdueLoan(rt);
  const out = rt.api("checkAlertsNow");
  assert.equal(out.ran, true);
  assert.deepEqual(out.notices, []);
  assert.ok(!rt.svc.ss.getSheetByName("Notices"));
  assert.ok(rt.rows("Loan Alert Log").length >= 1, "written down as already alerted");
});

test("with Telegram linked the same alert also goes there, once", () => {
  const { rt } = noTimerApp();
  linkTelegram(rt);
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 3 } });
  overdueLoan(rt);
  rt.api("checkAlertsNow");
  const sent = rt.svc.fetchLog.length;
  assert.ok(sent >= 1);
  olderThan(rt, 3 * 60 * 1000);
  rt.api("checkAlertsNow");
  assert.equal(rt.svc.fetchLog.length, sent, "logged, so not sent again");
});

test("a check that fails does not fail the call, and the other two still run", () => {
  const { rt } = noTimerApp();
  const friend = overdueLoan(rt);
  rt.run("checkBudgets = function () { throw new Error('boom'); };");
  const out = rt.api("checkAlertsNow");
  assert.equal(out.ran, true);
  assert.ok(out.notices.some((n) => n.text.includes(friend.name)), "the loan check still ran");
});

test("the timer's run and the app's run right after alert once (the alert log remembers)", () => {
  const { rt } = noTimerApp();
  overdueLoan(rt);
  rt.run("checkOverdueLoans()");                 // the timer's run
  const logged = rt.rows("Loan Alert Log").length;
  const loanNotices = () => rt.rows("Notices").filter((n) => n.kind === "loan").length;
  const noticeCount = loanNotices();
  assert.ok(noticeCount >= 1);
  rt.api("checkAlertsNow");                       // the app right after
  assert.equal(rt.rows("Loan Alert Log").length, logged);
  assert.equal(loanNotices(), noticeCount);
});

test("capabilities: a backend that can check alerts says so (older ones lack it, so the app never asks)", () => {
  const { rt } = noTimerApp();
  assert.equal(rt.api("getMeta").capabilities.alertCheck, true);
});

// ---- The "open faster" timer ----
function pingCopy(features) {
  const app = freshApp({ small: true });
  app.rt.svc.props.set("FEATURES", features);
  app.rt.svc.props.set("WEB_APP_URL", "https://example.test/exec");
  app.rt.state.fetchHandler = () => ({ ok: true });
  return app;
}

test("the open-faster timer also looks at the alerts, and at most about once an hour", () => {
  const { rt } = pingCopy("base,keepawake");
  overdueLoan(rt);
  rt.run("pingWebApp_()");
  assert.ok(rt.rows("Notices").length >= 1, "the first ping checked");
  overdueLoan(rt, "2020-03-01", 50);
  const count = rt.rows("Notices").length;
  rt.run("pingWebApp_()");
  assert.equal(rt.rows("Notices").length, count, "the next ping, five minutes later, left it alone");
  olderThan(rt, 51 * 60 * 1000);
  rt.run("pingWebApp_()");
  assert.ok(rt.rows("Notices").length > count, "an hour on it looks again");
});

test("where the bank-e-mail job runs, the open-faster timer stays out of the alert checks (the job has its own)", () => {
  const { rt } = pingCopy("base,keepawake,gmail");
  overdueLoan(rt);
  rt.run("pingWebApp_()");
  assert.ok(!rt.svc.ss.getSheetByName("Notices"));
  assert.equal(rt.svc.props.get(LAST_KEY) || "", "");
});

test("without the open-faster approval the ping does nothing at all", () => {
  const { rt } = pingCopy("base");
  overdueLoan(rt);
  rt.run("pingWebApp_()");
  assert.ok(!rt.svc.ss.getSheetByName("Notices"));
});

test("a ping inside the 15-minute job does not run the alert checks a second time", () => {
  const { rt } = pingCopy("base,keepawake");
  overdueLoan(rt);
  rt.run("runAutomation()");
  assert.equal(rt.svc.props.get(LAST_KEY) || "", "", "the job ran its own steps; the ping inside it stayed out");
});
