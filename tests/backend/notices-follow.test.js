// An open alert follows what is true now (owner, 2026-11-06): the checks only ever added notices, so one stayed after the spending or the debt was gone.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram, today } = require("./helpers");

const ofKind = (rt, kind) => rt.api("listNotices").notices.filter((n) => n.kind === kind);
const alertRows = (rt, budgetId) => rt.rows("Budget Alert Log").filter((r) => r.budget_id === budgetId);

function budget(rt, data, { amount = 100, thresholds = "75" } = {}) {
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  rt.run("appendRowObject('Categories', { id: 'cat-follow', name: 'Follow cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' });");
  const made = rt.api("addBudget", { category_id: "cat-follow", amount, currency: "PEN", period_type: "monthly", thresholds });
  const spend = (n) => rt.api("createEntry", { type: "expense", date: today(), amount: n, currency: "PEN", category_id: "cat-follow", description: "Spend", paid_by: "me", payment_method_id: data.pms[3].id });
  return { made, spend };
}

test("a budget alert goes when the expense is deleted, as if it never happened, and crossing again warns again", () => {
  const { rt, data } = freshApp();
  const { made, spend } = budget(rt, data);
  const entry = spend(90);
  rt.run("checkBudgets()");
  assert.equal(ofKind(rt, "budget").length, 1);
  rt.api("deleteEntries", { ids: [entry.id] });
  rt.run("checkBudgets()");
  assert.deepEqual(ofKind(rt, "budget"), []);
  assert.equal(alertRows(rt, made.id).length, 0, "the alert history of that level is gone too");
  spend(80);
  rt.run("checkBudgets()");
  assert.equal(ofKind(rt, "budget").length, 1, "a new crossing is a new alert");
  assert.match(ofKind(rt, "budget")[0].text, /80%/);
});

test("a budget alert goes when the expense is edited below the lowest level, the budget is raised or deleted", () => {
  for (const change of [
    (rt, made, entry) => rt.api("updateEntry", { id: entry.id, fields: { amount: 10 } }),
    (rt, made) => rt.api("updateBudget", { id: made.id, amount: 1000 }),
    (rt, made) => rt.api("deleteBudget", { id: made.id })
  ]) {
    const { rt, data } = freshApp();
    const { made, spend } = budget(rt, data);
    const entry = spend(90);
    rt.run("checkBudgets()");
    assert.equal(ofKind(rt, "budget").length, 1);
    change(rt, made, entry);
    rt.run("checkBudgets()");
    assert.deepEqual(ofKind(rt, "budget"), []);
  }
});

test("a budget alert still over its lowest level shows today's figures, and Telegram is not told again", () => {
  const { rt, data } = freshApp();
  linkTelegram(rt);
  const { spend } = budget(rt, data, { thresholds: "50,90" });
  spend(60);
  const big = spend(35);
  rt.run("checkBudgets()");
  assert.match(ofKind(rt, "budget")[0].text, /95%/);
  const sent = rt.svc.fetchLog.length;
  rt.api("deleteEntries", { ids: [big.id] });
  rt.run("checkBudgets()");
  assert.equal(ofKind(rt, "budget").length, 1);
  assert.match(ofKind(rt, "budget")[0].text, /60%/);
  assert.equal(rt.svc.fetchLog.length, sent, "a correction is not a new alert");
});

test("an overdue alert shows what is left after a part repayment and goes once fully repaid", () => {
  const { rt, data } = freshApp();
  rt.run("deleteRowsWhere_('Loans', function () { return true; })");
  const friend = rt.api("addFriend", { name: "Follow friend" });
  const past = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const repay = (amount) => rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount, currency: "PEN", date: today(), payment_method_id: data.pms[3].id });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 80, currency: "PEN", date: past, due_date: past, description: "x", payment_method_id: data.pms[3].id });
  rt.run("checkOverdueLoans()");
  assert.match(ofKind(rt, "loan")[0].text, /80\.00/);
  repay(30);
  rt.run("checkOverdueLoans()");
  assert.equal(ofKind(rt, "loan").length, 1);
  assert.match(ofKind(rt, "loan")[0].text, /50\.00/);
  repay(50);
  rt.run("checkOverdueLoans()");
  assert.deepEqual(ofKind(rt, "loan"), []);
  rt.run("checkOverdueLoans()");
  assert.deepEqual(ofKind(rt, "loan"), [], "and it does not come back by itself");
  rt.run("deleteRowsWhere_('Settlements', function () { return true; })");   // the repayments taken back: overdue again, so it alerts again
  rt.run("checkOverdueLoans()");
  assert.equal(ofKind(rt, "loan").length, 1);
});

test("a trip budget alert follows the spending too", () => {
  const { rt, data } = freshApp();
  const day = today();
  const trip = rt.api("addTrip", { name: "Follow trip", start_date: day, end_date: day, budget_amount: 100, currency: "PEN", alert_thresholds: "75" });
  const category = rt.rows("Categories").find((c) => c.type === "expense").id;
  const entry = rt.api("createEntry", { type: "expense", date: day, amount: 90, currency: "PEN", category_id: category, description: "Trip spend", paid_by: "me", payment_method_id: data.pms[3].id, trip_id: trip.id });
  const mine = () => ofKind(rt, "trip").filter((n) => /Follow trip/.test(n.text));
  rt.run("checkTripBudgets()");
  assert.equal(mine().length, 1);
  rt.api("deleteEntries", { ids: [entry.id] });
  rt.run("checkTripBudgets()");
  assert.deepEqual(mine(), []);
});
