// E-mail health (backend/EmailHealth.gs): the scan leaves a record the app can show ("last checked") and warn from, and the
// search window follows the last good scan so an outage loses no e-mail. Found on the first friends' copies: a scan that failed
// on every e-mail told nobody, and the fixed 3-day window lost the e-mails that arrived while it was broken.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const scan = (rt) => rt.run("scanEmailsGuarded_('app')");
const health = (rt) => rt.api("getMeta").emailInfo.health;
const setHealth = (rt, h) => rt.svc.props.set("EMAIL_HEALTH", JSON.stringify(h));
const clearGap = (rt) => rt.svc.props.delete("EMAIL_SCAN_LAST_AT");   // the app may scan once a minute; tests scan back to back
const breakGmail = (rt, message) => rt.run("var __origSearch = __origSearch || gmailSearchMessages_; gmailSearchMessages_ = function () { throw new Error(" + JSON.stringify(message) + "); }");
const fixGmail = (rt) => rt.run("gmailSearchMessages_ = __origSearch");
const entryCount = (rt) => rt.rows("Entries").length;

test("no scan yet: nothing to say, the usual 3 days", () => {
  const { rt } = freshApp({ small: true });
  const h = health(rt);
  assert.equal(h.problem, null);
  assert.equal(h.lastOk, 0);
  assert.equal(h.lookbackDays, 3);
});

test("a good scan is recorded, and the app is told through getMeta and through checkEmailsNow", () => {
  const { rt } = freshApp({ small: true });
  const out = rt.api("checkEmailsNow");
  assert.equal(out.ran, true);
  assert.ok(out.health.lastOk > 0 && out.health.fails === 0 && out.health.problem === null);
  assert.ok(Math.abs(out.health.now - out.health.lastOk) < 60 * 1000);
  assert.equal(health(rt).lastOk, out.health.lastOk);
});

test("a skipped check (done a moment ago) still carries the health", () => {
  const { rt } = freshApp({ small: true });
  rt.api("checkEmailsNow");
  const again = rt.api("checkEmailsNow");
  assert.equal(again.ran, false);
  assert.ok(again.health.lastOk > 0);
});

test("with e-mail reading off there is no health to show", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base");
  assert.equal(rt.api("getMeta").emailInfo.health, null);
});

test("one failed scan is a hiccup, two in a row is a problem, and the app never gets an error", () => {
  const { rt } = freshApp({ small: true });
  rt.api("checkEmailsNow");
  clearGap(rt);   // a good scan a moment ago would make the next check "recent"
  breakGmail(rt, "Service invoked too many times for one day: gmail.");
  const first = rt.api("checkEmailsNow");
  assert.equal(first.ran, false);
  assert.equal(first.reason, "failed");
  assert.equal(first.health.fails, 1);
  assert.equal(first.health.problem, null);
  const second = rt.api("checkEmailsNow");
  assert.equal(second.health.fails, 2);
  assert.equal(second.health.problem, "quota");
});

test("the cause is a kind, never Google's wording", () => {
  const { rt } = freshApp({ small: true });
  const kind = (m) => rt.run("emailErrorKind_(new Error(" + JSON.stringify(m) + "))");
  assert.equal(kind("Service invoked too many times for one day: gmail."), "quota");
  assert.equal(kind("Authorization is required to perform that action."), "auth");
  assert.equal(kind("Exceeded maximum execution time"), "time");
  assert.equal(kind("something about ana@example.com"), "other");
  breakGmail(rt, "something about ana@example.com");
  rt.api("checkEmailsNow"); rt.api("checkEmailsNow");
  assert.ok(!JSON.stringify(health(rt)).includes("ana@example.com"));
});

test("a good scan afterwards clears the warning", () => {
  const { rt } = freshApp({ small: true });
  breakGmail(rt, "Authorization is required");
  rt.api("checkEmailsNow"); rt.api("checkEmailsNow");
  assert.equal(health(rt).problem, "auth");
  fixGmail(rt);
  const out = rt.api("checkEmailsNow");
  assert.equal(out.ran, true);
  assert.equal(out.health.problem, null);
  assert.equal(out.health.fails, 0);
});

test("a scan where an e-mail errors is not a good scan; the e-mail is retried, not marked handled", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "ERR-1" });
  const before = entryCount(rt);
  rt.run("var __orig = processOneMessage_; processOneMessage_ = function () { throw new Error('boom'); }");
  rt.api("checkEmailsNow");
  clearGap(rt);
  const second = rt.api("checkEmailsNow");
  assert.equal(second.health.fails, 2);
  assert.equal(second.health.problem, "read_errors");
  assert.equal(second.health.lastOk, 0, "an errored scan is never recorded as good");
  assert.equal(entryCount(rt), before);
  // fixed: the same e-mail is read on the next scan
  rt.run("processOneMessage_ = __orig");
  clearGap(rt);
  const third = rt.api("checkEmailsNow");
  assert.equal(third.created, 1);
  assert.equal(third.health.problem, null);
  assert.ok(third.health.lastOk > 0);
});

test("no good scan for 6 hours: stale; 5 hours is still fine", () => {
  const { rt } = freshApp({ small: true });
  setHealth(rt, { lastOk: Date.now() - 5 * HOUR, lastAttempt: Date.now(), fails: 0 });
  assert.equal(health(rt).problem, null);
  setHealth(rt, { lastOk: Date.now() - 7 * HOUR, lastAttempt: Date.now(), fails: 0 });
  assert.equal(health(rt).problem, "stale");
});

test("the window follows the last good scan: 3 days at least, 30 at most", () => {
  const { rt } = freshApp({ small: true });
  const days = () => rt.run("emailLookbackDays_()");
  setHealth(rt, { lastOk: Date.now() - 2 * HOUR });
  assert.equal(days(), 3);
  setHealth(rt, { lastOk: Date.now() - 10 * DAY });
  assert.equal(days(), 11);
  setHealth(rt, { lastOk: Date.now() - 90 * DAY });
  assert.equal(days(), 30);
});

test("after an outage the scan reads the e-mails that arrived meanwhile (the 22 October Yape case)", () => {
  const { rt } = freshApp({ small: true });
  bcpEmail(rt, { op: "OUTAGE-1", daysAgo: 8 });
  bcpEmail(rt, { op: "OUTAGE-2", daysAgo: 1 });
  // Same situation without a record: only the last 3 days are read
  const plain = rt.api("checkEmailsNow");
  assert.equal(plain.created, 1);
  // A copy whose last good scan was 10 days ago reads further back
  const { rt: rt2 } = freshApp({ small: true });
  bcpEmail(rt2, { op: "OUTAGE-1", daysAgo: 8 });
  bcpEmail(rt2, { op: "OUTAGE-2", daysAgo: 1 });
  setHealth(rt2, { lastOk: Date.now() - 10 * DAY, lastAttempt: Date.now() - 1 * HOUR, fails: 5, error: "other" });
  const caught = rt2.api("checkEmailsNow");
  assert.equal(caught.created, 2);
  assert.equal(caught.health.problem, null);
  assert.equal(caught.health.lookbackDays, 3, "back to the usual window once a good scan is recorded");
});

test("a scan cut off at the 6-minute limit counts as a failure on the next one", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("EMAIL_SCAN_RUNNING_AT", String(Date.now() - 10 * 60 * 1000));   // the claim marker a killed scan leaves behind
  rt.run("processEmails = function () { throw new Error('Exceeded maximum execution time'); }");
  rt.api("checkEmailsNow");
  const h = health(rt);
  assert.equal(h.fails, 2);
  assert.equal(h.problem, "time");
});
