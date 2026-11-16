// "split group" in reply words (owner, 2026-11-16, after "split with the group" failed on WhatsApp): the trip's group, divided by
// its people like the app's "People in the group" box (groupEqualShares_). Same engine for Telegram and WhatsApp. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup({ size = 4 } = {}) {
  const { rt } = freshApp({ small: true });
  if (!rt.rows("Categories").some((c) => c.name === "Lodging")) rt.run(`appendRowObject("Categories", { id: "cat-lodging", name: "Lodging", type: "expense" })`);
  const trip = rt.api("addTrip", { name: "Costa Rica 2026", start_date: "2026-12-06", end_date: "2026-12-13", currency: "USD", group_size: size });
  const tripId = trip.id || rt.rows("Trips").find((t) => t.name === "Costa Rica 2026").id;
  rt.run(`setTripGroupSize_(${JSON.stringify(tripId)}, ${size})`);   // the trip's "People in the group", as the app's form stores it
  assert.equal(Number(rt.rows("Trips").find((t) => t.id === tripId).group_size), size);
  const add = (amount, date) => {
    const id = "e-" + Math.random().toString(36).slice(2);
    rt.run(`appendRowObject("Entries", { id: "${id}", type: "expense", date: "${date || "2026-11-16"}", amount: ${amount}, currency: "USD", description: "AIRBNB HM5", status: "pending", source: "email", paid_by: "me", created_at: "2026-11-16T18:23:00" })`);
    return id;
  };
  const reply = (id, text) => rt.run(`applyEditCommand_(${JSON.stringify(id)}, ${JSON.stringify(text)})`);
  const entry = (id) => rt.rows("Entries").find((e) => e.id === id);
  const splits = (id) => rt.run(`getEntrySplits(${JSON.stringify(id)})`).map((s) => ({ who: (rt.rows("Friends").find((f) => f.id === s.friend_id) || {}).name, amount: Number(s.amount) }));
  return { rt, tripId, add, reply, entry, splits };
}

test("the owner's exact reply now works: the group of 4 owes three shares, and it is confirmed", () => {
  const a = setup();
  const id = a.add(128.5);
  const r = a.reply(id, "adelanto Airbnb Manuel Antonio (Quepos) - del 8/12 al 10/12, category lodging, trip Costa Rica 2026, split with the group");
  assert.deepEqual(a.splits(id), [{ who: "Costa Rica 2026 group", amount: 96.39 }]);   // 128.50 / 4 = 32.13 each (app's rounding), you keep 32.11
  assert.equal(a.entry(id).trip_id, a.tripId);
  assert.equal(a.entry(id).status, "confirmed");
  assert.ok(!/bot\.field\./.test(r.message || ""), "no untranslated field name: " + r.message);
});

test("'split group', 'grupo', 'con el grupo', 'equal group' and a people count", () => {
  for (const [words, expected] of [["split group", 75], ["repartir grupo", 75], ["repartir con el grupo", 75], ["split equal group", 75], ["split group 5", 80], ["repartir grupo 2", 50]]) {
    const a = setup();
    const id = a.add(100);
    a.reply(id, `trip Costa Rica 2026, ${words}`);
    assert.deepEqual(a.splits(id), [{ who: "Costa Rica 2026 group", amount: expected }], words);
  }
});

test("a people count given in the reply becomes the trip's number, like on the app's form", () => {
  const a = setup();
  const id = a.add(100);
  a.reply(id, "trip Costa Rica 2026, split group 5");
  assert.equal(Number(a.rt.rows("Trips").find((t) => t.id === a.tripId).group_size), 5);
});

test("written in any order: the split waits for the trip set in the same reply", () => {
  const a = setup();
  const id = a.add(100);
  a.reply(id, "split with the group, trip Costa Rica 2026, category lodging");
  assert.deepEqual(a.splits(id), [{ who: "Costa Rica 2026 group", amount: 75 }]);
});

test("on the trip's dates, 'split group' finds the trip by itself", () => {
  const a = setup();
  const id = a.add(100, "2026-12-08");
  a.reply(id, "split group");
  assert.deepEqual(a.splits(id), [{ who: "Costa Rica 2026 group", amount: 75 }]);
});

test("'split equal <group name>' now divides by the group's people, not 50/50", () => {
  const a = setup();
  const id = a.add(128.5);
  a.reply(id, "trip Costa Rica 2026, split equal Costa Rica 2026 group");
  assert.deepEqual(a.splits(id), [{ who: "Costa Rica 2026 group", amount: 96.39 }]);
});

test("no trip on the entry and none on its date: 'split group' cannot apply, nothing is split, not confirmed", () => {
  const a = setup();
  const id = a.add(100, "2026-11-16");
  const r = a.reply(id, "category lodging, split group");
  assert.deepEqual(a.splits(id), []);
  assert.equal(a.entry(id).status, "pending");
  assert.match(r.message, /split group/);
});

test("ordinary friends and 'me' still work as before", () => {
  const a = setup();
  const friend = a.rt.rows("Friends").find((f) => !f.trip_id);
  const id = a.add(100);
  a.reply(id, `split equal ${friend.name}`);
  assert.deepEqual(a.splits(id), [{ who: friend.name, amount: 50 }]);
});
