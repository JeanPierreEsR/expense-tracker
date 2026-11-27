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
const body = (amount, digits, card) => [(card ? "Ana, realizaste un consumo con tu Tarjeta " + card : "Ana, realizaste un consumo"), "Conoce el detalle:",
  digits ? "Tarjeta: ****" + digits : "", "Comercio: TIENDA PRUEBA", "Monto: S/ " + amount, "Fecha: 01/11/2026"].filter(Boolean).join("\n");

function read(rt, subject, amount, digits) {
  const card = (subject.match(/tarjeta\s+(.+)$/i) || [])[1];
  rt.svc.gmail.addEmail({ from: SENDER, subject, body: body(amount, digits, digits ? card : null), daysAgo: 0 });
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

// 2026-11-27 (owner: "add the digit reading"): the real e-mail prints "Tarjeta: ****1234" under a title that also says "Tarjeta"; the digits
// on that line are now read (they were not: the title line came first), so they pick the account, debit cards included.
test("the masked digits under the title pick the account, a debit card too", () => {
  const { rt } = freshApp({ small: true });
  const ib = interbank(rt).id;
  rt.api("savePaymentMethod", { nickname: "Card Prueba A", type: "credit", bank_id: ib, last_4: "1111", currencies: ["PEN", "USD"] });
  rt.api("savePaymentMethod", { nickname: "Cuenta Prueba B", type: "debit", bank_id: ib, last_4: "2222", currencies: ["PEN"] });
  assert.equal(read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "21.10", "1111"), "Card Prueba A");
  assert.equal(read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Débito Prueba", "22.20", "2222"), "Cuenta Prueba B");
});

test("digits that match no account: the named card only when it has no digits filled in", () => {
  const { rt } = freshApp({ small: true });
  const cards = creditCards(rt);
  assert.equal(cards.length, 1);
  const hasDigits = !!String(cards[0].last_4 || "").trim();
  const got = read(rt, "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", "23.30", "9999");
  assert.equal(got, hasDigits ? "" : cards[0].nickname, "digits that disagree with the card's own never pick it");
});

test("the pack twin reads the masked digits the same way", () => {
  const s = { subject: "Ana, realizaste un consumo con tu Tarjeta Interbank Visa Prueba", body: body("24.40", "1111", "Interbank Visa Prueba") };
  const got = (pack) => {
    const { rt } = freshApp({ small: true });
    if (pack) rt.api("setRulePack", { text: js({ version: 99, rules: [Object.assign({}, TWIN, { first: true })] }) });
    return rt.run(`(function(){ var r = readEmailWithRules_(${js(SENDER)}, ${js(s.subject)}, ${js(s.body)}); return [r.rule.packId || 'code', r.fields.last4, r.fields.cardName]; })()`);
  };
  const a = got(true), b = got(false);
  assert.equal(a[0], "interbank-consumo");
  assert.deepEqual([a[1], a[2]], [b[1], b[2]]);
  assert.equal(a[1], "1111");
});
