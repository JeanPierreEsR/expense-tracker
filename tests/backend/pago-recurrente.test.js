// Interbank "pago recurrente" notices (2026-11-05), read by a rule-pack rule: every merchant becomes a waiting expense on the card it names.
// A shop that e-mails its own receipt (DiDi, Apple: the pack's `pairs`) and the bank's notice for the same charge are JOINED into one entry
// (EmailPairs.gs): card from the bank, name / category / date from the receipt, silently. A waiting entry from an e-mail is flagged
// "possible duplicate" when the same money was already recorded by hand / photo / statement within 1
// day either side, whatever its name. Made-up text in the bank's and shops' layout; no real amount, name or number.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

const SENDER = "servicioalcliente@netinterbank.com.pe";
const DIDI = "didi@pe.didiglobal.com";
const APPLE = "no_reply@email.apple.com";
const SUBJECT = "Ana, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa Prueba";
const body = (shop, amt, card) => [
  "Ana, se ha realizado un pago recurrente a tu Tarjeta Interbank Visa Prueba", "", "Conoce el detalle:",
  "Tarjeta: ****" + (card || "1234"), "Comercio: " + shop, "Monto: " + amt, "Fecha: 01/02/2026", "Hora: 09:15 AM"
].join("\n");
const didiBody = (amt, t1) => ["Thanks for riding with Express", "Fare breakdown", "Sat, 31 Oct, 2026",
  (t1 || "3:40am") + " Calle Prueba", "3:55am Calle Ejemplo", "Total S/ " + amt, "Credit / Debit Card"].join("\n");
const appleBody = (amt) => ["Recibo de Apple", "Cuenta de Apple", "ana@example.com", "iCloud+ Prueba", "Mensual",
  "Visa •••• 9999", "", "S/ " + amt, "ID del pedido: MPRUEBA" + amt.replace(".", "")].join("\n");
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));

function setup() {
  const { rt, data } = freshApp({ entries: 300 });
  const text = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8");
  rt.api("setRulePack", { text });
  return { rt, data };
}
const unreadRows = (rt) => { try { return rt.rows("Unread Emails").filter((r) => r.sender === SENDER); } catch (e) { return []; } };   // no tab = nothing was ever logged
const emailEntries = (rt, amount) => rt.rows("Entries").filter((e) => e.source === "email" && Number(e.amount) === amount);
const interbankCard = (rt, data) => {
  const bank = rt.rows("Banks").find((b) => b.name === "Interbank");
  return rt.rows("Payment Methods").find((pm) => pm.bank_id === bank.id && pm.type === "credit");
};
const forgetRead = (rt) => rt.run("deleteRowsWhere_('Processed Emails', function () { return true; })");

test("DiDi: the receipt, then the bank's notice two minutes later, make ONE entry: DiDi's name and category, the bank's card", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("13.70"), daysAgo: 2 / 1440 });
  run(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 13.70", card.last_4) });
  const res = run(rt);
  assert.equal(res.created, 0);
  assert.equal(res.joined, 1);
  const rows = emailEntries(rt, 13.7);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "DiDi Express");
  assert.equal(rows[0].payment_method_id, card.id);
  const transport = rt.rows("Categories").find((c) => c.name === "Transport");
  if (transport) assert.equal(rows[0].category_id, transport.id);
  assert.equal(unreadRows(rt).length, 0);
});

test("Apple: the bank's notice first, the receipt five hours later: ONE entry with Apple's name and date, the bank's card", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("APPLE.COM/BILL", "S/. 12.90", card.last_4), daysAgo: 5 / 24 });
  assert.equal(run(rt).created, 1);
  rt.svc.gmail.addEmail({ from: APPLE, subject: "Tu recibo de Apple", body: appleBody("12.90") });
  const res = run(rt);
  assert.equal(res.created, 0);
  const rows = emailEntries(rt, 12.9);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "iCloud+ Prueba");
  assert.equal(rows[0].payment_method_id, card.id, "the card named by the bank stays");
  assert.equal(rows[0].date, today());
  assert.equal(rows[0].status, "pending");
});

test("two DiDi trips at the same price and two notices: two entries, each joined once", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("7.30", "1:10am"), daysAgo: 3 / 24 });
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("7.30", "2:10am"), daysAgo: 2 / 24 });
  run(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 7.30", card.last_4), daysAgo: 3 / 24 - 1 / 1440 });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 7.30", card.last_4), daysAgo: 2 / 24 - 1 / 1440 });
  const res = run(rt);
  assert.equal(res.joined, 2);
  const rows = emailEntries(rt, 7.3);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => /\|joined\|/.test(e.email_pair)));
});

test("more than 12 hours apart, or a notice with no receipt: nothing is joined", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("9.10"), daysAgo: 13 / 24 });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 9.10", card.last_4) });
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 15.90", card.last_4) });
  const res = run(rt);
  assert.equal(res.joined || 0, 0);
  assert.equal(emailEntries(rt, 9.1).length, 2);
  assert.equal(emailEntries(rt, 15.9).length, 1, "a notice alone stays as a waiting entry");
});

test("re-reading both e-mails later never brings the joined one back", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("11.40"), daysAgo: 1 / 1440 });
  run(rt);
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("PAG*DIDI DRIVE", "S/. 11.40", card.last_4) });
  run(rt);
  forgetRead(rt);
  const again = run(rt);
  assert.equal(again.created, 0);
  assert.equal(emailEntries(rt, 11.4).length, 1);
});

test("a receipt the person already confirmed: the notice only fills in a missing card, and makes no new entry", () => {
  const { rt, data } = setup();
  const card = interbankCard(rt, data);
  rt.svc.gmail.addEmail({ from: APPLE, subject: "Tu recibo de Apple", body: appleBody("24.90"), daysAgo: 1 / 24 });
  run(rt);
  const first = emailEntries(rt, 24.9)[0];
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(first.id)}, { status: 'confirmed', description: 'My iCloud' })`);
  rt.svc.gmail.addEmail({ from: SENDER, subject: SUBJECT, body: body("APPLE.COM/BILL", "S/. 24.90", card.last_4) });
  run(rt);
  const rows = emailEntries(rt, 24.9);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "My iCloud", "what the person confirmed is kept");
  assert.equal(rows[0].payment_method_id, card.id, "the card was missing, the bank's e-mail filled it in");
});

test("on a friend's copy a lone DiDi receipt gets no card (the owner's pinned card is never used)", () => {
  const { rt } = setup();
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.svc.gmail.addEmail({ from: DIDI, subject: "Your DiDi trip", body: didiBody("8.80") });
  run(rt);
  const rows = emailEntries(rt, 8.8);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_method_id, "");
});

test("the pack's pairs are checked like rules: a bad sender refuses the file, an unknown field leaves only that pair out", () => {
  const { rt } = setup();
  const v = (pairs) => JSON.parse(JSON.stringify(rt.run(`rulePackValidate_(${JSON.stringify(JSON.stringify({ version: 9, rules: [], pairs }))})`)));
  assert.equal(v([{ id: "x", sender: "Not An Address", merchantHas: ["x"] }]).ok, false);
  assert.equal(v([{ id: "x", sender: "shop@example.com", merchantHas: [] }]).ok, false);
  const later = v([{ id: "x", sender: "shop@example.com", merchantHas: ["x"], newer: true }, { id: "y", sender: "shop@example.com", merchantHas: ["y"] }]);
  assert.equal(later.ok, true);
  assert.deepEqual(later.pack.pairs.map((p) => p.id), ["y"]);
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
