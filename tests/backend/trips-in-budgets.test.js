// Trips & events "In my budgets" (owner, 2026-11-14): as usual (each expense counts in its category's budgets), left out of every
// budget, or counted only in the budgets picked, whatever the category. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-food', name: 'Food test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-fun', name: 'Fun test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const food = rt.api("addBudget", { category_id: "cat-food", amount: 1000, currency: "PEN", period_type: "monthly", start: "always" });
  const vac = rt.api("addBudget", { category_id: "cat-fun", amount: 5000, currency: "PEN", period_type: "monthly", start: "always" });
  return { rt, food, vac };
}
function spend(rt, amount, category, tripId) {
  const id = "tb" + ++n;
  const e = { id, type: "expense", date: today(), amount, currency: "PEN", category_id: category, description: "x", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  if (tripId) rt.run(`ensureEntriesTripColumn_(); setEntryField_('${id}', 'trip_id', '${tripId}');`);
  return id;
}
const trip = (rt, over = {}) => rt.api("addTrip", { name: "Beach trip", kind: "trip", start_date: today(), end_date: today(), ...over });
const progress = (rt, id) => rt.api("listBudgets", { displayPeriodType: "month", anchorDate: today().slice(0, 7) + "-01" }).budgets.find((b) => b.id === id).progress;

test("as usual: a trip's expenses count in their category's budget", () => {
  const { rt, food, vac } = setup();
  const t = trip(rt);
  spend(rt, 100, "cat-food", t.id);
  spend(rt, 30, "cat-food");
  assert.equal(progress(rt, food.id).spent, 130);
  assert.equal(progress(rt, vac.id).spent, 0);
  assert.deepEqual(progress(rt, food.id).tripsLeftOut, []);
});

test("left out: the trip's expenses count in no budget, and the budget says what was left out", () => {
  const { rt, food } = setup();
  const t = trip(rt, { in_budgets: "none" });
  spend(rt, 100, "cat-food", t.id);
  spend(rt, 30, "cat-food");
  const p = progress(rt, food.id);
  assert.equal(p.spent, 30);
  assert.deepEqual(p.tripsLeftOut.map((x) => [x.name, x.amount]), [["Beach trip", 100]]);
  // The drill-down list adds up to the same figure.
  const listed = rt.api("listEntries", { startDate: p.startDate, endDate: p.endDate, type: "expense", categoryIds: ["cat-food"], budgetId: food.id, excludeAnnual: true });
  assert.equal(listed.reduce((s, e) => s + Number(e.amount), 0), 30);
});

test("only in chosen budgets: counted there whatever the category, and nowhere else", () => {
  const { rt, food, vac } = setup();
  const t = trip(rt, { in_budgets: vac.id });
  spend(rt, 100, "cat-food", t.id);
  assert.equal(progress(rt, food.id).spent, 0);
  const pv = progress(rt, vac.id);
  assert.equal(pv.spent, 100);
  assert.deepEqual(pv.tripsCounted.map((x) => [x.name, x.amount]), [["Beach trip", 100]]);
  assert.equal(progress(rt, food.id).tripsLeftOut[0].amount, 100);
});

test("an edit from an older screen (no in_budgets sent) keeps the choice; a deleted budget makes it count as usual again", () => {
  const { rt, food, vac } = setup();
  const t = trip(rt, { in_budgets: vac.id });
  rt.api("updateTrip", { id: t.id, name: "Beach trip 2", kind: "trip", start_date: today(), end_date: today() });
  spend(rt, 100, "cat-food", t.id);
  assert.equal(progress(rt, food.id).spent, 0, "still counted only in the chosen budget");
  rt.api("deleteBudget", { id: vac.id });
  assert.equal(progress(rt, food.id).spent, 100, "its only budget is gone: as usual again");
  const listed = rt.api("listTrips", {}).find((x) => x.id === t.id);
  assert.equal(listed.in_budgets_lost, true);
});

test("a choice of budgets that do not exist is refused in plain words", () => {
  const { rt } = setup();
  assert.throws(() => trip(rt, { in_budgets: "no-such-budget" }), /at least one budget/);
});

test("Home's budget card follows the same rule", () => {
  const { rt, vac } = setup();
  const out = trip(rt, { name: "Left out", in_budgets: "none" });
  const only = trip(rt, { name: "Only fun", in_budgets: vac.id });
  spend(rt, 100, "cat-food", out.id);
  spend(rt, 40, "cat-food", only.id);
  spend(rt, 10, "cat-food");
  const glance = rt.api("getHomeGlance", {});
  assert.equal(Math.round(glance.budget.spentPen), 50);
});

test("the trip pop-up's list of budgets: names, yearly first", () => {
  const { rt, food, vac } = setup();
  rt.api("addBudget", { category_id: "cat-fun", amount: 9000, currency: "PEN", period_type: "yearly", start: "always" });
  const choices = rt.api("listBudgetChoices", {});
  assert.equal(choices.length, 3);
  assert.equal(choices[0].period_type, "yearly");
  assert.ok(choices.some((c) => c.id === food.id && c.name === "Food test"));
  assert.ok(choices.some((c) => c.id === vac.id));
});

test("a trip still 'as usual' is reported inside the budget it counts in (the bubble's moment)", () => {
  const { rt, food } = setup();
  const t = trip(rt);
  spend(rt, 300, "cat-food", t.id);
  spend(rt, 50, "cat-food");
  const p = progress(rt, food.id);
  assert.deepEqual(p.tripsInside.map((x) => [x.trip_id, x.name, x.amount]), [[t.id, "Beach trip", 300]]);
  assert.deepEqual(p.tripsLeftOut, []);
});
