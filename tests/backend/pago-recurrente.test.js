// Interbank "pago recurrente" notices (2026-11-05), read by two rule-pack rules: DiDi / Apple are ignored quietly (their own receipts
// already make the entry; never listed as "couldn't read"); any other merchant becomes a waiting expense on the card it names. A waiting
// entry from an e-mail is flagged "possible duplicate" when the same money was already recorded by hand / photo / statement within 1
// day either side, whatever its name. Made-up text in the bank's layout; no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

const SENDER = "servicioalcliente@netinterbank.com.pe";
const SUBJECT = "Ana, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa Prueba";
const body = (shop, amt) => [
  "Ana, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa Prueba", "", "Conoce el detalle:",
  "Tarjeta: ****1234", "Comercio: " + shop, "Monto: " + amt, "Fecha: 01/02/2026", "Hora: 09:15 AM"
].join("\n");
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
  rt.api("setRulePack", { text });
  return { rt, data };
}
const unreadRows = (rt) => { try { return rt.rows("Unread Emails").filter((r) => r.sender === SENDER); } catch (e) { return []; } };   // no tab = nothing was ever logged

test("a DiDi or Apple notice is ignored quietly: no entry, nothing under 'couldn't read'", () => {
  const { rt } = setup();
  const before = rt.rows("Entries").length;
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 12.30") });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("APPLE.COM/BILL", "S/. 9.90") });
  const res = run(rt);
  assert.equal(res.created, 0);
  assert.equal(rt.rows("Entries").length, before);
  assert.equal(unreadRows(rt).length, 0);
});

test("another merchant becomes a waiting expense with the amount, currency and merchant", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("CURSO PRUEBA", "$ 64.15") });
  const res = run(rt);
  assert.equal(res.created, 1);
  const e = rt.rows("Entries").find((x) => x.source === "email" && x.description === "CURSO PRUEBA");
  assert.ok(e);
  assert.equal(e.status, "pending");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 64.15);
  assert.equal(e.currency, "USD");
  assert.equal(unreadRows(rt).length, 0);
});

test("the same money typed by hand a day earlier, under another name, flags the waiting entry as a possible duplicate", () => {
  const { rt, data } = setup();
  const cat = data.cats.find((c) => c.type === "expense");
  const d = new Date(); d.setDate(d.getDate() - 1);
  const yesterday = d.toISOString().slice(0, 10);
  rt.api("createEntry", { type: "expense", date: yesterday, amount: 20.9, currency: "PEN", category_id: cat.id, description: "music app", paid_by: "me", payment_method_id: data.pms[0].id });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("STREAMING PRUEBA", "S/. 20.90") });
  run(rt);
  const row = rt.api("listPendingEntries").find((e) => e.description === "STREAMING PRUEBA");
  assert.ok(row);
  assert.ok(row.twins.some((t) => t.description === "music app"), "flagged next to the hand-typed entry");
});

test("the same money typed by hand TWO days earlier is not flagged (the window is 1 day either side)", () => {
  const { rt, data } = setup();
  const cat = data.cats.find((c) => c.type === "expense");
  const d = new Date(); d.setDate(d.getDate() - 2);
  rt.api("createEntry", { type: "expense", date: d.toISOString().slice(0, 10), amount: 21.7, currency: "PEN", category_id: cat.id, description: "music app", paid_by: "me", payment_method_id: data.pms[0].id });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("STREAMING PRUEBA", "S/. 21.70") });
  run(rt);
  const row = rt.api("listPendingEntries").find((e) => e.description === "STREAMING PRUEBA");
  assert.ok(row);
  assert.equal(row.twins.length, 0);
});

test("two e-mail entries a day apart with different names are NOT flagged (e-mail vs e-mail keeps the same-day rule)", () => {
  const { rt } = setup();
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("STREAMING PRUEBA", "S/. 33.33"), daysAgo: 1 });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("OTRA PRUEBA", "S/. 33.33") });
  run(rt);
  const rows = rt.api("listPendingEntries").filter((e) => Number(e.amount) === 33.33);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => e.twins.length === 0));
});

test("the date of today is used by the helpers (sanity)", () => { assert.match(today(), /^\d{4}-\d{2}-\d{2}$/); });
