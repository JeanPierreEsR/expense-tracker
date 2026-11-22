// Totals use a currency's FIRST rate for the months before it (an estimate), as the main currency's own rate always did
// (owner, 2026-11-17, journeys run: Mark's soles months before his first rate were left out of every total). Overview names them.
// Everything that ASKS for a missing rate keeps the strict lookup (trips, statements, saving an entry). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-e', name: 'Est A', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Exchange Rates', function (r) { return r.currency === 'EUR'; });`);
  return rt;
}
const monthsAgo = (k) => { const d = new Date(today() + "T12:00:00Z"); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return d.toISOString().slice(0, 7); };
let n = 0;
const entry = (rt, o) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "est-" + (++n), date: today(), type: "expense", amount: 10, currency: "PEN", category_id: "cat-e", status: "confirmed", description: "Est line", ...o })});`);

test("an entry before its currency's first rate counts with that first rate, and Overview says it is an estimate", () => {
  const rt = setup();
  rt.api("setExchangeRate", { currency: "EUR", month: monthsAgo(1), rate: 4 });
  entry(rt, { date: monthsAgo(3) + "-10", amount: 10, currency: "EUR" });   // two months before the first EUR rate
  entry(rt, { date: monthsAgo(1) + "-10", amount: 5, currency: "EUR" });    // the rate's own month: exact, not an estimate
  const s = rt.api("getPeriodSummary", { startDate: monthsAgo(3) + "-01", endDate: today() });
  assert.equal(s.excludedCount, 0, "nothing is left out any more");
  assert.equal(Math.round(s.totals.expense * 100) / 100, 60, "10 EUR and 5 EUR, both at 4");
  assert.deepEqual(s.estimated, [{ currency: "EUR", n: 1, from: monthsAgo(1) }]);
});

test("a currency with no rate at all is still left out, and no estimate is claimed", () => {
  const rt = setup();
  entry(rt, { amount: 10, currency: "ZZZ" });
  const s = rt.api("getPeriodSummary", { startDate: monthsAgo(1) + "-01", endDate: today() });
  assert.equal(s.excludedCount, 1);
  assert.deepEqual(s.estimated, []);
});

test("the strict lookup that asks for missing rates still answers nothing before the first rate", () => {
  const rt = setup();
  rt.api("setExchangeRate", { currency: "EUR", month: monthsAgo(1), rate: 4 });
  assert.equal(rt.run(`getLatestRateOnOrBefore_('EUR', ${JSON.stringify(monthsAgo(3))})`), null);
  assert.equal(rt.run(`getRateForTotals_('EUR', ${JSON.stringify(monthsAgo(3) + "-10")})`), 4);
});
