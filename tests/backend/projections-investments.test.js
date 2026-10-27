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
  assert.ok(Math.abs(after - before - 150 * 3.93) < 0.01, "both USD deposits added: " + (after - before));
  for (const displayPeriodType of ["month", "year"]) {
    const p = rt.api("getProjections", { displayPeriodType });
    assert.equal(p.investmentsExpected, 0, displayPeriodType + ": no expected investments");
  }
});
