// Duplicate budgets (owner's rule, 2026-10-05): the same set of categories in the
// same timeframe is rejected (two monthly Travel budgets). Everything else
// coexists: monthly + yearly, one-category + multi-category, overlapping sets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

// Seeded budgets cover the first 12 expense categories, all monthly. Use free ones.
const cats = (data) => data.cats.filter((c) => c.type === "expense").slice(13);
const mk = (rt, category_id, period_type, extra = {}) =>
  rt.api("addBudget", { category_id, amount: 100, currency: "PEN", period_type, ...extra });

test("a second monthly budget for the same category is rejected", () => {
  const { rt, data } = freshApp();
  const [travel] = cats(data);
  mk(rt, travel.id, "monthly");
  assert.throws(() => mk(rt, travel.id, "monthly"), /already/i);
  assert.equal(rt.rows("Budgets").filter((b) => b.category_id === travel.id).length, 1);
});

test("a monthly and a yearly budget for the same category are both allowed", () => {
  const { rt, data } = freshApp();
  const [travel] = cats(data);
  mk(rt, travel.id, "monthly");
  mk(rt, travel.id, "yearly");
  assert.equal(rt.rows("Budgets").filter((b) => b.category_id === travel.id).length, 2);
});

test("a second yearly budget for the same category is rejected too", () => {
  const { rt, data } = freshApp();
  const [travel] = cats(data);
  mk(rt, travel.id, "yearly");
  assert.throws(() => mk(rt, travel.id, "yearly"), /already/i);
});

test("different categories can each have a monthly budget", () => {
  const { rt, data } = freshApp();
  const [a, b] = cats(data);
  mk(rt, a.id, "monthly");
  mk(rt, b.id, "monthly");
});

test("a multi-category budget coexists with one-category budgets that it includes", () => {
  const { rt, data } = freshApp();
  const [a, b, c] = cats(data);
  mk(rt, a.id, "monthly");
  mk(rt, a.id + "," + b.id, "monthly");        // includes a — allowed
  mk(rt, b.id, "monthly");                      // included in the multi — allowed
  mk(rt, b.id + "," + c.id, "monthly");        // overlaps the first multi on b — allowed
  assert.equal(rt.rows("Budgets").filter((x) => [a.id, b.id, c.id].some((id) => x.category_id.includes(id))).length, 4);
});

test("exactly the same set of categories in the same timeframe is rejected, in any order", () => {
  const { rt, data } = freshApp();
  const [a, b, c] = cats(data);
  mk(rt, a.id + "," + b.id, "monthly");
  assert.throws(() => mk(rt, a.id + "," + b.id, "monthly"), /already/i);
  assert.throws(() => mk(rt, b.id + "," + a.id, "monthly"), /already/i, "order doesn't matter");
  mk(rt, a.id + "," + b.id, "yearly");           // other timeframe — allowed
  mk(rt, a.id + "," + b.id + "," + c.id, "monthly");   // a different set — allowed
});

test("'All categories' is rejected only against another 'All categories' of the same timeframe", () => {
  const { rt, data } = freshApp();
  const [a] = cats(data);
  mk(rt, "ALL", "yearly");
  assert.throws(() => mk(rt, "ALL", "yearly"), /already/i);
  mk(rt, "ALL", "monthly");                      // other timeframe
  mk(rt, a.id, "yearly");                        // specific category alongside ALL
});

test("editing a budget onto an existing category+timeframe is rejected; saving it unchanged is fine", () => {
  const { rt, data } = freshApp();
  const [a, b] = cats(data);
  const first = mk(rt, a.id, "monthly");
  const second = mk(rt, b.id, "monthly");

  assert.throws(() => rt.api("updateBudget", { id: second.id, category_id: a.id }), /already/i);
  assert.throws(() => rt.api("updateBudget", { id: first.id, category_id: b.id }), /already/i);
  rt.api("updateBudget", { id: first.id, amount: 250, category_id: a.id, period_type: "monthly" });  // itself: fine
  assert.equal(Number(rt.rows("Budgets").find((x) => x.id === first.id).amount), 250);

  // moving to the other timeframe is allowed (a has no yearly budget)
  rt.api("updateBudget", { id: second.id, category_id: a.id, period_type: "yearly" });
});
