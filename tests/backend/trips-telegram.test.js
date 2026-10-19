// Trips & events through Telegram (2026-10-19):
//  - "trip <name>" / "trip none" on an expense card links / unlinks it (same whole-word name matcher);
//  - a pending expense dated inside exactly one trip shows a SUGGESTION on its card, never a link;
//  - a trip budget warns through Telegram at the chosen percentages, like category budgets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  let mid = 100;
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: ++mid } });
  const pending = data.entries.filter((e) => e.status === "pending" && e.type === "expense");
  const card = (id) => { rt.run(`sendTelegramEntryNotification_(getEntryById_(${JSON.stringify(id)}), null);`); return mid; };
  let n = 0;
  const say = (text) => rt.rawPost(JSON.stringify({ update_id: 8000 + (++n), message: { chat: { id: chat }, message_id: 950 + n, text } }));
  const sent = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");
  const entry = (id) => rt.rows("Entries").find((e) => e.id === id);
  return { rt, data, pending, card, say, sent, entry };
}
const cardText = (rt, id) => rt.run(`formatEntryForTelegram_(getEntryById_(${JSON.stringify(id)}), null)`);

test("\"trip Cusco\" links the pending expense, \"trip none\" unlinks it, an unknown name changes nothing", () => {
  const { rt, pending, card, say, entry } = setup();
  const e = pending[0];
  const cusco = rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: "2020-01-01", end_date: "2020-01-02" });
  rt.api("addTrip", { name: "Cumpleaños de Ana", kind: "event", start_date: "2020-02-01" });
  card(e.id);
  say("trip cusco");
  assert.equal(entry(e.id).trip_id, cusco.id);
  say("trip none");
  assert.match(cardText(rt, e.id), /Trip\/event: none \(it will not be linked\)/, "a pending skip is remembered and shown");
  say("viaje Cusco");                                          // Spanish keyword works too
  assert.equal(entry(e.id).trip_id, cusco.id);
  say("trip Atlantis");
  assert.equal(entry(e.id).trip_id, cusco.id, "an unknown name is not applied");
  say("event cumple");                                         // matches the other trip by word start
  assert.notEqual(entry(e.id).trip_id, cusco.id);
  assert.ok(entry(e.id).trip_id);
});

test("it combines with other edits, and a non-expense can't take a trip", () => {
  const { rt, data, pending, card, say, entry } = setup();
  const trip = rt.api("addTrip", { name: "Lima", kind: "trip", start_date: "2020-01-01" });
  const e = pending[1];
  card(e.id);
  say("description Taxi, trip Lima");
  assert.equal(entry(e.id).trip_id, trip.id);
  assert.equal(entry(e.id).description, "Taxi");

  const income = data.entries.find((x) => x.status === "pending" && x.type === "income");
  if (income) {
    card(income.id);
    say("trip Lima");
    assert.ok(!entry(income.id).trip_id, "income never belongs to a trip");
  }
});

test("a card shows the current trip, or — for a pending expense — the trip it WILL be linked to on Confirm", () => {
  const { rt, pending } = setup();
  const e = pending[0];
  const trip = rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: e.date, end_date: e.date });
  let text = cardText(rt, e.id);
  assert.match(text, /Will be linked to: ✈️ Cusco trip when you confirm — reply "trip none" to skip it/);
  assert.ok(!rt.rows("Entries").find((x) => x.id === e.id).trip_id, "the card only announces it; nothing is stored yet");

  rt.run(`ensureEntriesTripColumn_(); setEntryField_(${JSON.stringify(e.id)}, 'trip_id', '${trip.id}');`);
  text = cardText(rt, e.id);
  assert.match(text, /🧳 Trip\/event: ✈️ Cusco trip/);
  assert.doesNotMatch(text, /Will be linked/);

  rt.api("addTrip", { name: "Overlap", kind: "event", start_date: pending[2].date });
  const other = pending.find((p) => p.date === pending[2].date && p.type === "expense");
  const both = rt.api("addTrip", { name: "Overlap two", kind: "event", start_date: other.date });
  assert.doesNotMatch(cardText(rt, other.id), /Will be linked/, "two trips on the date: no default link");
  assert.ok(both.id);
});

test("trip budget alert: warns once per threshold crossed, quotes the live percentage, forgets after a fall", () => {
  const { rt, sent } = setup();
  rt.run(`appendRowObject('Categories', { id: 'cat-t', name: 'Trip cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const t = rt.api("addTrip", { name: "Budgeted", kind: "trip", start_date: "2020-03-01", end_date: new Date().toISOString().slice(0, 10), budget_amount: 1000, budget_currency: "PEN", alert_thresholds: "50, 100" });
  assert.equal(t.alert_thresholds, "50,100");
  const add = (id, amount) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: "2020-03-02", amount, currency: "PEN", category_id: "cat-t", description: id, paid_by: "me", status: "confirmed", source: "manual" })}); ensureEntriesTripColumn_(); setEntryField_('${id}', 'trip_id', '${t.id}');`);

  assert.equal(rt.run("checkTripBudgets()").alertsSent, 0, "nothing spent yet");
  add("a", 400);
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 0, "40% crosses nothing");
  add("b", 150);                                                // 55%
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 1);
  assert.match(sent(), /Budgeted: 55% of its PEN 1,000\.00 budget/);
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 0, "the same threshold is not repeated");
  add("c", 500);                                                // 105%: crosses 100
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 1);
  assert.match(sent(), /🚨 .*Budgeted: 105%/);

  rt.run("deleteEntry_('c');");                                 // falls back below 100 -> forgotten
  rt.run("checkTripBudgets()");
  add("d", 500);
  assert.equal(rt.run("checkTripBudgets()").alertsSent, 1, "crossing again warns again");
  rt.api("deleteTrip", { id: t.id });
  assert.equal(rt.rows("Budget Alert Log").filter((r) => r.budget_id === t.id).length, 0, "its log goes with it");
});

test("estimates count toward the alert; a trip without a budget, or long over, is ignored", () => {
  const { rt, sent } = setup();
  rt.run(`appendRowObject('Categories', { id: 'cat-t', name: 'Trip cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const today = new Date().toISOString().slice(0, 10);
  const t = rt.api("addTrip", { name: "Estimated", kind: "trip", start_date: today, end_date: today, budget_amount: 500, budget_currency: "PEN" });
  rt.api("addRecurringExpense", { category_id: "cat-t", description: "Hotel", amount: 450, currency: "PEN", frequency: "once", date: today, trip_id: t.id });
  rt.api("addTrip", { name: "No budget", kind: "trip", start_date: today });
  rt.api("addTrip", { name: "Ancient", kind: "trip", start_date: "2019-01-01", end_date: "2019-01-02", budget_amount: 1, budget_currency: "PEN" });
  const res = rt.run("checkTripBudgets()");
  assert.equal(res.alertsSent, 1);
  assert.equal(res.checked, 1, "only the budgeted, recent trip is looked at");
  assert.match(sent(), /Estimated: 90%/, "default thresholds include 75 — 90% warns");
});

test("bad alert percentages are refused in plain words, and a missing column on an old Trips tab is added", () => {
  const { rt } = setup();
  assert.throws(() => rt.api("addTrip", { name: "Bad", kind: "trip", start_date: "2026-01-01", budget_amount: 10, alert_thresholds: "75%" }), /positive numbers/);
  // an old tab without alert_thresholds
  rt.run(`var sh = getSheet('Trips'); var h = getHeaders(sh); sh.getRange(1, h.indexOf('alert_thresholds') + 1).clearContent();`);
  rt.run("tripsColumnsChecked_ = false;");
  rt.api("getMeta", {});
  assert.ok(rt.run("getHeaders(getSheet('Trips'))").includes("alert_thresholds"));
});

// ---- Confirm links the suggested trip by default (the card says so first) ----
function tap(rt, chat, entryId, action = "confirm") {
  return rt.rawPost(JSON.stringify({ update_id: 9000 + Math.floor(Math.random() * 1e6), callback_query: { id: "cb" + Math.random(), data: action + ":" + entryId, message: { chat: { id: chat }, message_id: 777 } } }));
}
function withCategory(rt, id) {
  rt.run(`appendRowObject('Categories', { id: 'cat-tg', name: 'Tg cat', type: 'expense', icon: '', color: '#ccc', parent_id: '' }); updateRowFields_('Entries', ${JSON.stringify(id)}, { category_id: 'cat-tg' });`);
}

test("the Confirm button confirms AND links the trip whose dates match", () => {
  const { rt, pending, entry } = setup();
  const chat = 555;
  const e = pending[0];
  withCategory(rt, e.id);
  const trip = rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: e.date, end_date: e.date });
  tap(rt, chat, e.id);
  assert.equal(entry(e.id).status, "confirmed");
  assert.equal(entry(e.id).trip_id, trip.id);
  assert.equal(rt.api("getTripDetail", { id: trip.id }).entryCount, 1);
  assert.match(cardText(rt, e.id), /Trip\/event: ✈️ Cusco trip/);
});

test("a reply that confirms the entry links the suggested trip too; \"trip none\" in it skips the link for good", () => {
  const { rt, pending, say, entry, card } = setup();
  const [a, b] = pending;
  [a, b].forEach((e) => withCategory(rt, e.id));
  const trip = rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: a.date, end_date: a.date });
  card(a.id);
  say("description Lunch");                                    // auto-confirms
  assert.equal(entry(a.id).status, "confirmed");
  assert.equal(entry(a.id).trip_id, trip.id, "the default link applies to a reply-confirmation");

  rt.api("updateTrip", { id: trip.id, name: "Cusco trip", kind: "trip", start_date: b.date, end_date: b.date });
  card(b.id);
  say("trip none");                                            // confirms, but skipped
  assert.equal(entry(b.id).status, "confirmed");
  assert.ok(!entry(b.id).trip_id, "the skip marker is gone and no trip is linked");
});

test("no default link when two trips cover the date, for an explicit choice, or for income", () => {
  const { rt, data, pending, entry } = setup();
  const chat = 555;
  const [a, b] = pending;
  [a, b].forEach((e) => withCategory(rt, e.id));
  rt.api("addTrip", { name: "One", kind: "trip", start_date: a.date, end_date: a.date });
  rt.api("addTrip", { name: "Two", kind: "event", start_date: a.date });
  tap(rt, chat, a.id);
  assert.ok(!entry(a.id).trip_id, "two trips: no guess");

  const chosen = rt.api("addTrip", { name: "Chosen", kind: "trip", start_date: "2001-01-01", end_date: "2001-01-02" });
  rt.api("updateEntry", { id: b.id, fields: { trip_id: chosen.id } });
  rt.api("addTrip", { name: "Matching", kind: "trip", start_date: b.date, end_date: b.date });
  tap(rt, chat, b.id);
  assert.equal(entry(b.id).trip_id, chosen.id, "a trip already chosen is never replaced");

  const income = data.entries.find((x) => x.status === "pending" && x.type === "income" && x.category_id);
  if (income) {
    rt.api("addTrip", { name: "Inc", kind: "trip", start_date: income.date, end_date: income.date });
    tap(rt, chat, income.id);
    assert.ok(!entry(income.id).trip_id, "income never joins a trip");
  }
});

test("the app's own Confirm is untouched: its explicit None stays None, and a leftover skip marker is cleared", () => {
  const { rt, pending, say, entry, card } = setup();
  const [a, b] = pending;
  [a, b].forEach((e) => withCategory(rt, e.id));
  rt.api("addTrip", { name: "Cusco trip", kind: "trip", start_date: a.date, end_date: a.date });
  rt.api("updateEntry", { id: a.id, fields: { trip_id: "" } });
  rt.api("confirmEntry", { id: a.id });
  assert.ok(!entry(a.id).trip_id, "the app's confirm does not link a suggestion");

  card(b.id);
  rt.run(`ensureEntriesTripColumn_(); setEntryField_(${JSON.stringify(b.id)}, 'trip_id', TRIP_DECLINED_);`);   // as left by a partial "trip none" reply
  rt.api("confirmEntry", { id: b.id });
  assert.ok(!entry(b.id).trip_id, "the marker never stays on a confirmed entry");
});
