// "Annual expenses" (owner, 2026-11-14): being annual is a mark, never a category. An expense is annual when its trip's "In my
// budgets" counts it in an "Annual expenses" budget (category_id ANNUAL, yearly only), or when it is tagged Annual and its trip (if
// any) is "as usual". Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-food', name: 'Food test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-tix', name: 'Tickets test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const food = rt.api("addBudget", { category_id: "cat-food", amount: 1000, currency: "PEN", period_type: "monthly", start: "always" });
  const annual = rt.api("addBudget", { category_id: "ANNUAL", amount: 9000, currency: "PEN", period_type: "yearly", start: "always" });
  return { rt, food, annual };
}
function spend(rt, amount, category, { tripId, annual } = {}) {
  const id = "ae" + ++n;
  const e = { id, type: "expense", date: today(), amount, currency: "PEN", category_id: category, description: "x" + n, paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  if (tripId) rt.run(`ensureEntriesTripColumn_(); setEntryField_('${id}', 'trip_id', '${tripId}');`);
  if (annual) rt.run(`ensureAnnualTag_(); ensureAnnualOnEntry_('${id}');`);
  return id;
}
const trip = (rt, over = {}) => rt.api("addTrip", { name: "Beach", kind: "trip", start_date: today(), end_date: today(), ...over });
const budgetsNow = (rt, type) => rt.api("listBudgets", { displayPeriodType: type, anchorDate: type === "year" ? today().slice(0, 4) + "-01-01" : today().slice(0, 7) + "-01" }).budgets;
const prog = (rt, id, type = "month") => budgetsNow(rt, type).find((b) => b.id === id).progress;

test("an Annual expenses budget counts everything tagged Annual, whatever the category; monthly budgets leave it out", () => {
  const { rt, food, annual } = setup();
  spend(rt, 100, "cat-food", { annual: true });
  spend(rt, 40, "cat-tix", { annual: true });
  spend(rt, 30, "cat-food");
  assert.equal(prog(rt, annual.id, "year").spent, 140);
  assert.equal(prog(rt, food.id).spent, 30);
  const row = budgetsNow(rt, "year").find((b) => b.id === annual.id);
  assert.equal(row.annual_kind, true);
  assert.equal(row.category_name, "Annual expenses");
  assert.deepEqual(row.category_ids, []);
});

test("a trip sent to the Annual budget counts there as a whole (no tags needed), and nowhere else", () => {
  const { rt, food, annual } = setup();
  const t = trip(rt, { in_budgets: annual.id });
  spend(rt, 200, "cat-food", { tripId: t.id });
  assert.equal(prog(rt, annual.id, "year").spent, 200);
  assert.equal(prog(rt, food.id).spent, 0);
  const marked = rt.run("JSON.stringify(Object.keys(annualMarkedIdSet_()))");
  assert.equal(JSON.parse(marked).length, 1);
});

test("a trip's own choice wins over the tag: sent to a monthly budget, its Annual-tagged expenses count there and are not annual", () => {
  const { rt, food, annual } = setup();
  const t = trip(rt, { in_budgets: food.id });
  spend(rt, 70, "cat-tix", { tripId: t.id, annual: true });   // e.g. Travel tags itself
  assert.equal(prog(rt, food.id).spent, 70);
  assert.equal(prog(rt, annual.id, "year").spent, 0);
  assert.deepEqual(JSON.parse(rt.run("JSON.stringify(Object.keys(annualMarkedIdSet_()))")), []);
});

test("the Annual budget's drill-down list adds up to its figure", () => {
  const { rt, annual } = setup();
  const t = trip(rt, { in_budgets: annual.id });
  spend(rt, 200, "cat-food", { tripId: t.id });
  spend(rt, 50, "cat-tix", { annual: true });
  spend(rt, 9, "cat-tix");
  const p = prog(rt, annual.id, "year");
  const list = rt.api("listEntries", { startDate: p.startDate, endDate: p.endDate, type: "expense", budgetId: annual.id, annualKind: true });
  assert.equal(list.reduce((s, e) => s + Number(e.amount), 0), 250);
});

test("an Annual expenses budget is yearly only, and never made twice", () => {
  const { rt, annual } = setup();
  assert.throws(() => rt.api("addBudget", { category_id: "ANNUAL", amount: 10, currency: "PEN", period_type: "monthly" }), /only be yearly/);
  assert.throws(() => rt.api("updateBudget", { id: annual.id, period_type: "monthly" }), /only be yearly/);
  assert.throws(() => rt.api("addBudget", { category_id: "ANNUAL", amount: 10, currency: "PEN", period_type: "yearly" }), /everything marked Annual/);
});

test("nobody gets one by default: a fresh copy has no Annual expenses budget", () => {
  const { rt } = freshApp({ small: true });
  const any = rt.api("listBudgets", {}).budgets.some((b) => b.annual_kind);
  assert.equal(any, false);
});

test("Overview: each category's annual part follows the same rule, and the chosen view is kept in Settings", () => {
  const { rt, annual } = setup();
  const t = trip(rt, { in_budgets: annual.id });
  spend(rt, 200, "cat-food", { tripId: t.id });
  spend(rt, 30, "cat-food");
  spend(rt, 50, "cat-tix", { annual: true });
  const ym = today().slice(0, 7);
  const r = rt.api("getPeriodSummary", { startDate: ym + "-01", endDate: today() });
  const cats = r.breakdowns.expense.byCategory;
  const food = cats.find((c) => c.id === "cat-food"), tix = cats.find((c) => c.id === "cat-tix");
  assert.equal(Math.round(food.annual_pen), 200);
  assert.equal(Math.round(tix.annual_pen), 50);
  rt.api("setOverviewCategoryView", { view: "oneLine" });
  assert.equal(rt.api("getMeta", {}).settings.overview_category_view, "oneLine");
  assert.throws(() => rt.api("setOverviewCategoryView", { view: "nope" }), /not available/);
});
