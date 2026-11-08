// Budget amounts go forward only (owner, 2026-11-07): changing a budget's amount counts from the current period on; a past
// month (or year) keeps the amount it had. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-fw', name: 'Forward test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  return rt;
}
const monthsAgo = (k) => {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(y, m - 1 - k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const thisMonth = () => today().slice(0, 7);
const thisYear = () => Number(today().slice(0, 4));
const progressAt = (rt, id, displayPeriodType, anchorDate) =>
  rt.api("listBudgets", { displayPeriodType, anchorDate }).budgets.find((b) => b.id === id).progress;

test("a new amount counts from this month on; last month keeps the amount it had", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  rt.api("updateBudget", { id: b.id, amount: 500 });
  const now = progressAt(rt, b.id, "month", thisMonth() + "-01");
  const before = progressAt(rt, b.id, "month", monthsAgo(1) + "-01");
  assert.equal(now.effectiveAmount, 500);
  assert.equal(now.amountChanged, false);
  assert.equal(before.effectiveAmount, 400, "last month keeps its own amount");
  assert.equal(before.amountChanged, true);
  assert.equal(progressAt(rt, b.id, "month", monthsAgo(14) + "-01").effectiveAmount, 400, "every month before the change does");
  assert.equal(rt.rows("Budgets")[0].amount, 500, "the budget itself holds today's amount");
});

test("a yearly budget: the new amount counts from this year on, last year keeps its amount", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 6000, currency: "PEN", period_type: "yearly" });
  rt.api("updateBudget", { id: b.id, amount: 7000 });
  assert.equal(progressAt(rt, b.id, "year", `${thisYear()}-01-01`).effectiveAmount, 7000);
  assert.equal(progressAt(rt, b.id, "year", `${thisYear() - 1}-01-01`).effectiveAmount, 6000);
});

test("a monthly budget shown by year adds each month's own amount", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 100, currency: "PEN", period_type: "monthly" });
  rt.api("updateBudget", { id: b.id, amount: 200 });
  const m = Number(today().slice(5, 7));
  assert.equal(progressAt(rt, b.id, "year", `${thisYear()}-01-01`).effectiveAmount, 100 * (m - 1) + 200 * (13 - m));
  assert.equal(progressAt(rt, b.id, "year", `${thisYear() - 1}-01-01`).effectiveAmount, 1200, "last year: the old amount every month");
});

test("two changes in one month keep one row for that month; a change of name or alerts writes nothing", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  rt.api("updateBudget", { id: b.id, name: "Renamed", thresholds: "80,100" });
  assert.equal(rt.run("budgetAmountsSheetExists_() ? getAllRows('Budget Amounts').length : 0"), 0);
  rt.api("updateBudget", { id: b.id, amount: 450 });
  rt.api("updateBudget", { id: b.id, amount: 480 });
  rt.api("updateBudget", { id: b.id, amount: 480 });   // the same amount again: no change
  const rows = rt.rows("Budget Amounts").map((r) => [String(r.from_period), Number(r.amount)]).sort();
  assert.deepEqual(rows, [["", 400], [thisMonth(), 480]]);
  assert.equal(progressAt(rt, b.id, "month", monthsAgo(1) + "-01").effectiveAmount, 400);
});

test("a change of currency counts forward too: last month is measured in the old currency", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  rt.api("updateBudget", { id: b.id, amount: 100, currency: "USD" });
  const before = progressAt(rt, b.id, "month", monthsAgo(1) + "-01");
  assert.deepEqual([before.effectiveAmount, before.currency], [400, "PEN"]);
  assert.equal(progressAt(rt, b.id, "month", thisMonth() + "-01").currency, "USD");
});

test("monthly ↔ yearly forgets the old amounts; deleting a budget removes its rows", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  const c = rt.api("addBudget", { category_id: "cat-fw", amount: 5000, currency: "PEN", period_type: "yearly" });
  rt.api("updateBudget", { id: b.id, amount: 500 });
  rt.api("updateBudget", { id: c.id, amount: 6000 });
  assert.equal(rt.rows("Budget Amounts").length, 4);
  rt.api("deleteBudget", { id: c.id });
  assert.deepEqual([...new Set(rt.rows("Budget Amounts").map((r) => r.budget_id))], [b.id]);
  rt.run(`deleteRowsWhere_('Budgets', function (r) { return r.id === '${c.id}'; })`);
  rt.api("updateBudget", { id: b.id, period_type: "yearly", amount: 6000 });
  assert.equal(rt.rows("Budget Amounts").length, 0, "the monthly amounts mean nothing for a yearly budget");
  assert.equal(progressAt(rt, b.id, "year", `${thisYear() - 1}-01-01`).effectiveAmount, 6000);
});

test("a copy without the tab (made before this update) uses today's amount everywhere, and makes the tab on the first change", () => {
  const rt = setup();
  rt.run("var ss_ = SpreadsheetApp.getActiveSpreadsheet(); if (ss_.getSheetByName('Budget Amounts')) ss_.deleteSheet(ss_.getSheetByName('Budget Amounts'));");
  assert.equal(rt.run("budgetAmountsSheetExists_()"), false);
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  assert.equal(progressAt(rt, b.id, "month", monthsAgo(3) + "-01").effectiveAmount, 400);
  rt.api("deleteBudget", { id: rt.api("addBudget", { category_id: "cat-fw", amount: 9, currency: "PEN", period_type: "yearly" }).id });
  rt.api("updateBudget", { id: b.id, amount: 300 });
  assert.equal(rt.run("budgetAmountsSheetExists_()"), true);
  assert.equal(progressAt(rt, b.id, "month", monthsAgo(3) + "-01").effectiveAmount, 400);
  assert.equal(progressAt(rt, b.id, "month", thisMonth() + "-01").effectiveAmount, 300);
});

test("the chart of a past month uses the currency that month had", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-fw", amount: 400, currency: "PEN", period_type: "monthly" });
  rt.api("updateBudget", { id: b.id, amount: 100, currency: "USD" });
  const m = monthsAgo(1);
  const last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();
  assert.equal(rt.api("getBudgetChartSeries", { budgetId: b.id, startDate: m + "-01", endDate: `${m}-${last}` }).currency, "PEN");
  assert.equal(rt.api("getBudgetChartSeries", { budgetId: b.id, startDate: thisMonth() + "-01", endDate: thisMonth() + "-28" }).currency, "USD");
});
