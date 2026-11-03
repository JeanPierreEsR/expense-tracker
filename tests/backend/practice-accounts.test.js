// First-use practice: Accounts, cards & platforms (removePracticeAccounts + the matchers that must never pick the practice account).
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const mk = (rt, nickname, extra = {}) => post(rt, "savePaymentMethod", { nickname, type: "debit", ...extra }).data;
const entry = (rt, id, extra) => rt.run(`appendRowObject('Entries', Object.assign({ id: ${JSON.stringify(id)}, type: 'expense', date: ${JSON.stringify(today())}, amount: 10, currency: 'PEN', category_id: '', description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual' }, ${JSON.stringify(extra)}));`);

test("capability: a backend that can clean the practice up says so", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("getMeta").capabilities.practiceAccounts, true);
});

test("removePracticeAccounts removes the practice account (either language) and its starting balances, nothing else", () => {
  const { rt } = freshApp({ small: true });
  const mine = mk(rt, "Practice account");
  const es = mk(rt, "Cuenta de práctica", { type: "cash" });
  const real = mk(rt, "Real savings");
  [mine, es, real].forEach((a) => post(rt, "setPaymentMethodOpeningBalance", { id: a.id, balances: [{ currency: "PEN", amount: 100, date: today() }] }));
  const pmBefore = rt.rows("Payment Methods").length;
  const balBefore = rt.rows("Account Opening Balances").length;
  const res = rt.api("removePracticeAccounts", { started_on: today() });
  assert.equal(res.accounts, 2);
  assert.equal(res.balances, 2);
  assert.equal(res.cleared, 0);
  const ids = rt.rows("Payment Methods").map((p) => p.id);
  assert.ok(!ids.includes(mine.id) && !ids.includes(es.id));
  assert.ok(ids.includes(real.id), "a real account stays");
  assert.equal(rt.rows("Payment Methods").length, pmBefore - 2);
  assert.equal(rt.rows("Account Opening Balances").length, balBefore - 2);
  assert.ok(rt.rows("Account Opening Balances").some((b) => b.payment_method_id === real.id), "its starting balance stays");
  assert.ok(!rt.api("getMeta").paymentMethods.some((p) => p.id === mine.id), "gone from getMeta at once");
  assert.deepEqual(JSON.parse(JSON.stringify(rt.api("removePracticeAccounts", {}))), { accounts: 0, balances: 0, cleared: 0 }, "a repeat is harmless");
});

test("a real entry that got the practice account keeps existing and only loses the account", () => {
  const { rt } = freshApp({ small: true });
  const mine = mk(rt, "Practice account");
  const other = mk(rt, "Real checking");
  entry(rt, "e-pa-1", { payment_method_id: mine.id });
  entry(rt, "e-pa-2", { type: "transfer", payment_method_id: other.id, to_payment_method_id: mine.id });
  const entriesBefore = rt.rows("Entries").length;
  const res = rt.api("removePracticeAccounts", { started_on: today() });
  assert.equal(res.accounts, 1);
  assert.equal(res.cleared, 2);
  assert.equal(rt.rows("Entries").length, entriesBefore, "no entry is deleted");
  assert.equal(rt.rows("Entries").find((e) => e.id === "e-pa-1").payment_method_id, "");
  const t = rt.rows("Entries").find((e) => e.id === "e-pa-2");
  assert.equal(t.to_payment_method_id, "");
  assert.equal(t.payment_method_id, other.id, "the real side of the transfer is untouched");
});

test("a Yape / Plin link to the practice account is refused, and one that got there anyway is cleared by the cleanup", () => {
  const { rt } = freshApp({ small: true });
  const bcp = rt.api("addBank", { name: "BCP" });
  const mine = mk(rt, "Practice account", { bank_id: bcp.id });
  assert.match(JSON.stringify(post(rt, "saveRailLinks", { yape_pen: mine.id })), /rror|Yape|only|solo/i);
  assert.notEqual(rt.api("getMeta").settings.yape_pen, mine.id);
  rt.run(`setSetting_('yape_usd', ${JSON.stringify(mine.id)});`);
  rt.api("removePracticeAccounts", {});
  assert.ok(!rt.api("getMeta").settings.yape_usd, "the link is gone with the account");
});

test("an EBANX e-mail naming the practice account's last 4 digits does not land on it", () => {
  const { rt } = freshApp({ small: true });
  const mine = mk(rt, "Practice account", { last_4: "7777" });
  rt.svc.gmail.addEmail({
    from: "EBANX/Adobe - Braintree <payments@ebanx.com>",
    subject: "Pago confirmado del pedido BL0000000009 de Adobe - Braintree",
    body: ["Hola, Eva", "", "El pago de tu pedido en Adobe - Braintree ha sido confirmado. =)", "",
      "En el estado de cuenta, tu compra aparecerá como:", "EBN*ADOBE", "",
      "Pago vía Tarjeta de Crédito.", "Código BL0000000009 del Pedido Adobe - Braintree", "24/10/2026 | 07:32", "",
      "PIN                                    abcd1234", "Últimos dígitos tarjeta de crédito          7777",
      "Valor original en PEN                    S/ 24.19", "", "Valor final en PEN                   S/ 24.19", ""].join("\n")
  });
  rt.run("processEmails()");
  const e = rt.rows("Entries").find((x) => x.source === "email" && /ADOBE|Adobe/.test(x.description || ""));
  assert.ok(e, "the e-mail itself is still read");
  assert.notEqual(e.payment_method_id, mine.id, "but never on the practice account");
  assert.equal(e.payment_method_id, "");
});

test("a bank e-mail with no digits does not fall back to the practice account even when it is the bank's only one", () => {
  const { rt } = freshApp({ small: true });
  // The Diners insurance e-mail names no card: it goes to the bank's ONLY account. The practice account must not be that account.
  const banks = rt.rows("Banks");
  let diners = banks.find((b) => b.name === "Diners");
  if (!diners) diners = rt.api("addBank", { name: "Diners" });
  rt.rows("Payment Methods").filter((p) => p.bank_id === diners.id).forEach((p) => rt.run(`updateRowFields_('Payment Methods', ${JSON.stringify(p.id)}, { bank_id: '' });`));
  const mine = mk(rt, "Practice account", { bank_id: diners.id, type: "credit" });
  rt.svc.gmail.addEmail({ from: "tucomprobante@crecerseguros.pe", subject: "Comprobante electrónico", body: ["Boleta", "Número", "B001-000123", "Producto", "ProteccionTarjetas", "Monto Total", "S/ 9.90", ""].join("\n") });
  rt.run("processEmails()");
  const e = rt.rows("Entries").find((x) => x.source === "email" && /Crecer/.test(x.description || ""));
  if (e) assert.notEqual(e.payment_method_id, mine.id);
  assert.ok(!rt.rows("Entries").some((x) => x.payment_method_id === mine.id), "no entry carries the practice account");
});

test("the statement matchers skip the practice account: coverage list, inbox accounts and last-4 lookups", () => {
  const { rt } = freshApp({ small: true });
  const bank = rt.api("addBank", { name: "Interbank" });
  const mine = mk(rt, "Practice account", { bank_id: bank.id, type: "credit", last_4: "4242" });
  const cov = rt.api("listStatementCoverage", {});
  assert.ok(!cov.accounts.some((a) => /Practice account/.test(a.label)), "not in the statements coverage list");
  const out = rt.run(`stmtInboxAccounts_({ sender_key: 'x', bank_keyword: 'interbank' }, getAllRows('Payment Methods'), rowsById_(getAllRows('Banks'))).map(function (p) { return p.id; })`);
  assert.ok(!JSON.parse(JSON.stringify(out)).includes(mine.id), "not an account a statement e-mail is about");
  const found = rt.run(`stmtPmForKey_(getAllRows('Payment Methods'), '4242')`);
  assert.ok(!found, "a statement with these digits finds no account");
  const again = rt.api("createStatementAccounts", { accounts: [{ last4: "4242", bank: "Interbank", kind: "credit" }] });
  assert.equal(again.existing.length, 0, "the digits are not 'already taken' by the practice account");
});

test("Telegram account words never pick the practice account", () => {
  const { rt } = freshApp({ small: true });
  mk(rt, "Practice account", { type: "cash" });
  const got = rt.run(`fuzzyFindPaymentMethod_('practice account')`);
  assert.ok(!got);
});

test("the practice account does not stop the rename of automatic account names when the language changes", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Payment Methods").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; RATES_MEMO_ = null; bumpStructureVersion_();");
  post(rt, "saveOnboardingAccounts", { accounts: [{ cid: "a", bank: "BCP", kind: "debit_usd", alias: "", last4: "", showLast4: false }], links: {}, lang: "es" }, "es");
  mk(rt, "Practice account");
  assert.ok(rt.rows("Payment Methods").some((p) => p.nickname === "BCP dólares"));
  const changed = rt.run("relocalizeAutoAliases_('en')");
  assert.equal(changed, 1);
  assert.ok(rt.rows("Payment Methods").some((p) => p.nickname === "BCP dollars"));
  assert.ok(rt.rows("Payment Methods").some((p) => p.nickname === "Practice account"), "the practice account itself is not renamed");
});
