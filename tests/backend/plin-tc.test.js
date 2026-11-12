// Interbank "Constancia de Pago Plin TC": a Plin payment charged to the Interbank CREDIT CARD. The e-mail names the card under
// "Tarjeta cargo" (not "Cuenta cargo", as the savings-account version does), so the card's digits pick the account (owner, 2026-11-12).
// Made-up e-mails; the parsing rule is the real one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const SENDER = "servicioalcliente@netinterbank.com.pe";
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const interbank = (rt) => {
  const bank = rt.rows("Banks").find((b) => b.name === "Interbank");
  return rt.rows("Payment Methods").filter((pm) => pm.bank_id === bank.id);
};

test("Plin paid with the Interbank credit card lands on that card", () => {
  const { rt } = freshApp({ entries: 300 });
  const accounts = interbank(rt);
  const card = accounts.find((pm) => pm.type === "credit");
  assert.ok(card && String(card.last_4 || "").trim(), "the made-up data has an Interbank card with digits");
  assert.ok(accounts.length > 1, "the bank has other accounts too, so the digits decide");
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de Pago Plin TC", body: [
    "Constancia de Pago Plin", "12 Nov 2026 08:18 AM", "Código de operación: 00999901",
    "Tarjeta cargo: Tarjeta infinite 400000******" + card.last_4, "Detalle de pago: Pago único",
    "Destinatario: ANA PRUEBA", "Destino: PLIN", "Moneda y monto: S/ 15.15"].join("\n") });
  assert.equal(run(rt).created, 1);
  const e = rt.rows("Entries").find((x) => x.external_id === "00999901");
  assert.equal(e.type, "expense");
  assert.equal(Number(e.amount), 15.15);
  assert.equal(e.payment_method_id, card.id);
  assert.equal(e.description, "Plin a ANA PRUEBA");
});

test("Plin from a savings account still reads 'Cuenta cargo'", () => {
  const { rt } = freshApp({ entries: 300 });
  const acct = interbank(rt).find((pm) => pm.type !== "credit" && String(pm.last_4 || "").trim());
  if (!acct) return;   // the made-up data has no Interbank savings account with digits
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de Pago Plin", body: [
    "Moneda y monto: S/ 30.00", "Destinatario: LUIS PRUEBA", "Cuenta cargo", "Cuenta Simple", "Soles",
    "000 000000" + acct.last_4, "Código de operación: 00999902"].join("\n") });
  run(rt);
  const e = rt.rows("Entries").find((x) => x.external_id === "00999902");
  assert.equal(e.payment_method_id, acct.id);
});
