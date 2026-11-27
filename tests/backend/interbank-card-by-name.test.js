// Interbank purchase e-mails with no card digits (2026-11-27, owner: "can we generalize this?"). The card used to be a shortcut to the
// owner's own card; now the card's name in the subject picks it: the person's Interbank credit card with that name, else their only one.
// The pack twin `interbank-consumo` reads the same way. Made-up names, amounts and digits only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const js = (v) => JSON.stringify(v);
const SENDER = "servicioalcliente@netinterbank.com.pe";
const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "docs", "rules", "email-rules.json"), "utf8"));
const TWIN = PACK.rules.find((r) => r.id === "interbank-consumo");
const body = (amount) => ["Ana, realizaste un consumo", "Comercio: TIENDA PRUEBA", "Monto: S/ " + amount, "Fecha: 01/11/2026"].join("\n");

function read(rt, subject, amount) {
  rt.svc.gmail.addEmail({ from: SENDER, subject, body: body(amount), daysAgo: 0 });
  rt.svc.props.delete("EMAIL_SCAN_LAST_AT");
  rt.run("processEmails()");
  const e = rt.rows("Entries").filter((x) => x.source === "email" && Number(x.amount) === Number(amount)).pop();
  assert.ok(e, "an entry was made");
  return (rt.rows("Payment Methods").find((p) => p.id === e.payment_method_id) || {}).nickname || "";
}
const interbank = (rt) => rt.rows("Banks").find((b) => b.name === "Interbank");
const creditCards = (rt) => rt.rows("Payment Methods").filter((p) => p.type === "credit" && p.bank_id === interbank(rt).id);

test("no digits, one Interbank credit card: that card", () => {
  const { rt } = freshApp({ small: true });
  const cards = creditCards(rt);
  assert.equal(cards.length, 1, "the made-up data has one Interbank credit card");
  assert.equal(read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "41.30"), cards[0].nickname);
});

test("no digits, two Interbank credit cards: the one whose name is in the subject, else blank", () => {
  const { rt } = freshApp({ small: true });
  rt.api("savePaymentMethod", { nickname: "Interbank Visa Prueba", type: "credit", bank_id: interbank(rt).id, currencies: ["PEN", "USD"] });
  assert.equal(read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "52.40"), "Interbank Visa Prueba");
  assert.equal(read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Otra", "63.50"), "", "two cards and no name: the person picks");
});

test("a debit card named in the subject never picks a credit card", () => {
  const { rt } = freshApp({ small: true });
  const nick = read(rt, "Ana, realizaste un consumo con tu Tarjeta de Débito Interbank", "74.60");
  assert.ok(!creditCards(rt).some((c) => c.nickname === nick && nick), "not a credit card");
});

test("no shortcut to anyone's own card is left in the code", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "EmailParser.gs"), "utf8");
  assert.ok(!/visa infinite\/i\.test\(subject\)/.test(src));
});

test("the pack twin sits behind its code rule and reads the same card", () => {
  assert.ok(TWIN && TWIN.replaces === "Consumo" && TWIN.first !== true);
  const viaTwin = (() => {
    const { rt } = freshApp({ small: true });
    const res = rt.api("setRulePack", { text: js({ version: 99, rules: [Object.assign({}, TWIN, { first: true })] }) });
    assert.deepEqual([res.count, res.skipped], [1, 0]);
    return read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "85.70");
  })();
  const viaCode = (() => { const { rt } = freshApp({ small: true }); return read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "85.70"); })();
  assert.ok(viaCode);
  assert.equal(viaTwin, viaCode);
});

test("an older backend that does not know `cardName` skips only this rule", () => {
  const { rt } = freshApp({ small: true });
  const renamed = Object.assign({}, TWIN, { cardNameFromTheFuture: TWIN.cardName });
  delete renamed.cardName;
  const res = rt.api("setRulePack", { text: js({ version: 99, rules: [renamed, PACK.rules.find((r) => r.id === "interbank-pago-recurrente")] }) });
  assert.deepEqual([res.count, res.skipped], [1, 1]);
});
