// Home's "Programmed this month" marks the items Projections' MONTH view leaves out (testers, 2026-11-17): a once-a-year item
// or one tagged Annual is counted only in the Year view there, so Home says so instead of the two totals differing silently.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const CAT = "cat-year-view-test";
function setup() {
  const { rt } = freshApp({ entries: 30 });
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(CAT)}, name: 'Year view test', type: 'expense', icon: '🧾', color: '#ccc', parent_id: '' });`);
  return rt;
}
const day = () => Math.min(28, Number(today().slice(8, 10)) + 1);
const month = () => Number(today().slice(5, 7));
const item = (rt, id) => rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items).find((i) => i.id === id);

test("a once-a-year item due this month is marked; a monthly one is not", () => {
  const rt = setup();
  const yearly = rt.api("addRecurringExpense", { category_id: CAT, description: "Yearly thing", amount: 330.1, currency: "PEN", frequency: "yearly", day: day(), month: month() });
  const monthly = rt.api("addRecurringExpense", { category_id: CAT, description: "Monthly thing", amount: 40, currency: "PEN", frequency: "monthly", day: day() });
  assert.equal(item(rt, yearly.id).yearView, true);
  assert.equal(item(rt, monthly.id).yearView, false);
});

test("the marked item is exactly what Projections' month view leaves out", () => {
  const rt = setup();
  rt.api("addRecurringExpense", { category_id: CAT, description: "Yearly thing", amount: 330.1, currency: "PEN", frequency: "yearly", day: day(), month: month() });
  rt.api("addRecurringExpense", { category_id: CAT, description: "Monthly thing", amount: 40, currency: "PEN", frequency: "monthly", day: day() });
  const cat = rt.api("listCategoryProjections", {}).categories.find((c) => c.category_id === CAT || c.id === CAT);
  assert.ok(cat, "the test category is projected");
  assert.equal(Math.round(cat.programmedRemainingPen * 100) / 100, 40, "only the monthly item counts in the month view");
});
