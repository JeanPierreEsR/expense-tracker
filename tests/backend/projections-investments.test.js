// Projections show investments already made (by the entry's own type, even under a
// non-investment category) and never guess an "expected" amount for them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("an investment in USD counts as made, even filed under an expense category; nothing is expected", () => {
  const { rt } = freshApp({ entries: 200 });
  const expenseCat = rt.run(`getAllRows('Categories').filter(function (c) { return c.type === 'expense'; })[0].id`);
  const before = rt.api("getProjections", { displayPeriodType: "month" }).investmentsActual;
  rt.api("createEntry", { type: "investment", date: today(), amount: 100, currency: "USD", description: "dep" });
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "inv-old", type: "investment", date: today(), amount: 50, currency: "USD", category_id: expenseCat, description: "old", paid_by: "me", status: "confirmed", source: "manual" })});`);
  const after = rt.api("getProjections", { displayPeriodType: "month" }).investmentsActual;
  assert.ok(Math.abs(before - after - 150 * 3.93) < 0.01, "both USD deposits counted (the figure reads taken out − put in): " + (before - after));
  for (const displayPeriodType of ["month", "year"]) {
    const p = rt.api("getProjections", { displayPeriodType });
    assert.equal(p.investmentsExpected, 0, displayPeriodType + ": no expected investments");
  }
});

test("a month with more withdrawn than put in still shows the investments, as a net figure with both flows", () => {
  const { rt } = freshApp({ entries: 200 });
  const get = () => rt.api("getProjections", { displayPeriodType: "month" });
  const before = get();
  const invCat = rt.run(`getAllRows('Categories').filter(function (c) { return c.type === 'investment'; })[0].id`);
  rt.api("createEntry", { type: "investment", date: today(), amount: 2009, currency: "USD", description: "dep" });
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "inv-wd", type: "investment", date: today(), amount: -2189.4, currency: "USD", category_id: invCat, description: "withdrawal", paid_by: "me", status: "confirmed", source: "manual" })});`);
  const p = get();
  assert.ok(Math.abs((p.investmentsIn - before.investmentsIn) - 2009 * 3.93) < 0.01);
  assert.ok(Math.abs((p.investmentsOut - before.investmentsOut) - 2189.4 * 3.93) < 0.01);
  assert.ok(Math.abs((p.investments - before.investments) - (2189.4 - 2009) * 3.93) < 0.01, "reads taken out − put in: positive when more came out");
  assert.ok(Math.abs((p.net - before.net) - (2189.4 - 2009) * 3.93) < 0.01, "money left goes UP by the same amount");
  const cats = rt.api("listCategoryProjections", { displayPeriodType: "month" }).categories.filter((c) => c.category_type === "investment");
  assert.ok(cats.length > 0, "the investment categories are listed even when their net is negative");
});
