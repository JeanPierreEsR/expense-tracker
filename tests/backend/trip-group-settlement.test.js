// Trips & events — GROUP SETTLEMENT (Splitwise-style trips). Each trip has one hidden "group" friend;
// what the owner fronts for the group is split with it, the trip counts only the owner's share, and the
// final transfer is a repayment with the group (never income) — except what goes beyond any debt.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Lodging test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const trip = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15", currency: "PEN" });
  const group = rt.rows("Friends").find((f) => f.trip_id === trip.id);
  const pay = data.pms[3].id;
  // An expense the owner paid, in the trip, with `groupShare` of it belonging to the group.
  const front = (id, amount, groupShare) => {
    const e = { id, type: "expense", date: "2026-12-11", amount, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual", trip_id: trip.id };
    rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
    rt.api("saveEntrySplits", { entryId: id, splits: groupShare ? [{ friend_id: group.id, amount: groupShare }] : [] });
  };
  const detail = () => rt.api("getTripDetail", { id: trip.id });
  return { rt, trip, group, pay, front, detail };
}

test("every trip gets one hidden group friend, named after it, and renamed with it", () => {
  const { rt, trip, group } = setup();
  assert.ok(group, "created with the trip");
  assert.match(group.name, /Cusco/);
  rt.api("updateTrip", { id: trip.id, name: "Machu Picchu", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15", currency: "PEN" });
  assert.match(rt.rows("Friends").find((f) => f.trip_id === trip.id).name, /Machu Picchu/);
  assert.equal(rt.rows("Friends").filter((f) => f.trip_id === trip.id).length, 1, "never a second one");
});

test("I paid more than my share: the trip counts my share, the group owes me the rest, a settlement clears it", () => {
  const { rt, trip, pay, front, detail } = setup();
  front("e1", 600, 350);   // paid 600, my share 250
  let d = detail();
  assert.equal(d.totalMain, 250);
  assert.equal(d.group.paidOut, 600);
  assert.equal(d.group.rows[0].pending, 350);

  const res = rt.api("recordTripSettlement", { trip_id: trip.id, direction: "received", amount: 350, date: "2026-12-20", payment_method_id: pay });
  assert.equal(res.overpaid, 0);
  d = detail();
  assert.equal(d.group.rows[0].pending, 0);
  assert.equal(d.totalMain, 250, "a settlement never changes the trip total");
  assert.equal(rt.rows("Entries").filter((e) => e.type === "income" && /Group settlement/.test(e.description)).length, 0, "never income");
});

test("a settlement is a transfer, not an expense or income", () => {
  const { rt, trip, pay, front } = setup();
  front("e1", 600, 350);
  rt.api("recordTripSettlement", { trip_id: trip.id, direction: "received", amount: 350, date: "2026-12-20", payment_method_id: pay });
  const moved = rt.rows("Entries").filter((e) => /Group settlement/.test(e.description));
  assert.equal(moved.length, 1);
  assert.equal(moved[0].type, "transfer");
});

test("I paid less than my share: paying the group becomes a trip expense (needs a category or waits in review)", () => {
  const { rt, trip, pay, detail } = setup();
  const res = rt.api("recordTripSettlement", { trip_id: trip.id, direction: "paid", amount: 150, date: "2026-12-20", payment_method_id: pay, overpay_category_id: "cat-a" });
  assert.equal(res.overpaid, 150);
  const e = rt.rows("Entries").find((x) => x.id === res.overpayment_entry.id);
  assert.equal(e.type, "expense");
  assert.equal(e.status, "confirmed");
  assert.equal(e.trip_id, trip.id, "linked to the trip");
  assert.equal(detail().totalMain, 150);
});

test("without a category the leftover waits in the review queue, still tagged with the trip", () => {
  const { rt, trip, pay } = setup();
  const res = rt.api("recordTripSettlement", { trip_id: trip.id, direction: "paid", amount: 90, date: "2026-12-20", payment_method_id: pay });
  const e = rt.rows("Entries").find((x) => x.id === res.overpayment_entry.id);
  assert.equal(e.status, "pending");
  assert.equal(e.trip_id, trip.id);
});

test("the group paying me MORE than owed leaves income (not linked to the trip)", () => {
  const { rt, trip, pay, front } = setup();
  front("e1", 600, 350);
  const res = rt.api("recordTripSettlement", { trip_id: trip.id, direction: "received", amount: 400, date: "2026-12-20", payment_method_id: pay });
  assert.equal(res.overpaid, 50);
  const e = rt.rows("Entries").find((x) => x.id === res.overpayment_entry.id);
  assert.equal(e.type, "income");
  assert.ok(!e.trip_id);
});

test("a partial settlement leaves the rest pending; a settlement for an unknown trip is refused", () => {
  const { rt, trip, pay, front, detail } = setup();
  front("e1", 600, 350);
  rt.api("recordTripSettlement", { trip_id: trip.id, direction: "received", amount: 300, date: "2026-12-20", payment_method_id: pay });
  assert.equal(detail().group.rows[0].pending, 50);
  assert.throws(() => rt.api("recordTripSettlement", { trip_id: "ghost", direction: "received", amount: 1, date: "2026-12-20" }));
});

test("deleting a trip removes an unused group friend but keeps one that still has a balance", () => {
  const { rt, trip, front } = setup();
  const other = rt.api("addTrip", { name: "Lima", kind: "trip", start_date: "2026-11-01", end_date: "2026-11-03", currency: "PEN" });
  rt.api("deleteTrip", { id: other.id });
  assert.ok(!rt.rows("Friends").some((f) => f.trip_id === other.id));
  assert.ok(!rt.rows("Friends").some((f) => /Lima/.test(f.name)), "gone completely");

  front("e1", 600, 350);
  rt.api("deleteTrip", { id: trip.id });
  const kept = rt.rows("Friends").find((f) => /Cusco/.test(f.name));
  assert.ok(kept, "still has a debt, so it stays");
  assert.ok(!kept.trip_id);
});

test("an older trip without a group friend gets one when the app loads its data", () => {
  const { rt } = freshApp({ entries: 5 });
  rt.run(`ensureTripsSheet_(); appendRowObject('Trips', { id: 'old', name: 'Old trip', kind: 'trip', start_date: '2026-01-01', end_date: '2026-01-02' });`);
  rt.api("getMeta");
  assert.equal(rt.rows("Friends").filter((f) => f.trip_id === "old").length, 1);
  rt.api("getMeta");
  assert.equal(rt.rows("Friends").filter((f) => f.trip_id === "old").length, 1, "never twice");
});

test("a normal friend's debt is separate from the group's", () => {
  const { rt, trip, pay, front, detail } = setup();
  const ana = rt.api("addFriend", { name: "Ana Test" });
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "solo", type: "expense", date: "2026-12-12", amount: 80, currency: "PEN", category_id: "cat-a", description: "solo", paid_by: "me", status: "confirmed", source: "manual", trip_id: trip.id })});`);
  rt.api("saveEntrySplits", { entryId: "solo", splits: [{ friend_id: ana.id, amount: 40 }] });
  front("e1", 600, 350);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-12-13", payment_method_id: pay });
  assert.equal(detail().group.rows[0].pending, 350, "Ana paying me directly does not touch the group");
});
