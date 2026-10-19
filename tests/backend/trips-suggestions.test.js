// Trips & events — suggestions by date (2026-10-19). Nothing links on its own:
//  - a pending expense whose date falls inside exactly ONE trip comes with a suggestion;
//    it is linked only when the owner confirms the entry with that trip chosen;
//  - "Find expenses in these dates" lists candidates; only the ticked ones are linked.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Meals test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const cusco = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15" });
  return { rt, cusco };
}
function entry(rt, id, over = {}) {
  const e = { id, type: "expense", date: "2026-12-12", amount: 100, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const pending = (rt, id) => rt.api("listPendingEntries", {}).find((e) => e.id === id);

test("a pending expense inside exactly one trip comes with a suggestion, and nothing is stored", () => {
  const { rt, cusco } = setup();
  entry(rt, "p-in", { status: "pending", date: "2026-12-11" });
  entry(rt, "p-out", { status: "pending", date: "2026-11-01" });
  entry(rt, "p-income", { status: "pending", date: "2026-12-11", type: "income" });
  assert.equal(pending(rt, "p-in").suggested_trip_id, cusco.id);
  assert.ok(!pending(rt, "p-out").suggested_trip_id);
  assert.ok(!pending(rt, "p-income").suggested_trip_id, "income never belongs to a trip");
  assert.ok(!rt.api("getEntry", { id: "p-in" }).trip_id, "a suggestion is not a link");
  assert.equal(rt.api("getTripDetail", { id: cusco.id }).totalMain, 0);
});

test("two trips covering the same date: no guess", () => {
  const { rt } = setup();
  rt.api("addTrip", { name: "Wedding", kind: "event", start_date: "2026-12-12" });
  entry(rt, "p-both", { status: "pending", date: "2026-12-12" });
  entry(rt, "p-one", { status: "pending", date: "2026-12-14" });
  assert.ok(!pending(rt, "p-both").suggested_trip_id);
  assert.ok(pending(rt, "p-one").suggested_trip_id);
});

test("an entry that already has a trip gets no suggestion; confirming with the trip chosen counts it", () => {
  const { rt, cusco } = setup();
  entry(rt, "p-has", { status: "pending", date: "2026-12-11" });
  rt.api("updateEntry", { id: "p-has", fields: { trip_id: cusco.id } });
  assert.ok(!pending(rt, "p-has").suggested_trip_id);

  entry(rt, "p-new", { status: "pending", date: "2026-12-11", amount: 55 });
  const before = rt.api("getTripDetail", { id: cusco.id }).totalMain;
  rt.api("updateEntry", { id: "p-new", fields: { trip_id: cusco.id } });   // what the review card sends on Confirm
  rt.api("confirmEntry", { id: "p-new" });
  assert.equal(rt.api("getTripDetail", { id: cusco.id }).totalMain, before + 55);
});

test("finding candidates lists only confirmed, trip-less expenses inside the dates", () => {
  const { rt, cusco } = setup();
  const other = rt.api("addTrip", { name: "Other", kind: "trip", start_date: "2026-12-12", end_date: "2026-12-13" });
  entry(rt, "c1", { date: "2026-12-10", amount: 40 });
  entry(rt, "c2", { date: "2026-12-15", amount: 200 });
  rt.run(`appendRowObject('Entry Splits', { id: 's1', entry_id: 'c2', friend_id: 'f-x', amount: 50 });`);
  entry(rt, "x-before", { date: "2026-12-09" });
  entry(rt, "x-after", { date: "2026-12-16" });
  entry(rt, "x-pending", { status: "pending" });
  entry(rt, "x-income", { type: "income" });
  entry(rt, "x-other", { date: "2026-12-12" });
  rt.api("updateEntry", { id: "x-other", fields: { trip_id: other.id } });

  const found = rt.api("findTripCandidates", { id: cusco.id });
  assert.equal(found.total, 2);
  assert.deepEqual(found.entries.map((e) => e.id), ["c1", "c2"], "oldest first");
  assert.equal(found.entries[1].own_share, 150, "my share only");
  assert.throws(() => rt.api("findTripCandidates", { id: "nope" }), /not found/i);
});

test("linking adds only the ticked ones, and never overwrites another trip or touches the wrong kind", () => {
  const { rt, cusco } = setup();
  const other = rt.api("addTrip", { name: "Other", kind: "trip", start_date: "2026-12-12", end_date: "2026-12-13" });
  entry(rt, "l1", { date: "2026-12-10", amount: 40 });
  entry(rt, "l2", { date: "2026-12-11", amount: 60 });
  entry(rt, "l-skipped", { date: "2026-12-11" });
  entry(rt, "l-other", { date: "2026-12-12" });
  rt.api("updateEntry", { id: "l-other", fields: { trip_id: other.id } });
  entry(rt, "l-pending", { status: "pending" });
  entry(rt, "l-income", { type: "income" });

  const res = rt.api("linkEntriesToTrip", { id: cusco.id, entryIds: ["l1", "l2", "l-other", "l-pending", "l-income", "ghost"] });
  assert.equal(res.linked, 2);
  assert.equal(rt.api("getEntry", { id: "l1" }).trip_id, cusco.id);
  assert.equal(rt.api("getEntry", { id: "l2" }).trip_id, cusco.id);
  assert.ok(!rt.api("getEntry", { id: "l-skipped" }).trip_id, "not ticked, not linked");
  assert.equal(rt.api("getEntry", { id: "l-other" }).trip_id, other.id);
  assert.ok(!rt.api("getEntry", { id: "l-pending" }).trip_id);
  assert.ok(!rt.api("getEntry", { id: "l-income" }).trip_id);
  assert.equal(rt.api("getTripDetail", { id: cusco.id }).totalMain, 100);

  assert.equal(rt.api("linkEntriesToTrip", { id: cusco.id, entryIds: ["l1", "l2"] }).linked, 0, "a second tap changes nothing");
  assert.equal(rt.api("findTripCandidates", { id: cusco.id }).entries.some((e) => e.id === "l-skipped"), true);
});
