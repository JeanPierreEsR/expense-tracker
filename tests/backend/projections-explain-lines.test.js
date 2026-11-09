// The explanation lines under the Projections headline. A category set by hand has no Programmed or Expected part, so the parts still
// add up to the headline (Carlos, 2026-11-09); "not enough history" only when nothing could be estimated. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const close = (a, b, what) => assert.ok(Math.abs(a - b) < 0.011, `${what}: ${a} vs ${b}`);
const expenseParts = (p) => p.expensesActual + p.expensesProgrammed + p.expensesExpected + p.expensesManual;

test("the Expenses parts add up to the headline, with and without a figure set by hand", () => {
  const { rt } = freshApp({ entries: 600 });
  const before = rt.api("getProjections", { displayPeriodType: "month" });
  close(expenseParts(before), before.expenses, "no override");
  assert.equal(before.expensesManual, 0);
  const row = rt.api("listCategoryProjections", { displayPeriodType: "month" }).categories.find((c) => c.category_type === "expense" && c.expectedRemainingPen > 1);
  assert.ok(row, "the made-up data should give an expense with an Expected part");
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: row.category_id, displayPeriodType: "month" });
  const typed = row.totalPen + 111.42;
  rt.api("setProjectionOverride", { categoryId: row.category_id, periodKey: detail.bounds.periodKey, amount: typed });
  const after = rt.api("getProjections", { displayPeriodType: "month" });
  close(after.expenses, before.expenses + 111.42, "headline moves by the difference");
  close(expenseParts(after), after.expenses, "with an override");
  close(after.expensesManual, typed - row.actualPen, "what is left of the typed figure");
  close(after.expensesExpected, before.expensesExpected - row.expectedRemainingPen, "that category leaves Expected");
});

test("a copy with a long history is never told it has too little", () => {
  const { rt } = freshApp({ entries: 600 });
  assert.equal(rt.api("getProjections", { displayPeriodType: "month" }).notEnoughHistory, false);
});
