// A trip group split counts its people (owner, 2026-11-15): the number used is stored on the trip (Trips.group_size)
// by the same save, so the next expense starts at it; a bad number is ignored and never fails the save.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("saveEntryAll stores the group's head count on the trip, with the split", () => {
  const { rt } = freshApp({ entries: 50 });
  const trip = rt.api("addTrip", { name: "Beach", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-05" });
  const group = rt.rows("Friends").find((f) => f.trip_id === trip.id);
  const cat = rt.rows("Categories").find((c) => c.type === "expense");
  const out = rt.api("saveEntryAll", {
    kind: "create",
    fields: { type: "expense", amount: 100, currency: "PEN", date: "2020-03-02", category_id: cat.id, paid_by: "me", trip_id: trip.id, description: "Dinner", client_id: "c-group-size-1" },
    splits: [{ friend_id: group.id, amount: 75 }],
    trip_group_size: { trip_id: trip.id, size: 4 }
  });
  assert.ok(out.id);
  assert.equal(Number(rt.rows("Trips").find((t) => t.id === trip.id).group_size), 4);
  assert.equal(Number(rt.rows("Entry Splits").find((s) => s.entry_id === out.id).amount), 75);

  rt.api("saveEntryAll", { kind: "update", id: out.id, fields: { description: "Dinner 2" }, trip_group_size: { trip_id: trip.id, size: 1 } });
  assert.equal(Number(rt.rows("Trips").find((t) => t.id === trip.id).group_size), 4, "a number below 2 is ignored");
  rt.api("saveEntryAll", { kind: "update", id: out.id, fields: { description: "Dinner 3" }, trip_group_size: { trip_id: "nope", size: 5 } });
  assert.equal(rt.rows("Entries").find((e) => e.id === out.id).description, "Dinner 3", "an unknown trip never fails the save");
});
