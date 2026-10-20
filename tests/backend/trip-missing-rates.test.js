// A trip says WHICH exchange rates it is waiting for (2026-10-19), and its date finder can look before the trip.
// Incident: a flight bought in an earlier year was dated the day it was paid, before the first rate on file for
// the trip's currency, so it silently stayed out of the totals ("N expenses have no exchange rate") and nothing
// asked for the rate. Now the detail lists one rate per currency (at its earliest month) for the app to ask for.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.api("setExchangeRate", { currency: "USD", month: "2020-03", rate: 4 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Rate test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  return rt;
}
function entry(rt, tripId, id, amount, currency, date) {
  const e = { id, type: "expense", date, amount, currency, category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)}); ensureEntriesTripColumn_(); setEntryField_('${id}', 'trip_id', '${tripId}');`);
}
const trip = (rt, over = {}) => rt.api("addTrip", { name: "Trip", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-31", currency: "USD", ...over });

test("expenses paid before the trip currency's first rate are listed as ONE needed rate, at the earliest month", () => {
  const rt = setup();
  const t = trip(rt);
  entry(rt, t.id, "flight1", 400, "PEN", "2019-09-12");
  entry(rt, t.id, "flight2", 200, "PEN", "2019-06-03");
  entry(rt, t.id, "ok", 80, "PEN", "2020-03-10");
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.missingRate, 2);
  assert.deepEqual(d.missingRates, [{ currency: "USD", month: "2019-06", count: 2 }]);
  assert.equal(d.totalMain, 20, "only the in-trip expense counts until the rate is set");

  rt.api("setExchangeRate", { currency: "USD", month: "2019-06", rate: 3.8 });
  const after = rt.api("getTripDetail", { id: t.id });
  assert.equal(after.missingRate, 0);
  assert.deepEqual(after.missingRates, []);
  assert.equal(after.entryCount, 3);
});

test("an expense in another currency with no rate asks for THAT currency", () => {
  const rt = setup();
  const t = trip(rt);
  entry(rt, t.id, "eur", 30, "EUR", "2020-03-10");
  const d = rt.api("getTripDetail", { id: t.id });
  assert.deepEqual(d.missingRates, [{ currency: "EUR", month: "2020-03", count: 1 }]);
});

test("nothing is asked for when every rate exists", () => {
  const rt = setup();
  const t = trip(rt);
  entry(rt, t.id, "a", 40, "PEN", "2020-03-10");
  assert.deepEqual(rt.api("getTripDetail", { id: t.id }).missingRates, []);
});

test("the date finder can also look up to 12 months before the trip", () => {
  const rt = setup();
  const t = trip(rt);
  const add = (id, date) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date, amount: 10, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual" })});`);
  add("in-trip", "2020-03-10");
  add("six-before", "2019-09-20");
  add("eleven-before", "2019-04-02");
  add("too-early", "2019-01-15");
  const ids = (payload) => rt.api("findTripCandidates", { id: t.id, ...payload }).entries.map((e) => e.id).sort();
  assert.deepEqual(ids({}), ["in-trip"]);
  assert.deepEqual(ids({ lookBack: 12 }), ["eleven-before", "in-trip", "six-before"]);
  assert.deepEqual(ids({ lookBack: 999 }), ["eleven-before", "in-trip", "six-before", "too-early"], "capped at 24 months, which still reaches 14 months back");
  assert.deepEqual(rt.api("findTripCandidates", { id: t.id, lookBack: 12 }).entries.map((e) => e.id), ["in-trip", "six-before", "eleven-before"], "the trip's own dates first, then the nearest earlier ones");
  add("far-back", "2017-01-01");
  assert.ok(!ids({ lookBack: 999 }).includes("far-back"), "older than the 24-month cap stays out");
});

test("the app shows one button per missing rate, asks once per visit, and the finder offers the earlier months", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  const render = /function renderTripMissingRates_[\s\S]*?\n}\n/.exec(src)[0];
  assert.match(render, /d\.missingRates\.forEach/);
  assert.match(render, /tripRatePrompted_\[d\.trip\.id\]/, "the pop-up opens by itself only once");
  assert.match(/async function setTripDetailRate_[\s\S]*?\n}\n/.exec(src)[0], /openRateModal\(m\.currency, m\.month, \/\* required \*\/ false\)/, "and can be cancelled");
  assert.match(src, /findTripCandidates", \{ id, lookBack: lookBack \? 12 : 0 \}/);
});
