// Budgets change forward only (owner, 2026-11-07): a change of amount, currency or categories counts from the current period on;
// a new budget starts in the month it is made (or a start the person picked); ending one keeps it in earlier months.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-fw', name: 'Forward test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-fw2', name: 'Forward other', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  return rt;
}
function spend(rt, date, amount, category_id = "cat-fw") {
  const e = { id: "fw" + ++n, type: "expense", date, amount, currency: "PEN", category_id, description: "x", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const monthsAgo = (k) => {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(y, m - 1 - k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const thisMonth = () => today().slice(0, 7);
const thisYear = () => Number(today().slice(0, 4));
const monthNo = () => Number(today().slice(5, 7));
const list = (rt, displayPeriodType, anchorDate) => rt.api("listBudgets", { displayPeriodType, anchorDate });
const shown = (rt, id, type, anchor) => list(rt, type, anchor).budgets.find((b) => b.id === id);
const at = (rt, id, monthKey) => { const b = shown(rt, id, "month", monthKey + "-01"); return b && b.progress; };
const add = (rt, extra = {}) => rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly", ...extra });

test("the backend says budgets change forward only", () => {
  assert.equal(setup().api("getMeta", {}).capabilities.budgetHistory, true);
});

test("a new budget starts in the month it is made: last month does not show it", () => {
  const rt = setup();
  const b = add(rt);
  assert.equal(b.start, thisMonth());
  assert.ok(at(rt, b.id, thisMonth()));
  assert.equal(at(rt, b.id, monthsAgo(1)), undefined, "it did not exist last month");
});

test("a start picked by the person: an earlier month, 'always', or next month", () => {
  const rt = setup();
  const earlier = add(rt, { start: monthsAgo(3) });
  assert.ok(at(rt, earlier.id, monthsAgo(3)));
  assert.equal(at(rt, earlier.id, monthsAgo(4)), undefined);
  const always = add(rt, { category_id: "cat-fw2", start: "always" });
  assert.ok(at(rt, always.id, monthsAgo(30)));
  const next = add(rt, { category_id: "cat-fw,cat-fw2", start: "next" });
  assert.equal(at(rt, next.id, thisMonth()), undefined, "starts next month");
  assert.ok(at(rt, next.id, monthsAgo(-1)));
  const totals = list(rt, "month").summary.monthlyPen;
  assert.ok(totals < 400 + 400 + 400, "a budget that has not started is not in the totals");
  rt.api("updateBudget", { id: next.id, amount: 900 });
  assert.equal(at(rt, next.id, monthsAgo(-1)).effectiveAmount, 900, "a change before its start goes to its start");
  assert.equal(at(rt, next.id, thisMonth()), undefined, "and does not make it start now");
});

test("a new amount counts from this month on; last month keeps the amount it had", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 500 });
  assert.equal(at(rt, b.id, thisMonth()).effectiveAmount, 500);
  assert.equal(at(rt, b.id, thisMonth()).amountChanged, false);
  assert.equal(at(rt, b.id, monthsAgo(1)).effectiveAmount, 400);
  assert.equal(at(rt, b.id, monthsAgo(1)).amountChanged, true);
  assert.equal(at(rt, b.id, monthsAgo(14)).effectiveAmount, 400);
  assert.equal(rt.rows("Budgets")[0].amount, 500, "the budget itself holds today's amount");
});

test("a yearly budget: the new amount counts from this year on", () => {
  const rt = setup();
  const b = add(rt, { amount: 6000, period_type: "yearly", start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 7000 });
  assert.equal(shown(rt, b.id, "year", `${thisYear()}-01-01`).progress.effectiveAmount, 7000);
  assert.equal(shown(rt, b.id, "year", `${thisYear() - 1}-01-01`).progress.effectiveAmount, 6000);
});

test("a monthly budget shown by year: each month's own amount, and only the months it existed in", () => {
  const rt = setup();
  const b = add(rt, { amount: 100, start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 200 });
  const m = monthNo();
  assert.equal(shown(rt, b.id, "year", `${thisYear()}-01-01`).progress.effectiveAmount, 100 * (m - 1) + 200 * (13 - m));
  assert.equal(shown(rt, b.id, "year", `${thisYear() - 1}-01-01`).progress.effectiveAmount, 1200);

  const c = add(rt, { category_id: "cat-fw2", amount: 300 });   // starts this month
  spend(rt, `${thisYear()}-01-15`, 999, "cat-fw2");             // before it existed (January, or this month when it is January)
  spend(rt, today(), 50, "cat-fw2");
  const p = shown(rt, c.id, "year", `${thisYear()}-01-01`).progress;
  assert.equal(p.monthsCounted, 13 - m);
  assert.equal(p.effectiveAmount, 300 * (13 - m));
  assert.equal(p.spent, m === 1 ? 1049 : 50, "spending before its start is not counted against it");
  assert.equal(shown(rt, c.id, "year", `${thisYear() - 1}-01-01`), undefined, "not shown in a year it did not exist in");
});

test("two changes in one month keep one row for that month; a change of name or alerts writes nothing", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, name: "Renamed", thresholds: "80,100" });
  assert.equal(rt.run("budgetHistorySheetExists_() ? getAllRows('Budget History').length : 0"), 0);
  rt.api("updateBudget", { id: b.id, amount: 450 });
  rt.api("updateBudget", { id: b.id, amount: 480 });
  rt.api("updateBudget", { id: b.id, amount: 480 });
  assert.deepEqual(rt.rows("Budget History").map((r) => [String(r.from_period), Number(r.amount)]).sort(), [["", 400], [thisMonth(), 480]]);
});

test("a change of currency counts forward too", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 100, currency: "USD" });
  assert.deepEqual([at(rt, b.id, monthsAgo(1)).effectiveAmount, at(rt, b.id, monthsAgo(1)).currency], [400, "PEN"]);
  assert.equal(at(rt, b.id, thisMonth()).currency, "USD");
});

test("a change of categories counts forward: last month keeps its categories, its spending and its name", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  spend(rt, monthsAgo(1) + "-10", 70, "cat-fw");
  spend(rt, monthsAgo(1) + "-11", 30, "cat-fw2");
  spend(rt, today(), 20, "cat-fw2");
  rt.api("updateBudget", { id: b.id, category_id: "cat-fw,cat-fw2" });
  const last = shown(rt, b.id, "month", monthsAgo(1) + "-01");
  assert.equal(last.progress.spent, 70, "last month: only the category it had then");
  assert.deepEqual(last.progress.category_ids, ["cat-fw"]);
  assert.match(last.progress.category_name, /Forward test/);
  assert.ok(at(rt, b.id, thisMonth()).spent >= 20, "this month: both categories");
});

test("ending a budget: gone from this month, earlier months keep it, the totals and alerts drop it, and it can be made again", () => {
  const rt = setup();
  const b = add(rt, { start: monthsAgo(2) });
  const r = rt.api("endBudget", { id: b.id });
  assert.equal(r.ended, thisMonth());
  assert.equal(at(rt, b.id, thisMonth()), undefined);
  assert.ok(at(rt, b.id, monthsAgo(1)), "last month still shows it");
  assert.equal(list(rt, "month").summary.monthlyPen, 0, "not in the totals");
  assert.equal(shown(rt, b.id, "month", monthsAgo(1) + "-01").ended, true);
  assert.equal(rt.api("getHomeGlance", {}).budget, null, "Home's budget card leaves it out");
  const again = add(rt);   // the same category and kind: allowed, the old one has ended
  assert.ok(again.id);
});

test("ending a budget that never ran before this month deletes it completely", () => {
  const rt = setup();
  const b = add(rt);
  assert.equal(shown(rt, b.id, "month").end_deletes, true, "the app can say so before asking");
  assert.equal(rt.api("endBudget", { id: b.id }).deleted, true);
  assert.equal(rt.rows("Budgets").length, 0);
});

test("starting an ended budget again: from this month, the gap stays empty", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("endBudget", { id: b.id });
  rt.api("updateBudget", { id: b.id, restart: true, amount: 550 });
  assert.equal(at(rt, b.id, thisMonth()).effectiveAmount, 550);
  assert.equal(at(rt, b.id, monthsAgo(1)).effectiveAmount, 400);
  assert.equal(shown(rt, b.id, "month", thisMonth() + "-01").ended, false);
});

test("monthly ↔ yearly starts the budget again from this period; deleting completely removes every row", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 500 });
  rt.api("updateBudget", { id: b.id, period_type: "yearly", amount: 6000 });
  assert.deepEqual(rt.rows("Budget History").map((r) => String(r.from_period)), [String(thisYear())]);
  assert.equal(shown(rt, b.id, "year", `${thisYear()}-01-01`).progress.effectiveAmount, 6000);
  assert.equal(shown(rt, b.id, "year", `${thisYear() - 1}-01-01`), undefined);
  rt.api("deleteBudget", { id: b.id });
  assert.equal(rt.rows("Budget History").length, 0);
});

test("a copy without the tab (made before this update): old budgets keep showing in every month, and the tab is made on the first write", () => {
  const rt = setup();
  rt.run("var ss_ = SpreadsheetApp.getActiveSpreadsheet(); if (ss_.getSheetByName('Budget History')) ss_.deleteSheet(ss_.getSheetByName('Budget History'));");
  rt.run(`appendRowObject('Budgets', { id: 'old-1', category_id: 'cat-fw', amount: 400, currency: 'PEN', period_type: 'monthly', thresholds: '', name: '' });`);
  assert.equal(rt.run("budgetHistorySheetExists_()"), false);
  assert.equal(at(rt, "old-1", monthsAgo(3)).effectiveAmount, 400);
  rt.api("updateBudget", { id: "old-1", amount: 300 });
  assert.equal(rt.run("budgetHistorySheetExists_()"), true);
  assert.equal(at(rt, "old-1", monthsAgo(3)).effectiveAmount, 400);
  assert.equal(at(rt, "old-1", thisMonth()).effectiveAmount, 300);
});

test("the chart of a past month uses the currency that month had", () => {
  const rt = setup();
  const b = add(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 100, currency: "USD" });
  const m = monthsAgo(1);
  const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  assert.equal(rt.api("getBudgetChartSeries", { budgetId: b.id, startDate: m + "-01", endDate: `${m}-${last}` }).currency, "PEN");
  assert.equal(rt.api("getBudgetChartSeries", { budgetId: b.id, startDate: thisMonth() + "-01", endDate: thisMonth() + "-28" }).currency, "USD");
});

test("moving the start of a running budget (owner, 2026-11-08): earlier adds months at its first amount; later drops months and folds earlier changes in", () => {
  const { rt } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const [y, m] = today().split("-").map(Number);
  const k = (n) => { const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense").id;
  const amt = (id, n) => { const x = rt.api("listBudgets", { displayPeriodType: "month", anchorDate: k(n) + "-01" }).budgets.find((z) => z.id === id); return x ? x.progress.effectiveAmount : null; };
  // Sports: from 2 months ago at 500, changed to 1000 this month.
  const b = rt.api("addBudget", { category_id: cat, amount: 500, currency: "PEN", period_type: "monthly", start: k(-2) });
  rt.api("updateBudget", { id: b.id, amount: 1000 });
  assert.deepEqual([-4, -3, -2, -1, 0].map((n) => amt(b.id, n)), [null, null, 500, 500, 1000]);
  rt.api("updateBudget", { id: b.id, start: k(-4) });   // earlier
  assert.deepEqual([-4, -3, -2, -1, 0].map((n) => amt(b.id, n)), [500, 500, 500, 500, 1000]);
  rt.api("updateBudget", { id: b.id, start: k(-1) });   // later
  assert.deepEqual([-4, -3, -2, -1, 0].map((n) => amt(b.id, n)), [null, null, null, 500, 1000]);
  assert.equal(rt.api("listBudgets", { displayPeriodType: "month" }).budgets.find((z) => z.id === b.id).start_key, k(-1));
  // Moving the start past this month's change folds it in: it runs at 1000 from then.
  rt.api("updateBudget", { id: b.id, start: k(1) });
  const l = rt.api("listBudgets", { displayPeriodType: "month" });
  assert.equal(l.budgets.some((z) => z.id === b.id), false);
  assert.equal(l.later.find((z) => z.id === b.id).start_later, k(1));
  assert.equal(amt(b.id, 1), 1000);
});

test("'For all its months': a change replaces every earlier amount of the budget, changes in between included", () => {
  const { rt } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const [y, m] = today().split("-").map(Number);
  const k = (n) => { const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense").id;
  const amt = (id, n) => { const x = rt.api("listBudgets", { displayPeriodType: "month", anchorDate: k(n) + "-01" }).budgets.find((z) => z.id === id); return x ? x.progress.effectiveAmount : null; };
  const b = rt.api("addBudget", { category_id: cat, amount: 500, currency: "PEN", period_type: "monthly", start: k(-2) });
  rt.api("updateBudget", { id: b.id, amount: 1000 });
  rt.api("updateBudget", { id: b.id, amount: 1500, apply_all: true });
  assert.deepEqual([-3, -2, -1, 0, 1].map((n) => amt(b.id, n)), [null, 1500, 1500, 1500, 1500]);
});

test("the dotted part of a budget: Programmed items still to come this period, not yet recorded; none in a past month", () => {
  const { rt } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  rt.run(`appendRowObject('Categories', { id: 'cat-prog', name: 'Prog test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const b = rt.api("addBudget", { category_id: "cat-prog", amount: 1000, currency: "PEN", period_type: "monthly" });
  const lastDay = new Date(+today().slice(0, 4), +today().slice(5, 7), 0).getDate();
  rt.api("addRecurringExpense", { category_id: "cat-prog", description: "Demo rent", amount: 120, currency: "PEN", frequency: "monthly", day: lastDay });
  const p = rt.api("listBudgets", { displayPeriodType: "month" }).budgets.find((x) => x.id === b.id).progress;
  assert.equal(p.programmed, today().slice(8, 10) === String(lastDay) ? 120 : 120);
  const [y, m] = today().split("-").map(Number);
  const prev = new Date(y, m - 2, 1);
  const past = rt.api("listBudgets", { displayPeriodType: "month", anchorDate: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-01` }).budgets.find((x) => x.id === b.id);
  assert.ok(!past || !past.progress.programmed, "a past month has nothing still to come");
});
