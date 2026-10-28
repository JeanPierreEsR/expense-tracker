// Checking bank e-mail when the app is opened (checkEmailsNow), the timer's guard against scanning twice in a row, and the
// per-step timings of the 15-minute run. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const pendingCount = (rt) => rt.api("listPendingEntries").length;

test("checkEmailsNow reads new bank e-mail and creates the pending entry at once", () => {
  const { rt } = freshApp({ small: true });
  const before = pendingCount(rt);
  bcpEmail(rt, { amount: "13.00", op: "910001" });
  const out = rt.api("checkEmailsNow");
  assert.equal(out.ran, true);
  assert.equal(out.created, 1);
  assert.equal(pendingCount(rt), before + 1);
});

test("a second check within a minute is skipped, and a timer run right after is skipped too", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("checkEmailsNow").ran, true);
  bcpEmail(rt, { amount: "14.00", op: "910002" });
  const again = rt.api("checkEmailsNow");
  assert.deepEqual({ ran: again.ran, reason: again.reason }, { ran: false, reason: "recent" });   // (the answer also carries `health`: email-health.test.js)
  rt.run("runAutomation()");
  assert.equal(pendingCount(rt) > 0 && rt.api("listPendingEntries").some((e) => /14\.00|910002/.test(JSON.stringify(e))), false, "the timer also waited");
  // a minute later the app's check goes through and finds it
  rt.svc.props.set("EMAIL_SCAN_LAST_AT", String(Date.now() - 61 * 1000));
  const later = rt.api("checkEmailsNow");
  assert.equal(later.ran, true);
  assert.equal(later.created, 1);
});

test("a scan that is already running makes the other one stand down; a crashed marker does not block forever", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("EMAIL_SCAN_RUNNING_AT", String(Date.now() - 10 * 1000));
  const busy = rt.api("checkEmailsNow");
  assert.deepEqual({ ran: busy.ran, reason: busy.reason }, { ran: false, reason: "busy" });
  rt.svc.props.set("EMAIL_SCAN_RUNNING_AT", String(Date.now() - 8 * 60 * 1000));
  assert.equal(rt.api("checkEmailsNow").ran, true, "a marker older than a run's limit is ignored");
  assert.equal(rt.svc.props.get("EMAIL_SCAN_RUNNING_AT") || "", "", "the marker is cleared afterwards");
});

test("without the bank-e-mail approval the check does nothing and never touches Gmail", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "keepawake");
  bcpEmail(rt, { amount: "15.00", op: "910003" });
  assert.deepEqual(rt.api("checkEmailsNow"), { ran: false, reason: "off" });
});

test("the timer still reads e-mail when nothing scanned recently", () => {
  const { rt } = freshApp({ small: true });
  const before = pendingCount(rt);
  bcpEmail(rt, { amount: "16.00", op: "910004" });
  rt.run("runAutomation()");
  assert.equal(pendingCount(rt), before + 1);
});

test("each run records how long its steps took (last 24 kept)", () => {
  const { rt } = freshApp({ small: true });
  rt.run("runAutomation()");
  const runs = rt.api("admin_automationTimings");
  assert.equal(runs.length, 1);
  for (const step of ["ping", "emails", "telegram", "budgets"]) assert.equal(typeof runs[0].steps[step], "number", step);
  assert.equal(typeof runs[0].total, "number");
  for (let i = 0; i < 30; i++) rt.run("runAutomation()");
  assert.equal(rt.api("admin_automationTimings").length, 24);
});

test("the heavy steps run on the first timer run and then only about once an hour; e-mail and Telegram run every time", () => {
  const { rt } = freshApp({ small: true });
  const steps = () => rt.api("admin_automationTimings").map((r) => Object.keys(r.steps));
  rt.run("runAutomation()");
  rt.svc.props.set("EMAIL_SCAN_LAST_AT", "0");
  rt.run("runAutomation()");
  const [first, second] = steps();
  assert.ok(first.includes("budgets") && first.includes("trip budgets") && first.includes("loan reminders") && first.includes("investment categories"));
  assert.ok(!second.includes("budgets") && !second.includes("trip budgets") && !second.includes("loan reminders") && !second.includes("investment categories"), "heavy steps skipped 15 minutes later");
  assert.ok(second.includes("telegram") && second.includes("statement inbox"), "the cheap steps still run every time");
  rt.svc.props.set("HEAVY_STEPS_LAST_AT", String(Date.now() - 51 * 60 * 1000));
  rt.run("runAutomation()");
  assert.ok(steps()[2].includes("budgets"), "an hour later they run again");
});
