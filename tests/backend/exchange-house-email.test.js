// An exchange house's confirmation e-mail names BOTH sides of an exchange (CurrencyExchange.gs). The bank's own e-mail for the money that
// left names the same exchange, so the two must never count it twice, in either order, and both directions must work. All made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, BCP_SENDER } = require("./helpers");

const HOUSE_SENDER = "no-reply@gmai.com";

const confirmation = (rt, { sent = ["SOLES", "S/", "3,500.00"], got = ["DÓLARES", "$", "1,000.00"], code = "01234567", daysAgo = 0 } = {}) =>
  rt.svc.gmail.addEmail({
    from: "Cambio Mundial <" + HOUSE_SENDER + ">", subject: "Confirmación de Operación - Cambio Mundial", daysAgo,
    body: ["[image: logo]", "*Gracias por realizar tus operaciones con Cambio Mundial*", "*Enviaste:*" + sent[0] + "*" + sent[1] + " " + sent[2] + "*",
      "*Recibirás:*" + got[0] + "*" + got[1] + " " + got[2] + "*", "El código de tu operación es:", code, "*Gracias por cambiar con Nosotros!*"].join("\n")
  });

const bankSent = (rt, { to = "Cambios Zeta Norte S.", amount = "3500.00", op = "1234567" } = {}) => rt.svc.gmail.addEmail({
  from: BCP_SENDER, subject: "Constancia de Transferencia a Terceros - Servicio de Notificaciones BCP",
  body: ["Realizaste una transferencia", "Monto transferido *S/ " + amount + "*", "Enviado a *" + to + "*", "Desde *Clasica*", "**** 0005", "Número de operación *" + op + "*"].join("\n")
});

const legs = (rt) => rt.rows("Entries").filter((e) => e.type === "transfer" && /^Currency exchange/.test(e.description) && e.status !== "discarded");
const run = (rt, senders) => JSON.parse(JSON.stringify(rt.run("processEmails(" + (senders ? JSON.stringify({ senders }) : "") + ")")));

function setup() {
  const { rt } = freshApp({ small: true });
  // a house the app has learned from an earlier hand-made exchange
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "old-house", type: "transfer", date: "2026-01-05", amount: 100, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Cambios Zeta Norte)", paid_by: "me" })})`);
  return rt;
}

test("one confirmation makes the leg that left and the leg that arrived, both pending", () => {
  const rt = setup();
  confirmation(rt);
  const res = run(rt);
  const made = legs(rt).filter((e) => e.status === "pending");
  assert.equal(res.created, 2);
  assert.equal(made.length, 2);
  const out = made.find((e) => e.currency === "PEN"), inn = made.find((e) => e.currency === "USD");
  assert.equal(Number(out.amount), 3500);
  assert.equal(Number(inn.amount), 1000);
  assert.ok(!out.to_payment_method_id, "the left leg has no destination");
  assert.ok(!inn.payment_method_id, "the arrived leg has no source");
  assert.equal(out.description, "Currency exchange (Cambio Mundial)");
  assert.equal(run(rt).created, 0, "reading it again adds nothing");
  assert.equal(legs(rt).filter((e) => e.status === "pending").length, 2);
});

test("dollars out and soles in works too", () => {
  const rt = setup();
  confirmation(rt, { sent: ["DÓLARES", "$", "500.00"], got: ["SOLES", "S/", "1,850.00"], code: "00001234" });
  run(rt);
  const made = legs(rt).filter((e) => e.status === "pending");
  assert.equal(made.length, 2);
  assert.equal(made.find((e) => e.currency === "USD" && e.payment_method_id !== undefined && !e.to_payment_method_id && Number(e.amount) === 500) !== undefined, true);
  assert.equal(Number(made.find((e) => e.currency === "PEN").amount), 1850);
});

test("bank e-mail first, exchange house second: only the arrived leg is added", () => {
  const rt = setup();
  bankSent(rt);
  run(rt, [BCP_SENDER]);
  const afterBank = legs(rt).filter((e) => e.status === "pending");
  assert.equal(afterBank.length, 1);
  assert.equal(afterBank[0].currency, "PEN");

  confirmation(rt);
  run(rt, [HOUSE_SENDER]);
  const pending = legs(rt).filter((e) => e.status === "pending");
  assert.equal(pending.length, 2, "one left leg (the bank's), one arrived leg");
  assert.equal(pending.filter((e) => e.currency === "PEN").length, 1, "the soles are not counted twice");
});

test("exchange house first, bank e-mail second: the bank e-mail makes no second left leg", () => {
  const rt = setup();
  confirmation(rt);
  run(rt, [HOUSE_SENDER]);
  assert.equal(legs(rt).filter((e) => e.status === "pending").length, 2);

  bankSent(rt);
  const res = run(rt, [BCP_SENDER]);
  assert.equal(res.created, 0);
  assert.equal(legs(rt).filter((e) => e.status === "pending" && e.currency === "PEN").length, 1);
  assert.equal(rt.rows("Entries").filter((e) => e.type === "expense" && /Zeta Norte/i.test(e.description || "")).length, 0, "and no expense either");
});

test("a bank e-mail for ANOTHER exchange of the same size is not swallowed (it has its own code)", () => {
  const rt = setup();
  bankSent(rt, { op: "1111111" });
  bankSent(rt, { op: "2222222" });
  run(rt, [BCP_SENDER]);
  assert.equal(legs(rt).filter((e) => e.status === "pending" && e.currency === "PEN").length, 2);
});

test("a leg already entered by hand or imported is recognised, so the house e-mail does not duplicate it", () => {
  const rt = setup();
  const day = today();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "m-out", type: "transfer", date: day, amount: 3500, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Cambios Zeta Norte)", paid_by: "me", payment_method_id: "pm-x" })})`);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "m-in", type: "transfer", date: day, amount: 1000, currency: "USD", status: "confirmed", source: "import", description: "Currency exchange: USD received", paid_by: "me", to_payment_method_id: "pm-y" })})`);
  confirmation(rt);
  const res = run(rt);
  assert.equal(res.created, 0);
  assert.equal(legs(rt).filter((e) => e.status === "pending").length, 0);
});

test("the arrived leg is pre-filled with the account that received that currency last time", () => {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Xch PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Xch USD acct", type: "debit" });
  rt.api("recordCurrencyExchange", { date: "2026-09-01", house: "Cambio Mundial", out: { payment_method_id: pen.id, amount: 3500, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1000, currency: "USD" } });
  confirmation(rt);
  run(rt);
  const pending = legs(rt).filter((e) => e.status === "pending");
  assert.equal(pending.find((e) => e.currency === "USD").to_payment_method_id, usd.id);
  assert.equal(pending.find((e) => e.currency === "PEN").payment_method_id, pen.id);
});

test("an exchange with only one side recorded is reported, a complete one is not", () => {
  const { rt } = freshApp({ small: true });
  const add = (o) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ type: "transfer", status: "confirmed", source: "manual", paid_by: "me", description: "Currency exchange (House)" }, o))})`);
  add({ id: "a1", date: "2026-03-10", amount: 3000, currency: "PEN", payment_method_id: "pm1" });
  add({ id: "a2", date: "2026-03-10", amount: 800, currency: "USD", to_payment_method_id: "pm2" });
  add({ id: "b1", date: "2026-03-20", amount: 700, currency: "PEN", payment_method_id: "pm1" });
  const report = JSON.parse(JSON.stringify(rt.run("emailCoverageReport_({ days: 30 })")));
  assert.deepEqual(report.unpairedExchangeLegs.map((l) => [l.date, l.side, l.currency]), [["2026-03-20", "out", "PEN"]]);
});

test("the coverage report counts an exchange confirmation as read once both legs exist", () => {
  const rt = setup();
  confirmation(rt);
  run(rt);
  const report = JSON.parse(JSON.stringify(rt.run("emailCoverageReport_({ days: 30 })")));
  const house = report.senders.find((s) => s.sender === HOUSE_SENDER);
  assert.equal(house.parsed, 1);
  assert.equal(house.missing.length, 0);
  assert.equal(house.unreadable.length, 0);
});
