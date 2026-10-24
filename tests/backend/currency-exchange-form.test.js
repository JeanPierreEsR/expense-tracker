// "Currency exchange" saved as one action, both ways, plus exchange-house e-mails (CurrencyExchange.gs). Accounts, names and amounts are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, bcpEmail, BCP_SENDER } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Xch PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Xch USD acct", type: "debit" });
  rt.api("setPaymentMethodOpeningBalance", { id: pen.id, balances: [{ currency: "PEN", amount: 5000, date: "2020-01-01" }] });
  rt.api("setPaymentMethodOpeningBalance", { id: usd.id, balances: [{ currency: "USD", amount: 2000, date: "2020-01-01" }] });
  const bal = (id, cur) => rt.api("listPaymentMethodBalances", {}).find((x) => x.id === id).balances.find((x) => x.currency === cur).amount;
  return { rt, pen, usd, bal };
}
const json = (x) => JSON.parse(JSON.stringify(x));

test("soles into dollars: both legs saved together, each balance moves in its own currency", () => {
  const { rt, pen, usd, bal } = setup();
  const res = rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: pen.id, amount: 3700, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1000, currency: "USD" } });
  assert.equal(res.out.type, "transfer");
  assert.equal(res.in.type, "transfer");
  assert.equal(bal(pen.id, "PEN"), 1300);
  assert.equal(bal(usd.id, "USD"), 3000);
});

test("dollars into soles works the same way", () => {
  const { rt, pen, usd, bal } = setup();
  rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: usd.id, amount: 500, currency: "USD" }, in: { payment_method_id: pen.id, amount: 1850, currency: "PEN" }, house: "Acme Cambio" });
  assert.equal(bal(usd.id, "USD"), 1500);
  assert.equal(bal(pen.id, "PEN"), 6850);
  const legs = rt.rows("Entries").filter((e) => e.description === "Currency exchange (Acme Cambio)");
  assert.equal(legs.length, 2);
});

test("a side that is cash or someone else's account saves only the tracked leg", () => {
  const { rt, pen, bal } = setup();
  const res = rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: pen.id, amount: 370, currency: "PEN" }, in: { payment_method_id: "", amount: 100, currency: "USD" } });
  assert.ok(res.out);
  assert.equal(res.in, null);
  assert.equal(bal(pen.id, "PEN"), 4630);
});

test("it refuses: the same currency twice, no account at all, a bad amount, and saves nothing", () => {
  const { rt, pen, usd } = setup();
  const before = rt.rows("Entries").length;
  const attempt = (p) => assert.throws(() => rt.api("recordCurrencyExchange", Object.assign({ date: today() }, p)));
  attempt({ out: { payment_method_id: pen.id, amount: 10, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 10, currency: "PEN" } });
  attempt({ out: { payment_method_id: "", amount: 10, currency: "PEN" }, in: { payment_method_id: "", amount: 3, currency: "USD" } });
  attempt({ out: { payment_method_id: pen.id, amount: 0, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 3, currency: "USD" } });
  attempt({ out: { payment_method_id: "nope", amount: 10, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 3, currency: "USD" } });
  assert.equal(rt.rows("Entries").length, before);
});

test("a pending review entry becomes the leg in place, keeping its e-mail reference", () => {
  const { rt, pen, usd } = setup();
  bcpEmail(rt, { amount: "3500.00", merchant: "Some Exchange Co", op: "XCH-1" });
  rt.run("processEmails()");
  const pending = rt.rows("Entries").find((e) => e.external_id === "XCH-1");
  assert.equal(pending.status, "pending");

  rt.api("recordCurrencyExchange", { date: today(), pending_entry_id: pending.id, pending_leg: "out", house: "Some Exchange Co",
    out: { payment_method_id: pen.id, amount: 3500, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1010.5, currency: "USD" } });

  const after = rt.rows("Entries").find((e) => e.id === pending.id);
  assert.equal(after.status, "confirmed");
  assert.equal(after.type, "transfer");
  assert.equal(after.external_id, "XCH-1");
  assert.equal(after.payment_method_id, pen.id);
  assert.equal(rt.rows("Entries").filter((e) => e.external_id === "XCH-1").length, 1);
  assert.equal(rt.rows("Entries").filter((e) => e.description === "Currency exchange (Some Exchange Co)").length, 2);
  assert.throws(() => rt.api("recordCurrencyExchange", { date: today(), pending_entry_id: pending.id, out: { payment_method_id: pen.id, amount: 1, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1, currency: "USD" } }), "already handled");
});

const terceros = (rt, to, op) => rt.svc.gmail.addEmail({
  from: BCP_SENDER, subject: "Constancia de Transferencia a Terceros - Servicio de Notificaciones BCP",
  body: ["Realizaste una transferencia", "Monto transferido *S/ 250.00*", "Enviado a *" + to + "*", "Desde *Clasica*", "**** 0005", "Número de operación *" + op + "*"].join("\n")
});

test("an e-mail to a known exchange house lands as a one-sided transfer, and houses are learned from earlier exchanges", () => {
  const { rt } = freshApp({ small: true });
  terceros(rt, "Rextie Peru SAC", "HOUSE-1");
  terceros(rt, "Ana Lo Torres", "HOUSE-2");
  rt.run("processEmails()");
  const house = rt.rows("Entries").find((e) => e.external_id === "HOUSE-1");
  const person = rt.rows("Entries").find((e) => e.external_id === "HOUSE-2");
  assert.equal(house.type, "transfer");
  assert.match(house.description, /^Currency exchange \(Rextie Peru SAC\)$/);
  assert.equal(person.type, "expense", "a person is not an exchange house");

  // learned: an earlier hand-made exchange names a house the built-in list does not know
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "old-1", type: "transfer", date: "2026-01-05", amount: 100, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Cambios Zeta Norte)", paid_by: "me" })})`);
  terceros(rt, "Cambios Zeta Norte S.", "HOUSE-3");
  rt.run("processEmails()");
  assert.equal(rt.rows("Entries").find((e) => e.external_id === "HOUSE-3").type, "transfer");
});
