// Trips & events (2026-10-19): a named period that expenses can be linked to.
//  - Only the owner's share of a confirmed EXPENSE counts; other types never do.
//  - Totals split into before / during / after the trip's dates, by the entry's own date.
//  - An entry links to at most one trip; deleting a trip unlinks, never deletes, expenses.
//  - Bad input (no name, bad dates, end before start, bad budget) is refused in plain words.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Flights test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-b', name: 'Meals test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  return rt;
}
function entry(rt, id, over = {}) {
  const e = { id, type: "expense", date: "2026-12-12", amount: 100, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const link = (rt, ids, tripId) => rt.run(`ensureEntriesTripColumn_(); ${JSON.stringify(ids)}.forEach(function (id) { setEntryField_(id, 'trip_id', ${JSON.stringify(tripId)}); });`);
const trip = (rt, over = {}) => rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15", ...over });

test("a trip is created, listed in getMeta and edited", () => {
  const rt = setup();
  const t = trip(rt, { emoji: "🏔️" });
  assert.ok(t.id);
  assert.equal(t.kind, "trip");
  const meta = rt.api("getMeta", {});
  assert.deepEqual(meta.trips.map((x) => x.name), ["Cusco"]);
  assert.equal(meta.trips[0].start_date, "2026-12-10", "dates come back as plain text, not Sheets dates");

  rt.api("updateTrip", { id: t.id, name: "Cusco & Lima", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-18" });
  assert.equal(rt.api("getMeta", {}).trips[0].name, "Cusco & Lima");
  assert.equal(rt.api("getMeta", {}).trips[0].end_date, "2026-12-18");
});

test("an event can last one day: a missing end date means the same day", () => {
  const rt = setup();
  const t = rt.api("addTrip", { name: "Ana's birthday", kind: "event", start_date: "2026-11-03" });
  assert.equal(t.end_date, "2026-11-03");
  assert.equal(t.kind, "event");
});

test("bad input is refused in plain words", () => {
  const rt = setup();
  assert.throws(() => trip(rt, { name: "  " }), /name/i);
  assert.throws(() => trip(rt, { start_date: "" }), /start date/i);
  assert.throws(() => trip(rt, { start_date: "2026-13-40" }), /start date/i);
  assert.throws(() => trip(rt, { end_date: "2026-12-01" }), /before the start/i);
  assert.throws(() => trip(rt, { budget_amount: "-5" }), /budget/i);
  assert.throws(() => trip(rt, { budget_amount: 500, budget_currency: "SOLES" }), /3-letter/i);
  assert.throws(() => rt.api("getTripDetail", { id: "nope" }), /not found/i);
});

test("totals use the owner's share of confirmed expenses only, split before / during / after", () => {
  const rt = setup();
  const t = trip(rt);
  entry(rt, "e-before", { date: "2026-08-01", amount: 1200 });                       // ticket bought months ahead
  entry(rt, "e-during1", { date: "2026-12-11", amount: 80, category_id: "cat-b" });
  entry(rt, "e-during2", { date: "2026-12-11", amount: 40, category_id: "cat-b" });
  entry(rt, "e-split", { date: "2026-12-12", amount: 200, category_id: "cat-b" });   // half goes to a friend
  rt.run(`appendRowObject('Entry Splits', { id: 's1', entry_id: 'e-split', friend_id: 'friend-x', amount: 100 });`);
  entry(rt, "e-after", { date: "2026-12-20", amount: 30 });
  entry(rt, "e-pending", { date: "2026-12-12", amount: 999, status: "pending" });
  entry(rt, "e-income", { date: "2026-12-12", amount: 777, type: "income" });
  entry(rt, "e-unlinked", { date: "2026-12-12", amount: 555 });
  link(rt, ["e-before", "e-during1", "e-during2", "e-split", "e-after", "e-pending", "e-income"], t.id);

  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.before, 1200);
  assert.equal(d.during, 80 + 40 + 100, "the friend's half of the split is not mine");
  assert.equal(d.after, 30);
  assert.equal(d.totalMain, 1200 + 220 + 30);
  assert.equal(d.entryCount, 5, "pending and income are not counted");
  const cats = Object.fromEntries(d.byCategory.map((c) => [c.name, c.amount_pen]));
  assert.equal(cats["Flights test"], 1230);
  assert.equal(cats["Meals test"], 220);
  assert.deepEqual(d.byDay.map((x) => x.date), ["2026-08-01", "2026-12-11", "2026-12-12", "2026-12-20"]);
  assert.equal(d.byDay.find((x) => x.date === "2026-12-11").amount_main, 120);

  const list = rt.api("listTrips", {});
  assert.equal(list[0].entryCount, 5);
  assert.equal(list[0].spentMain, 1450);
});

test("the trip's own budget is measured in its currency", () => {
  const rt = setup();
  const t = trip(rt, { budget_amount: 2000, budget_currency: "PEN" });
  entry(rt, "b1", { amount: 500 });
  entry(rt, "b2", { amount: 250, date: "2026-12-14" });
  link(rt, ["b1", "b2"], t.id);
  const d = rt.api("getTripDetail", { id: t.id });
  assert.equal(d.budgetSpent, 750);
  assert.equal(d.trip.budget_amount, 2000);

  const noBudget = trip(rt, { name: "No budget" });
  assert.equal(rt.api("getTripDetail", { id: noBudget.id }).budgetSpent, null);
});

test("createEntry and updateEntry link an expense to a trip; unknown trips and other types are ignored", () => {
  const rt = setup();
  const t = trip(rt);
  const base = { date: "2026-12-11", amount: 60, currency: "PEN", category_id: "cat-a", paid_by: "me" };
  const linked = rt.api("createEntry", { ...base, type: "expense", trip_id: t.id });
  assert.equal(linked.trip_id, t.id);
  const unknown = rt.api("createEntry", { ...base, type: "expense", trip_id: "ghost" });
  assert.ok(!unknown.trip_id);
  const income = rt.api("createEntry", { ...base, type: "income", trip_id: t.id });
  assert.ok(!income.trip_id, "income never belongs to a trip");

  rt.api("updateEntry", { id: unknown.id, fields: { trip_id: t.id } });
  assert.equal(rt.api("getEntry", { id: unknown.id }).trip_id, t.id);
  rt.api("updateEntry", { id: unknown.id, fields: { trip_id: "ghost" } });
  assert.equal(rt.api("getEntry", { id: unknown.id }).trip_id, "", "an unknown trip clears the link");
  rt.api("updateEntry", { id: linked.id, fields: { trip_id: "" } });
  assert.equal(rt.api("getEntry", { id: linked.id }).trip_id, "");
});

test("listEntries can filter by trip, and the search copy carries the trip and finds it by name", () => {
  const rt = setup();
  const t = trip(rt, { name: "Zanzibar" });
  entry(rt, "l1", { date: "2026-12-11" });
  entry(rt, "l2", { date: "2026-12-11" });
  link(rt, ["l1"], t.id);
  assert.deepEqual(rt.api("listEntries", { tripId: t.id }).map((e) => e.id), ["l1"]);
  const found = rt.api("listEntries", { search: "zanzibar" }).map((e) => e.id);
  assert.deepEqual(found, ["l1"]);
  const idx = rt.api("listEntrySearchIndex", {}).find((e) => e.id === "l1");
  assert.equal(idx.trip_id, t.id);
});

test("deleting a trip unlinks its expenses and deletes none of them", () => {
  const rt = setup();
  const t = trip(rt);
  const other = trip(rt, { name: "Other" });
  entry(rt, "d1");
  entry(rt, "d2");
  link(rt, ["d1"], t.id);
  link(rt, ["d2"], other.id);
  rt.api("deleteTrip", { id: t.id });
  assert.deepEqual(rt.api("getMeta", {}).trips.map((x) => x.name), ["Other"]);
  assert.equal(rt.api("getEntry", { id: "d1" }).trip_id, "");
  assert.equal(rt.api("getEntry", { id: "d2" }).trip_id, other.id, "another trip's links are untouched");
  assert.equal(rt.api("getEntry", { id: "d1" }).status, "confirmed");
});

test("the CSV export has a Trip / event column and the backup includes the Trips tab", () => {
  const rt = setup();
  const t = trip(rt, { name: "Cusco" });
  entry(rt, "x1");
  link(rt, ["x1"], t.id);
  const csv = rt.run(`buildEntriesCsv_({ includePending: false })`).text;
  const header = csv.split("\r\n")[0].split(",");
  const col = header.indexOf("Trip / event");
  assert.ok(col > -1);
  const row = csv.split("\r\n").find((l) => l.startsWith("x1,"));
  assert.equal(row.split(",")[col], "Cusco");
  const backup = JSON.parse(rt.run(`buildBackupJson_(new Date()).text`));
  assert.equal(backup.tables.Trips.length, 1);
});
