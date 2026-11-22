// A new trip opens at once with "Find expenses in these dates" (owner, 2026-11-14): addTrip with _open brings the trip's screen and
// the finder's list in the same answer, so save → link is ONE call. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("addTrip with _open returns the trip, its screen and the expenses in its dates; without it, just the trip", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'X test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const e = { id: "toc1", type: "expense", date: today(), amount: 25, currency: "PEN", category_id: "cat-x", description: "lunch", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  const made = rt.api("addTrip", { name: "Open test", kind: "trip", start_date: today(), end_date: today(), _open: { lookBack: 0 } });
  assert.ok(made.id);
  assert.equal(made.opened.detail.trip.id, made.id);
  assert.ok(made.opened.found.entries.some((x) => x.id === "toc1"));
  assert.equal(made._open, undefined);
  const plain = rt.api("addTrip", { name: "Plain test", kind: "trip", start_date: today(), end_date: today() });
  assert.equal(plain.opened, undefined);
  assert.equal(rt.api("getMeta", {}).capabilities.tripOpenOnCreate, true);
});
