// Notices (backend/Notices.gs): budget, trip and loan alerts used to go ONLY to Telegram, so a friend (no Telegram) never saw them and the
// check retried them forever without logging. Now every alert lands in the Notices tab (the Home "Alerts" card), and goes to Telegram too
// when a chat is linked.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram, today } = require("./helpers");

const sentToTelegram = (rt) => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");
const alertRows = (rt, budgetId) => rt.rows("Budget Alert Log").filter((r) => r.budget_id === budgetId);
const notices = (rt) => rt.api("listNotices").notices;

function budgetOver(rt, data, { amount = 100, spend = 90, thresholds = "75", index = 14, clear = true } = {}) {
  // The made-up data already has budgets that are over their thresholds; start from none so the counts below are exact.
  if (clear) rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  // A category of its own, so none of the made-up spending counts towards the figures.
  const cat = { id: "cat-notice-" + index, name: "Notice cat " + index };
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(cat.id)}, name: ${JSON.stringify(cat.name)}, type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const budget = rt.api("addBudget", { category_id: cat.id, amount, currency: "PEN", period_type: "monthly", thresholds });
  const spendMore = (n, description = "Spend") => rt.api("createEntry", {
    type: "expense", date: today(), amount: n, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: data.pms[3].id
  });
  if (spend) spendMore(spend, "First spend");
  return { budget, cat, spendMore };
}

test("a friend's copy (no Telegram): the budget alert becomes a notice, and is logged so it is not repeated", () => {
  const { rt, data } = freshApp();
  const { budget, cat } = budgetOver(rt, data);
  assert.deepEqual(notices(rt), [], "nothing before the check");
  rt.run("checkBudgets()");
  const list = notices(rt);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "budget");
  assert.match(list[0].text, new RegExp(cat.name));
  assert.match(list[0].text, /9\d%/);
  assert.equal(alertRows(rt, budget.id).length, 1, "logged as delivered");
  assert.equal(rt.svc.fetchLog.length, 0, "nothing was sent anywhere");
  rt.run("checkBudgets()");
  assert.equal(notices(rt).length, 1, "the next cycle does not add it again");
});

test("a later threshold of the same budget updates the open notice instead of adding a line", () => {
  const { rt, data } = freshApp();
  const { spendMore } = budgetOver(rt, data, { amount: 1000, spend: 600, thresholds: "50,90" });
  rt.run("checkBudgets()");
  const first = notices(rt);
  assert.equal(first.length, 1);
  assert.match(first[0].text, /6\d%/);
  spendMore(350, "More");
  rt.run("checkBudgets()");
  const second = notices(rt);
  assert.equal(second.length, 1, "still one line");
  assert.equal(second[0].id, first[0].id);
  assert.match(second[0].text, /9\d%/, "it shows the latest figure");
});

test("after it is dismissed, crossing the threshold again adds a new notice", () => {
  const { rt, data } = freshApp();
  const { budget, spendMore } = budgetOver(rt, data, { amount: 5000, spend: 0, thresholds: "75" });
  spendMore(4500, "Big spend");
  rt.run("checkBudgets()");
  rt.api("markNoticesSeen", { all: true });
  assert.equal(notices(rt).length, 0);
  const big = rt.rows("Entries").find((e) => e.description === "Big spend");
  rt.api("discardEntry", { id: big.id });
  rt.run("checkBudgets()");                       // spend fell: the alert is re-armed
  assert.equal(alertRows(rt, budget.id).length, 0);
  spendMore(4500, "Again");
  rt.run("checkBudgets()");
  assert.equal(notices(rt).length, 1, "a fresh notice");
  assert.equal(rt.rows("Notices").length, 2, "the dismissed one is kept for a while");
});

test("with Telegram linked and accepting, the same words go to both places", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 7 } });
  const { budget } = budgetOver(rt, data);
  rt.run("checkBudgets()");
  const list = notices(rt);
  assert.equal(list.length, 1);
  assert.ok(sentToTelegram(rt).includes(list[0].text.slice(0, 20)), "Telegram got the notice's text");
  assert.equal(alertRows(rt, budget.id).length, 1);
});

test("with Telegram linked but refusing: one notice, not logged, and it retries without duplicating", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  rt.state.fetchHandler = () => ({ ok: false, description: "Forbidden: bot was blocked by the user" });
  const { budget } = budgetOver(rt, data);
  rt.run("checkBudgets()");
  assert.equal(notices(rt).length, 1, "the person still sees it in the app");
  assert.equal(alertRows(rt, budget.id).length, 0, "not logged: the next cycle retries Telegram");
  rt.run("checkBudgets()");
  assert.equal(notices(rt).length, 1, "the retry did not add a second notice");
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 8 } });
  rt.run("checkBudgets()");
  assert.equal(alertRows(rt, budget.id).length, 1, "delivered at last");
  assert.equal(notices(rt).length, 1);
});

test("an overdue loan becomes a notice once", () => {
  const { rt } = freshApp({ small: true });
  const friend = rt.rows("Friends")[0];
  const loan = rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2020-01-01", due_date: "2020-02-01" });
  rt.run("checkOverdueLoans()");
  const mine = notices(rt).filter((n) => n.kind === "loan");
  assert.ok(mine.length >= 1);
  assert.ok(mine.some((n) => n.text.includes(friend.name) && n.text.includes("2020-02-01")));
  const count = rt.rows("Notices").length;
  rt.run("checkOverdueLoans()");
  assert.equal(rt.rows("Notices").length, count, "logged, so not repeated");
  assert.ok(loan);
});

test("a trip budget alert becomes a notice", () => {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Trip cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const t = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2020-03-01", end_date: new Date().toISOString().slice(0, 10), budget_amount: 100, currency: "PEN" });
  const e = { id: "t1", type: "expense", date: "2020-03-10", amount: 120, currency: "PEN", category_id: "cat-a", description: "x", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)}); ensureEntriesTripColumn_(); setEntryField_('t1', 'trip_id', '${t.id}');`);
  rt.run("checkTripBudgets()");
  const mine = notices(rt).filter((n) => n.kind === "trip");
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /Cusco/);
  assert.match(mine[0].text, /12\d%/);
});

test("dismissing: by id, or all; listing never creates the tab", () => {
  const { rt, data } = freshApp();
  assert.ok(!rt.svc.ss.getSheetByName("Notices"), "no tab until a first notice");
  assert.deepEqual(rt.api("listNotices"), { notices: [] });
  assert.ok(!rt.svc.ss.getSheetByName("Notices"), "listing did not create it");
  assert.deepEqual(rt.api("markNoticesSeen", { all: true }), { marked: 0 });
  budgetOver(rt, data);
  budgetOver(rt, data, { index: 15, clear: false });
  rt.run("checkBudgets()");
  const list = notices(rt);
  assert.equal(list.length, 2);
  assert.equal(rt.api("markNoticesSeen", { ids: [list[0].id] }).marked, 1);
  assert.equal(notices(rt).length, 1);
  assert.equal(rt.api("markNoticesSeen", { all: true }).marked, 1);
  assert.equal(notices(rt).length, 0);
});

test("dismissed notices older than 30 days are removed the next time one is added", () => {
  const { rt, data } = freshApp();
  rt.run(`ensureNoticesSheet_(); appendRowObject('Notices', { id: 'old', created_at: '2020-01-01T10:00:00', kind: 'budget', key: 'k-old', text: 'old', seen: 'yes' });`);
  rt.run(`appendRowObject('Notices', { id: 'fresh', created_at: nowTimestamp_(), kind: 'budget', key: 'k-new', text: 'seen but recent', seen: 'yes' });`);
  budgetOver(rt, data);
  rt.run("checkBudgets()");
  const ids = rt.rows("Notices").map((n) => n.id);
  assert.ok(!ids.includes("old"));
  assert.ok(ids.includes("fresh"));
});

// ---- Alerts only from now on (no burst of old news when an existing copy is updated) ----
const BASELINE_KEY = "ALERTS_BASELINE_DONE";
const baselineDone = (rt) => JSON.parse(rt.svc.props.get(BASELINE_KEY) || "{}");
function overTrip(rt, name) {
  rt.run(`appendRowObject('Categories', { id: 'cat-trip', name: 'Trip cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const t = rt.api("addTrip", { name, kind: "trip", start_date: "2020-03-01", end_date: new Date().toISOString().slice(0, 10), budget_amount: 100, currency: "PEN" });
  const e = { id: "trip-e1", type: "expense", date: "2020-03-10", amount: 120, currency: "PEN", category_id: "cat-trip", description: "x", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)}); ensureEntriesTripColumn_(); setEntryField_('trip-e1', 'trip_id', '${t.id}');`);
  return t;
}
const runChecks = (rt) => rt.run("checkBudgets(); checkTripBudgets(); checkOverdueLoans();");

test("a new copy is marked 'from now on' at setup, so its first alert is a real one", () => {
  const { rt } = freshApp({ small: true });
  assert.deepEqual(baselineDone(rt), { budgets: true, trips: true, loans: true });
});

test("an existing copy updated to this version: what is already over is written down, not alerted; only new crossings alert", () => {
  const { rt, data } = freshApp({ entries: 50 });
  linkTelegram(rt);
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 3 } });
  const friend = rt.rows("Friends")[0];
  // The situation of a copy that has been running for a while, before it gets this version: things already over, nothing logged, no marker.
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  rt.svc.props.delete(BASELINE_KEY);
  const old = budgetOver(rt, data, { index: 1, clear: false });
  overTrip(rt, "Old trip");
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2020-01-01", due_date: "2020-02-01" });

  runChecks(rt);
  assert.ok(!rt.svc.ss.getSheetByName("Notices"), "no notice for old news");
  assert.equal(rt.svc.fetchLog.length, 0, "and nothing sent to Telegram either");
  assert.equal(alertRows(rt, old.budget.id).length, 1, "but it is written down as already alerted");
  assert.deepEqual(baselineDone(rt), { budgets: true, trips: true, loans: true });
  const logged = rt.rows("Loan Alert Log").length + rt.rows("Budget Alert Log").length;

  runChecks(rt);
  assert.ok(!rt.svc.ss.getSheetByName("Notices"), "the next cycle does not alert for it either");
  assert.equal(rt.rows("Loan Alert Log").length + rt.rows("Budget Alert Log").length, logged);

  // New news, after the update: that does alert (notice + Telegram)
  budgetOver(rt, data, { index: 2, clear: false });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2020-03-01", due_date: "2020-03-15" });
  runChecks(rt);
  const kinds = notices(rt).map((n) => n.kind).sort();
  assert.deepEqual(kinds, ["budget", "loan"], "only the new budget and the new overdue loan");
  assert.ok(rt.svc.fetchLog.length >= 2, "Telegram got them");
});

test("the 'from now on' mark is used up even when nothing was over yet, so a later over-limit budget does alert", () => {
  const { rt, data } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  rt.svc.props.delete(BASELINE_KEY);
  runChecks(rt);                                    // nothing to hide: the mark is consumed
  assert.equal(baselineDone(rt).budgets, true);
  budgetOver(rt, data, { clear: false });
  rt.run("checkBudgets()");
  assert.equal(notices(rt).length, 1);
});

test("capabilities: notices are offered, and Telegram counts as linked only with a chat", () => {
  const { rt } = freshApp({ small: true });
  let caps = rt.api("getMeta").capabilities;
  assert.equal(caps.notices, true);
  assert.equal(caps.telegramLinked, false);
  rt.svc.props.set("TELEGRAM_BOT_TOKEN", "fake-bot-token");
  assert.equal(rt.api("getMeta").capabilities.telegramLinked, false, "a token alone sends nothing");
  linkTelegram(rt);
  caps = rt.api("getMeta").capabilities;
  assert.equal(caps.telegramLinked, true);
});
