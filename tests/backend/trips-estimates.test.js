// Trips & events — ESTIMATES (2026-10-19): a one-time Programmed item can sit inside a trip
// or event as the owner's estimated share (e.g. a friend paid in advance and has not said how
// much it is). It counts in the trip total until a real entry pays it; a payment that is not
// in the trip yet is offered, never linked on its own.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Lodging test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-inc', name: 'Gift income test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  const trip = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15" });
  return { rt, trip };
}
const once = (rt, over = {}) => rt.api("addRecurringExpense", {
  category_id: "cat-a", description: "Friend's hotel", amount: 400, currency: "PEN", frequency: "once", date: "2026-12-11", ...over
});
function entry(rt, id, over = {}) {
  const e = { id, type: "expense", date: "2026-12-11", amount: 400, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}

test("only a one-time EXPENSE item with a real trip keeps the trip link", () => {
  const { rt, trip } = setup();
  assert.equal(once(rt, { trip_id: trip.id }).trip_id, trip.id);
  assert.equal(once(rt, { trip_id: "ghost" }).trip_id, "", "unknown trip");
  assert.equal(once(rt, { trip_id: trip.id, category_id: "cat-inc" }).trip_id, "", "income never belongs to a trip");
  const monthly = rt.api("addRecurringExpense", { category_id: "cat-a", description: "Gym", amount: 80, currency: "PEN", frequency: "monthly", day: 5, trip_id: trip.id });
  assert.equal(monthly.trip_id, "", "a repeating item is not a trip estimate");
  assert.equal(rt.api("listRecurringExpenses", {}).filter((r) => r.trip_id === trip.id).length, 1);
});

test("changing an item's frequency or category drops the link; editing keeps it", () => {
  const { rt, trip } = setup();
  const r = once(rt, { trip_id: trip.id });
  rt.api("updateRecurringExpense", { id: r.id, amount: 450 });
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === r.id).trip_id, trip.id);
  rt.api("updateRecurringExpense", { id: r.id, trip_id: "" });
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === r.id).trip_id, "");
  rt.api("updateRecurringExpense", { id: r.id, trip_id: trip.id });
  rt.api("updateRecurringExpense", { id: r.id, frequency: "monthly", day: 3 });
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === r.id).trip_id, "");
});

test("an unpaid estimate counts in the trip total, by its own date, at the owner's share", () => {
  const { rt, trip } = setup();
  entry(rt, "real1", { amount: 100, date: "2026-12-12", trip_id: trip.id });
  rt.run(`ensureEntriesTripColumn_(); setEntryField_('real1', 'trip_id', '${trip.id}');`);
  const r = once(rt, { trip_id: trip.id, amount: 400, date: "2026-12-11" });
  rt.api("saveRecurringExpenseSplits", { recurringExpenseId: r.id, splits: [{ friend_id: "friend-x", amount: 100 }] });   // 300 is mine
  const past = once(rt, { trip_id: trip.id, amount: 200, date: "2026-08-01", description: "Flights (paid by a friend)" });   // backdated is fine

  const d = rt.api("getTripDetail", { id: trip.id });
  assert.equal(d.totalMain, 100 + 300 + 200);
  assert.equal(d.estimatedMain, 500);
  assert.equal(d.before, 200);
  assert.equal(d.during, 400);
  assert.equal(d.entryCount, 1, "only real entries are counted as entries");
  assert.deepEqual(d.estimates.map((e) => [e.id, e.amount]), [[past.id, 200], [r.id, 300]], "sorted by date, owner's share");
  assert.equal(d.estimates[0].overdue, true);

  const list = rt.api("listTrips", {});
  assert.equal(list[0].spentMain, 600);
  assert.equal(list[0].estimatedMain, 500);
  assert.equal(list[0].estimateCount, 2);
  assert.equal(list[0].entryCount, 1);
});

test("the trip budget includes the estimates", () => {
  const { rt } = setup();
  const t = rt.api("addTrip", { name: "Budgeted", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15", budget_amount: 1000, budget_currency: "PEN" });
  once(rt, { trip_id: t.id, amount: 250 });
  assert.equal(rt.api("getTripDetail", { id: t.id }).budgetSpent, 250);
});

test("a real payment that matches the estimate replaces it and is offered for the trip — never linked on its own", () => {
  const { rt, trip } = setup();
  const r = once(rt, { trip_id: trip.id, amount: 400, date: "2026-12-11" });
  entry(rt, "paid", { amount: 410, date: "2026-12-12" });   // same category, within 10% and 5 days, but not in the trip
  let d = rt.api("getTripDetail", { id: trip.id });
  assert.equal(d.estimates.length, 0, "no longer an estimate");
  assert.equal(d.totalMain, 0, "and not counted until the owner adds the payment");
  assert.equal(d.unlinkedPayments.length, 1);
  assert.equal(d.unlinkedPayments[0].entry.id, "paid");

  rt.api("updateEntry", { id: "paid", fields: { trip_id: trip.id } });   // the owner taps "Add to trip"
  d = rt.api("getTripDetail", { id: trip.id });
  assert.equal(d.unlinkedPayments.length, 0);
  assert.equal(d.totalMain, 410);
  assert.equal(d.entryCount, 1);
  assert.equal(rt.api("listRecurringExpenses", {}).find((x) => x.id === r.id).trip_id, trip.id, "the item itself is untouched");
});

test("a payment that is too different, or too far away, does not replace the estimate", () => {
  const { rt, trip } = setup();
  once(rt, { trip_id: trip.id, amount: 400, date: "2026-12-11" });
  entry(rt, "far-amount", { amount: 900, date: "2026-12-11" });
  entry(rt, "far-date", { amount: 400, date: "2026-12-30" });
  const d = rt.api("getTripDetail", { id: trip.id });
  assert.equal(d.estimates.length, 1);
  assert.equal(d.unlinkedPayments.length, 0);
  assert.equal(d.totalMain, 400);
});

test("a payment already in ANOTHER trip is not offered", () => {
  const { rt, trip } = setup();
  const other = rt.api("addTrip", { name: "Other", kind: "event", start_date: "2026-12-11" });
  once(rt, { trip_id: trip.id });
  entry(rt, "elsewhere", { amount: 400 });
  rt.api("updateEntry", { id: "elsewhere", fields: { trip_id: other.id } });
  const d = rt.api("getTripDetail", { id: trip.id });
  assert.equal(d.unlinkedPayments.length, 0);
  assert.equal(d.totalMain, 0);
});

test("\"Mark as paid\" (explicit link) brings the payment into the trip when it has none", () => {
  const { rt, trip } = setup();
  const r = once(rt, { trip_id: trip.id, amount: 400, date: "2026-12-11" });
  entry(rt, "odd", { amount: 777, date: "2026-12-20" });   // nothing automatic would match this
  rt.api("linkEntryToRecurring", { entryId: "odd", recurringExpenseId: r.id });
  assert.equal(rt.api("getEntry", { id: "odd" }).trip_id, trip.id);

  entry(rt, "owned", { amount: 777, date: "2026-12-20" });
  const other = rt.api("addTrip", { name: "Other", kind: "trip", start_date: "2026-12-20", end_date: "2026-12-21" });
  rt.api("updateEntry", { id: "owned", fields: { trip_id: other.id } });
  rt.api("linkEntryToRecurring", { entryId: "owned", recurringExpenseId: r.id });
  assert.equal(rt.api("getEntry", { id: "owned" }).trip_id, other.id, "an entry that already has a trip keeps it");
});

test("a paused estimate does not count; deleting the trip unlinks its estimates and deletes none", () => {
  const { rt, trip } = setup();
  const keep = once(rt, { trip_id: trip.id });
  const paused = once(rt, { trip_id: trip.id, description: "Paused" });
  rt.api("updateRecurringExpense", { id: paused.id, active: false });
  assert.equal(rt.api("getTripDetail", { id: trip.id }).estimates.length, 1);

  rt.api("deleteTrip", { id: trip.id });
  const items = rt.api("listRecurringExpenses", {});
  assert.equal(items.find((x) => x.id === keep.id).trip_id, "");
  assert.ok(items.find((x) => x.id === paused.id), "no estimate is deleted");
});
