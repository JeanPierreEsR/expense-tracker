// Interbank "Constancia de pago" that pays the person's OWN credit card (owner, 2026-11-17): a transfer from the account under
// "Cuenta cargo" to the card under "Tarjeta de crédito", not a bill payment. A bill payment ("Empresa") stays an expense, a card that is
// not one of the person's accounts stays an expense for review, and a payment made with a debit card comes from the person's one Interbank account in its currency (else blank).
// Made-up e-mails and digits; the parsing rules are the real ones (code and rule pack).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const SENDER = "servicioalcliente@netinterbank.com.pe";
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const accounts = (rt) => {
  const bank = rt.rows("Banks").find((b) => b.name === "Interbank");
  return rt.rows("Payment Methods").filter((pm) => pm.bank_id === bank.id);
};
const byOp = (rt, op) => rt.rows("Entries").find((x) => String(x.external_id) === op);

// The plain-text layout of the real e-mail: each label on its own line, its value on the lines below.
const cardPayment = ({ op, from, card, amount }) => ["Hola JEAN , te", "enviamos tu", "Constancia de pago",
  "Código de operación", op, "Fecha y hora", "10 Nov 2026", "09:00 AM",
  "Cuenta cargo", "Cuenta Simple", "Dólares", "898 000000" + from,
  "Tarjeta de crédito", "Interbank Visa Infinite", "Soles", "400000******" + card,
  "Moneda y monto", amount, "Realiza más operaciones como esta de manera rápida y simple desde"].join("\n");

test("a Constancia that pays the person's own card is a transfer from the account to the card", () => {
  const { rt } = freshApp({ entries: 50 });
  const from = accounts(rt).find((pm) => pm.nickname === "Daily debit"), card = accounts(rt).find((pm) => pm.type === "credit");
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de pago", body: cardPayment({ op: "0900001", from: from.last_4, card: card.last_4, amount: "US$ 123.45" }) });
  assert.equal(run(rt).created, 1);
  const e = byOp(rt, "0900001");
  assert.equal(e.type, "transfer");
  assert.equal(e.status, "pending", "automated: waits in Needs review");
  assert.equal(Number(e.amount), 123.45);
  assert.equal(e.currency, "USD");
  assert.equal(e.payment_method_id, from.id);
  assert.equal(e.to_payment_method_id, card.id);
  assert.equal(e.description, "Pago tarjeta Interbank");
});

test("a card that is not one of the person's accounts stays an expense for review", () => {
  const { rt } = freshApp({ entries: 50 });
  const from = accounts(rt).find((pm) => pm.nickname === "Daily debit");
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de pago", body: cardPayment({ op: "0900002", from: from.last_4, card: "9911", amount: "S/ 1,234.00" }) });
  run(rt);
  const e = byOp(rt, "0900002");
  assert.equal(e.type, "expense");
  assert.equal(e.status, "pending");
  assert.ok(!e.to_payment_method_id);
  assert.equal(e.payment_method_id, from.id);
  assert.equal(e.description, "Pago de tarjeta …9911");
});

test("a bill payment (Empresa) is still an expense, even when paid with the card", () => {
  const { rt } = freshApp({ entries: 50 });
  const card = accounts(rt).find((pm) => pm.type === "credit");
  rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de pago", body: ["Constancia de pago", "Código de operación", "0900003",
    "Fecha y hora", "03 Nov 2026", "07:00 AM", "Cuenta cargo", "Interbank Visa Infinite", "Soles", "400000******" + card.last_4,
    "Empresa", "TELEFONIA PRUEBA", "01 Pago por DNI", "Recibo 1", "S/ 41.10", "Datos", "PRUEBA", "Moneda y monto", "S/ 41.10"].join("\n") });
  run(rt);
  const e = byOp(rt, "0900003");
  assert.equal(e.type, "expense");
  assert.equal(e.payment_method_id, card.id);
  assert.ok(!e.to_payment_method_id);
});

// Paid with a debit card the e-mail names no account: From = the person's ONE Interbank account in the payment's currency (owner, 2026-11-25:
// "a USD account should be matched by default if the payment was in USD"); none or several in that currency = blank, never a guess.
const debitCardPayment = (rt, op, cardLast4, amount) => rt.svc.gmail.addEmail({ from: SENDER, subject: "Constancia de pago", body: ["Constancia de pago",
  "Código de operación", op, "Fecha y hora", "05 Ago 2026", "11:00 AM", "Tarjeta de cargo", "Débito Visa", "455000******7777",
  "Tarjeta de crédito pagada", "Interbank Visa Infinite", "Soles", "400000******" + cardLast4, "Moneda y monto", amount].join("\n") });
const setCurrencies = (rt, pm, list) => rt.api("savePaymentMethod", Object.assign({}, pm, { currencies: list }));

test("paid with a debit card ('Tarjeta de cargo'): From = the Interbank account in the payment's currency", () => {
  const { rt } = freshApp({ entries: 50 });
  const card = accounts(rt).find((pm) => pm.type === "credit");
  const soles = accounts(rt).find((pm) => pm.nickname === "Daily debit"), dollars = accounts(rt).find((pm) => pm.nickname === "Backup debit");
  setCurrencies(rt, soles, ["PEN"]);
  setCurrencies(rt, dollars, ["USD"]);
  debitCardPayment(rt, "0900004", card.last_4, "US$ 987.00");
  debitCardPayment(rt, "0900014", card.last_4, "S/ 250.00");
  run(rt);
  const usd = byOp(rt, "0900004"), pen = byOp(rt, "0900014");
  assert.equal(usd.type, "transfer");
  assert.equal(usd.to_payment_method_id, card.id);
  assert.equal(usd.payment_method_id, dollars.id, "a payment in dollars left the dollar account");
  assert.equal(pen.payment_method_id, soles.id, "a payment in soles left the soles account");
});

test("paid with a debit card: no account, or two, in that currency = From left blank", () => {
  const { rt } = freshApp({ entries: 50 });
  const card = accounts(rt).find((pm) => pm.type === "credit");
  debitCardPayment(rt, "0900024", card.last_4, "US$ 40.00");   // the accounts' currencies are not known
  run(rt);
  assert.equal(byOp(rt, "0900024").payment_method_id, "", "no account known to hold dollars");
  accounts(rt).filter((pm) => pm.type === "debit").forEach((pm) => setCurrencies(rt, pm, ["USD"]));
  debitCardPayment(rt, "0900034", card.last_4, "US$ 41.00");
  run(rt);
  assert.equal(byOp(rt, "0900034").payment_method_id, "", "two dollar accounts: not guessed");
  assert.equal(byOp(rt, "0900034").to_payment_method_id, card.id);
});

test("the twin reads a debit-card payment like the code rule (the 2026-11-25 twin-check difference)", () => {
  const { rt } = freshApp({ entries: 50 });
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8"));
  const twin = pack.rules.find((r) => r.id === "interbank-pago-tarjeta");
  assert.equal(twin.fromByCurrency, true);
  const body = ["Constancia de pago", "Código de operación", "0900044", "Tarjeta de cargo", "Débito Visa", "455000******7777",
    "Tarjeta de crédito pagada", "Interbank Visa Infinite", "Soles", "400000******5678", "Moneda y monto", "US$ 10.00"].join("\n");
  const diff = JSON.parse(JSON.stringify(rt.run(`(function () {
    var code = EMAIL_RULES.filter(function (r) { return r.label === 'Pago de tarjeta (Constancia)'; })[0], t = rulePackCompile_(${JSON.stringify(twin)});
    return { fields: rulePackDiffFields_(code.extract('Constancia de pago', ${JSON.stringify(body)}), t.extract('Constancia de pago', ${JSON.stringify(body)})),
      attr: [code.fromByCurrency, t.fromByCurrency] }; })()`)));
  assert.deepEqual(diff.fields, []);
  assert.deepEqual(diff.attr, [true, true]);
});

test("an older backend that does not know fromByCurrency skips only that twin; the other rules still load", () => {
  const { rt } = freshApp({ entries: 50 });
  const pack = fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8");
  const older = pack.replace(/"fromByCurrency": true, /g, '"fromByCurrencyNewer": true, ');
  const v = JSON.parse(JSON.stringify(rt.run(`rulePackValidate_(${JSON.stringify(older)}, { strict: false })`)));
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.ok(!v.pack.rules.find((r) => r.id === "interbank-pago-tarjeta"));
  assert.ok(v.pack.rules.find((r) => r.id === "diners-consumo"));
});

test("the rule pack's twin reads the same card payment the same way", () => {
  const { rt } = freshApp({ entries: 50 });
  const pack = fs.readFileSync(path.join(__dirname, "../../docs/rules/email-rules.json"), "utf8");
  const v = JSON.parse(JSON.stringify(rt.run(`rulePackValidate_(${JSON.stringify(pack)}, { strict: true })`)));
  assert.ok(v.ok, JSON.stringify(v.errors));
  const twin = v.pack.rules.find((r) => r.id === "interbank-pago-tarjeta");
  assert.ok(twin);
  const body = cardPayment({ op: "0900005", from: "1234", card: "5678", amount: "US$ 6.50" });
  const f = JSON.parse(JSON.stringify(rt.run(`(function () { var r = rulePackCompile_(${JSON.stringify(twin)});
    return { match: r.match("Constancia de pago", ${JSON.stringify(body)}), fields: r.extract("Constancia de pago", ${JSON.stringify(body)}) }; })()`)));
  assert.equal(f.match, true);
  assert.equal(f.fields.type, "transfer");
  assert.equal(f.fields.last4, "1234");
  assert.equal(f.fields.toLast4, "5678");
  assert.equal(f.fields.amount, 6.50);
  assert.equal(f.fields.currency, "USD");
  const servicios = v.pack.rules.find((r) => r.id === "interbank-pago-servicios");
  assert.equal(JSON.parse(rt.run(`JSON.stringify(rulePackCompile_(${JSON.stringify(servicios)}).match("Constancia de pago", ${JSON.stringify(body)}))`)), false,
    "the bill-payment twin no longer takes card payments");
});
