// First-use Trips & events practice: its cleanup deletes only what carries the marker, and the practice trip is silent
// (no budget alert, no notice, no Telegram, never a suggestion for a real entry). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram, today } = require("./helpers");

function plusDays(n) { const d = new Date(today() + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const sent = (rt) => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const cat = data.cats.find((c) => c.type === "expense");
  const pm = data.pms[3].id;
  const spend = (description, amount, tripId, date = today()) =>
    rt.api("createEntry", { type: "expense", date, amount, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: pm, trip_id: tripId || "" });
  const mkTrip = (name, extra = {}) => rt.api("addTrip", Object.assign({ name, kind: "trip", start_date: today(), end_date: plusDays(2) }, extra));
  return { rt, data, cat, pm, spend, mkTrip };
}

test("capability: a backend that can clean the Trips practice up says so", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta").capabilities.practiceTrips, true);
});

test("removePracticeTrips deletes the practice trip (either language), its group friend and its expense; a real trip and real entries stay", () => {
  const { rt, spend, mkTrip } = setup();
  const mine = mkTrip("Practice trip", { budget_amount: 300, budget_currency: "PEN" });
  const es = mkTrip("Viaje de práctica");
  const real = mkTrip("Cusco trip");
  rt.api("getMeta");   // makes every trip's hidden group friend
  const myExpense = spend("Practice trip expense", 40, mine.id);
  const esExpense = spend("Gasto de viaje de práctica", 10, es.id);
  const realOnReal = spend("Hotel", 90, real.id);
  const realOnMine = spend("Real lunch", 30, mine.id);   // a REAL entry the person linked to the practice trip
  const lookalike = spend("Practice trip expense dinner", 5, "");   // not exactly the marker
  const oldMarker = spend("Practice trip expense", 7, "", plusDays(-5));   // before the practice started: not its own
  const friendsBefore = rt.rows("Friends").length;
  const entriesBefore = rt.rows("Entries").length;
  assert.ok(rt.rows("Friends").some((f) => f.trip_id === mine.id), "the practice trip got its hidden group friend");

  const res = rt.api("removePracticeTrips", { started_on: today() });
  assert.deepEqual(res, { trips: 2, entries: 2, unlinked: 1 });
  const trips = rt.rows("Trips").map((t) => t.id);
  assert.ok(!trips.includes(mine.id) && !trips.includes(es.id), "both practice trips are gone");
  assert.ok(trips.includes(real.id), "a real trip stays");
  const ids = rt.rows("Entries").map((e) => e.id);
  assert.ok(!ids.includes(myExpense.id) && !ids.includes(esExpense.id), "the practice expenses are gone");
  for (const e of [realOnReal, realOnMine, lookalike, oldMarker]) assert.ok(ids.includes(e.id), "a real entry is never deleted: " + e.id);
  assert.equal(rt.rows("Entries").length, entriesBefore - 2);
  assert.equal(String(rt.rows("Entries").find((e) => e.id === realOnMine.id).trip_id || ""), "", "the real entry is only unlinked");
  assert.equal(rt.rows("Entries").find((e) => e.id === realOnReal.id).trip_id, real.id, "and the real trip's link is untouched");
  assert.equal(rt.rows("Friends").length, friendsBefore - 2, "the two hidden group friends went with their trips");
  assert.ok(rt.rows("Friends").some((f) => f.trip_id === real.id), "the real trip keeps its group friend");
  assert.deepEqual(rt.api("removePracticeTrips", { started_on: today() }), { trips: 0, entries: 0, unlinked: 0 }, "a repeat is harmless");
});

test("a practice left before the trip was saved, or with no started_on, removes what it finds and nothing else", () => {
  const { rt, spend } = setup();
  assert.deepEqual(rt.api("removePracticeTrips", {}), { trips: 0, entries: 0, unlinked: 0 });
  const e = spend("Practice trip expense", 12, "");   // saved without a trip (the trip was deleted by hand first)
  const keep = spend("Lunch", 12, "");
  const res = rt.api("removePracticeTrips", {});
  assert.equal(res.entries, 1);
  const ids = rt.rows("Entries").map((x) => x.id);
  assert.ok(!ids.includes(e.id) && ids.includes(keep.id));
});

test("the practice trip never sends a budget alert (no notice, no Telegram, no log); a real trip still does", () => {
  const { rt, spend, mkTrip } = setup();
  linkTelegram(rt);
  let mid = 100;
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: ++mid } });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const mine = mkTrip("Practice trip", { budget_amount: 100, budget_currency: "PEN", alert_thresholds: "50, 100" });
  spend("Practice trip expense", 500, mine.id);   // 500% of its budget
  const before = rt.api("listNotices").notices.length;
  const res = rt.run("checkTripBudgets()");
  assert.equal(res.alertsSent, 0);
  assert.equal(res.checked, 0, "it is not even looked at");
  assert.equal(rt.rows("Budget Alert Log").filter((r) => r.budget_id === mine.id).length, 0);
  assert.equal(rt.api("listNotices").notices.length, before, "no notice on Home");
  assert.doesNotMatch(sent(rt), /Practice trip/, "nothing went to Telegram");
  rt.run("checkAlertsGuarded_('timer')");   // the hourly path
  assert.doesNotMatch(sent(rt), /Practice trip/);

  const real = mkTrip("Cusco trip", { budget_amount: 100, budget_currency: "PEN", alert_thresholds: "50" });
  spend("Hotel", 80, real.id);
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 1, "a real trip is still watched");
  assert.match(sent(rt), /Cusco trip/);
  assert.doesNotMatch(sent(rt), /Practice trip/);
});

test("the practice trip is never suggested for a real entry, and does not make a real trip ambiguous", () => {
  const { rt, data, mkTrip } = setup();
  const chat = linkTelegram(rt);
  void chat;
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: 1 } });
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense");
  const mine = rt.api("addTrip", { name: "Practice trip", kind: "trip", start_date: pending.date, end_date: pending.date });
  const card = () => rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(pending.id)}), null)`);
  assert.doesNotMatch(card(), /Will be linked/, "alone: nothing to suggest");
  assert.equal(rt.run(`suggestedTripIdForDate_(${JSON.stringify(pending.date)})`), "");
  const real = rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: pending.date, end_date: pending.date });
  assert.match(card(), /Will be linked to: ✈️ Cusco trip/, "a real trip on the same day is still the one suggestion");
  assert.equal(rt.run(`suggestedTripIdForDate_(${JSON.stringify(pending.date)})`), real.id);
  assert.ok(mine.id && mkTrip);
  const listed = rt.api("listPendingEntries", {}).find((e) => e.id === pending.id);
  assert.equal(listed.suggested_trip_id, real.id, "the review queue suggests the real trip too");
});
