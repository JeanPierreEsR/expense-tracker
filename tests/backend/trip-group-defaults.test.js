// On the dates of a trip, a Repayment / New loan with no friend named means THAT trip's group:
//  - Telegram: "repayment" / "loan" with no name on a card dated inside exactly one trip;
//  - the entry form's friend picker starts on that group (source guard; the screen was checked in a browser).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const chat = linkTelegram(rt);
  let mid = 100;
  rt.state.fetchHandler = () => ({ ok: true, result: { message_id: ++mid } });
  const pending = data.entries.filter((e) => e.status === "pending" && e.type === "expense");
  const card = (id) => { rt.run(`sendTelegramEntryNotification_(getEntryById_(${JSON.stringify(id)}), null);`); return mid; };
  let n = 0;
  const say = (text) => rt.rawPost(JSON.stringify({ update_id: 9000 + (++n), message: { chat: { id: chat }, message_id: 1950 + n, text } }));
  const sent = () => rt.svc.fetchLog.map((f) => String(f.options.payload)).join("\n");
  return { rt, pending, card, say, sent };
}

test("\"repayment\" with no name, on the dates of one trip, pays that trip's group", () => {
  const { rt, pending, card, say } = setup();
  const trip = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-05" });
  const group = rt.rows("Friends").find((f) => f.trip_id === trip.id);
  const e = pending[0];
  rt.run(`updateEntryFields(${JSON.stringify(e.id)}, { date: '2020-03-02' });`);
  card(e.id);
  say("repayment");
  // Nothing was owed, so the whole amount is the "paid more than owed" leftover: a pending expense for the trip.
  const leftover = rt.rows("Entries").find((x) => x.status === "pending" && /Overpayment/.test(x.description) && x.description.includes(group.name));
  assert.ok(leftover, "the repayment went to the trip's group");
  assert.equal(leftover.trip_id, trip.id);
});

test("with no name and no trip on that date, it asks who (and changes nothing)", () => {
  const { rt, pending, card, say, sent } = setup();
  rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-05" });
  const e = pending[1];
  rt.run(`updateEntryFields(${JSON.stringify(e.id)}, { date: '2021-07-02' });`);
  card(e.id);
  say("repayment");
  assert.match(sent(), /Say who/);
  assert.ok(rt.rows("Entries").some((x) => x.id === e.id), "the entry is untouched");
});

test("two trips on the same date: no guess", () => {
  const { rt, pending, card, say, sent } = setup();
  rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2020-03-01", end_date: "2020-03-05" });
  rt.api("addTrip", { name: "Ana party", kind: "event", start_date: "2020-03-02", end_date: "2020-03-02" });
  const e = pending[2];
  rt.run(`updateEntryFields(${JSON.stringify(e.id)}, { date: '2020-03-02' });`);
  card(e.id);
  say("repayment");
  assert.match(sent(), /Say who/);
});

test("naming a friend still works exactly as before", () => {
  const { rt, pending, card, say } = setup();
  const ana = rt.api("addFriend", { name: "Ana Named" });
  const e = pending[3];
  card(e.id);
  say("repayment Ana Named");
  assert.ok(ana.id);
  assert.ok(rt.rows("Entries").some((x) => /Overpayment/.test(x.description) && x.description.includes("Ana Named")), "it was routed to Ana");
});

test("the entry form starts the Repayment / New loan friend on the trip's group (never over a hand pick)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(src, /function autoPickRepaymentGroup_\(\)/);
  assert.match(src, /repaymentFriendTouched_/);
  assert.match(src, /covering\.length === 1 \? meta\.friends\.find/, "only when exactly one trip covers the date");
});
