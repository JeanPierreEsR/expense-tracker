// An account's currency from More → Accounts (2026-11-04, after the new-user test): a savings account names one, a card is soles and
// dollars unless it is in one currency only ('credit_usd', a foreign card). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const row = (rt, id) => rt.rows("Payment Methods").find((p) => p.id === id);

test("a new card can be in dollars only; a new card without a currency stays soles and dollars", () => {
  const { rt } = freshApp({ small: true });
  const us = post(rt, "savePaymentMethod", { nickname: "Test US card", type: "credit", currency: "USD" }).data;
  assert.equal(row(rt, us.id).alias_kind, "credit_usd");
  const pe = post(rt, "savePaymentMethod", { nickname: "Test PE card", type: "credit", currency: "" }).data;
  assert.equal(row(rt, pe.id).alias_kind, "credit");
  const old = post(rt, "savePaymentMethod", { nickname: "Test old phone", type: "credit" }).data;
  assert.equal(String(row(rt, old.id).alias_kind || ""), "", "an older phone sends no currency: nothing stored, as before");
});

test("editing a savings account's currency changes its kind; a salary account stays a salary account", () => {
  const { rt } = freshApp({ small: true });
  const r = post(rt, "saveOnboardingAccounts", { accounts: [{ cid: "a1", bank: "BCP", kind: "debit_pen", alias: "", last4: "", showLast4: false }, { cid: "a2", bank: "BBVA", kind: "sueldo", alias: "Mi sueldo", last4: "", showLast4: false }], links: {}, lang: "es" }, "es").data;
  const [deb, sal] = r.accounts;
  const before = row(rt, deb.id);
  const saved = post(rt, "savePaymentMethod", { id: deb.id, nickname: before.nickname, type: "debit", bank_id: before.bank_id, last_4: "", currency: "USD" }, "es").data;
  assert.equal(row(rt, deb.id).alias_kind, "debit_usd");
  assert.equal(saved.nickname, "BCP dólares", "an automatic name follows the new currency");
  const s = row(rt, sal.id);
  post(rt, "savePaymentMethod", { id: sal.id, nickname: s.nickname, type: "debit", bank_id: s.bank_id, last_4: "", currency: "USD" }, "es");
  assert.equal(row(rt, sal.id).alias_kind, "sueldo_usd");
  assert.equal(row(rt, sal.id).nickname, "Mi sueldo", "a typed name is kept");
});

test("a welcome card in dollars only is accepted and never offers Plin", () => {
  const { rt } = freshApp({ small: true });
  const r = post(rt, "saveOnboardingAccounts", { accounts: [{ cid: "c1", bank: "Interbank", kind: "credit_usd", alias: "", last4: "", showLast4: false }], links: {}, lang: "es" }, "es").data;
  const card = row(rt, r.accounts[0].id);
  assert.equal(card.type, "credit");
  assert.equal(card.alias_kind, "credit_usd");
  assert.equal(card.nickname, "Interbank crédito");
});

// ---- A list of currencies (owner, 2026-11-06) ----
test("the stored list is clean: upper case, once each, 'none' when empty", () => {
  const { rt } = freshApp({ small: true });
  const v = (l) => JSON.parse(rt.run("JSON.stringify(accountCurrenciesValue_(" + JSON.stringify(l) + "))"));
  assert.equal(v(["pen", "USD", "PEN", "bad!"]), "PEN,USD");
  assert.equal(v([]), "none");
});

test("a savings account can hold several currencies: its kind and name stay, one chosen later names it again", () => {
  const { rt } = freshApp({ small: true });
  const a = rt.api("savePaymentMethod", { nickname: "Ahorros", type: "debit", currency: "PEN" });
  assert.equal(row(rt, a.id).alias_kind, "debit_pen");
  const two = rt.api("savePaymentMethod", { id: a.id, nickname: "Ahorros", type: "debit", currencies: ["PEN", "USD"] });
  assert.equal(two.currencies, "PEN,USD");
  assert.equal(row(rt, a.id).currencies, "PEN,USD");
  assert.equal(row(rt, a.id).alias_kind, "debit_pen", "several leave the kind alone");
  assert.equal(row(rt, a.id).nickname, "Ahorros");
  rt.api("savePaymentMethod", { id: a.id, nickname: "Ahorros", type: "debit", currencies: ["USD"] });
  assert.equal(row(rt, a.id).alias_kind, "debit_usd");
  assert.equal(row(rt, a.id).currencies, "USD");
  rt.api("savePaymentMethod", { id: a.id, nickname: "Ahorros", type: "debit", currencies: [] });
  assert.equal(row(rt, a.id).currencies, "none", "cleared on purpose");
});

test("an older account with no currency stays empty when saved with an empty list, never given the main currency", () => {
  const { rt } = freshApp({ small: true });
  const a = rt.api("savePaymentMethod", { nickname: "Vieja", type: "debit" });
  assert.equal(String(row(rt, a.id).alias_kind || ""), "");
  rt.api("savePaymentMethod", { id: a.id, nickname: "Vieja", type: "debit", currencies: [] });
  assert.equal(String(row(rt, a.id).alias_kind || ""), "", "no currency slips in");
});

test("a card with several is a plain card; one makes it one-currency; an older phone's single currency replaces the list", () => {
  const { rt } = freshApp({ small: true });
  const c = rt.api("savePaymentMethod", { nickname: "Tarjeta", type: "credit", currencies: ["PEN"] });
  assert.equal(row(rt, c.id).alias_kind, "credit_pen");
  rt.api("savePaymentMethod", { id: c.id, nickname: "Tarjeta", type: "credit", currencies: ["PEN", "USD"] });
  assert.equal(row(rt, c.id).alias_kind, "credit");
  rt.api("savePaymentMethod", { id: c.id, nickname: "Tarjeta", type: "credit", currency: "USD" });
  assert.equal(row(rt, c.id).alias_kind, "credit_usd");
  assert.equal(String(row(rt, c.id).currencies || ""), "");
});

test("cash and wallets take no list; the welcome stores one", () => {
  const { rt } = freshApp({ small: true });
  const w = rt.api("savePaymentMethod", { nickname: "Billetera", type: "wallet", currencies: ["PEN"] });
  assert.equal(String(row(rt, w.id).currencies || ""), "");
  const res = rt.api("saveOnboardingAccounts", { batch: "b-1", lang: "es", links: {}, accounts: [{ cid: "c1", bank: "BBVA", kind: "debit_pen", currencies: ["PEN", "USD"], alias: "Mi cuenta", last4: "", showLast4: false }] });
  const made = (res.created || res.accounts || []).find((x) => x.cid === "c1");
  assert.equal(row(rt, made.id).currencies, "PEN,USD");
});

// ---- Suggested currencies for older accounts (owner, 2026-11-06: see it first, nothing applied until Apply) ----
const jsv = (rt, code) => JSON.parse(rt.run("JSON.stringify(" + code + ")"));
test("an account's name states its currency, in either language, or says nothing", () => {
  const { rt } = freshApp({ small: true });
  for (const [name, want] of [["BCP soles", "PEN"], ["Ahorros Sol", "PEN"], ["IBK dolares", "USD"], ["Cuenta dólares", "USD"], ["Savings USD", "USD"], ["Ahorro euros", "EUR"],
    ["Interbank", ""], ["Soldado", ""], ["Soles y dolares", ""], ["Autos", ""]]) {
    assert.equal(jsv(rt, "accountNameCurrency_(" + JSON.stringify(name) + ")"), want, name);
  }
});

test("entries decide only with 5 or more, listing every currency with 10% of them", () => {
  const { rt } = freshApp({ small: true });
  const t = (list) => jsv(rt, "accountEntriesCurrencies_(" + JSON.stringify(list) + ")");
  assert.deepEqual(t(["PEN", "PEN", "PEN", "PEN"]), []);
  assert.deepEqual(t(["PEN", "PEN", "PEN", "PEN", "PEN"]), ["PEN"]);
  assert.deepEqual(t(["USD", "USD", "USD", "USD", "PEN"]), ["USD", "PEN"]);
  assert.deepEqual(t([...Array(19).fill("PEN"), "USD"]), ["PEN"], "5% is left out");
});

function seededOld() {
  const { rt } = freshApp({ small: true });
  const add = (o) => rt.run("appendRowObject('Payment Methods', " + JSON.stringify(Object.assign({ last_4: "", bank_id: "" }, o)) + ")");
  rt.run("ensurePaymentMethodAliasColumns_(); ensurePaymentMethodCurrenciesColumn_()");
  add({ id: "h1", nickname: "Banco soles", type: "debit" });
  add({ id: "h3", nickname: "Banco sin nada", type: "debit" });
  add({ id: "h4", nickname: "Tarjeta soles", type: "credit" });
  add({ id: "h5", nickname: "Banco soles dos", type: "debit", alias_kind: "debit_usd" });
  add({ id: "h6", nickname: "Mezcla", type: "debit" });
  add({ id: "h7", nickname: "Banco soles tres", type: "debit", currencies: "EUR" });
  add({ id: "h8", nickname: "Plain card", type: "credit", alias_kind: "credit" });
  add({ id: "h9", nickname: "Efectivo soles", type: "cash" });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  ["PEN", "PEN", "PEN", "USD", "USD"].forEach((currency, i) => rt.run("appendRowObject('Entries', " + JSON.stringify({ id: "he" + i, type: "expense", date: "2026-01-0" + (i + 1), amount: 5, currency, category_id: cat, payment_method_id: "h6", paid_by: "me", status: "confirmed" }) + ")"));
  return rt;
}

test("the suggestions change nothing and list only accounts the app knows nothing about", () => {
  const rt = seededOld();
  const before = JSON.stringify(rt.rows("Payment Methods"));
  const res = rt.api("getAccountCurrencySuggestions", {});
  assert.equal(JSON.stringify(rt.rows("Payment Methods")), before, "looking writes nothing");
  const of = (id) => res.accounts.find((a) => a.id === id);
  assert.deepEqual(of("h1").proposed, ["PEN"]);
  assert.equal(of("h1").source, "name");
  assert.deepEqual(of("h3").proposed, []);
  assert.equal(of("h3").source, "none");
  assert.deepEqual(of("h4").proposed, ["PEN"], "an older card too");
  assert.deepEqual(of("h6").proposed, ["PEN", "USD"]);
  assert.equal(of("h6").source, "entries");
  assert.deepEqual(of("h6").counts, { PEN: 3, USD: 2 });
  for (const id of ["h5", "h7", "h8", "h9"]) assert.ok(!of(id), id + " already says, or is cash");
});

test("Apply writes only the list, only what was sent, and never over something already known; names and kinds stay", () => {
  const rt = seededOld();
  rt.api("applyAccountCurrencySuggestions", { items: [{ id: "h1", currencies: ["PEN"] }, { id: "h6", currencies: ["PEN", "USD"] }, { id: "h5", currencies: ["EUR"] }, { id: "h3", currencies: [] }] });
  const of = (id) => rt.rows("Payment Methods").find((r) => r.id === id);
  assert.equal(of("h1").currencies, "PEN");
  assert.equal(of("h6").currencies, "PEN,USD");
  assert.equal(String(of("h5").currencies || ""), "", "known already: left alone");
  assert.equal(String(of("h3").currencies || ""), "", "nothing ticked: stays empty");
  assert.equal(String(of("h4").currencies || ""), "", "not sent: stays empty");
  assert.equal(of("h1").nickname, "Banco soles");
  assert.equal(String(of("h1").alias_kind || ""), "");
  assert.equal(rt.api("getAccountCurrencySuggestions", {}).accounts.find((a) => a.id === "h1"), undefined, "applied: no longer suggested");
});

test("a friend's copy gets no suggestions and cannot apply them", () => {
  const rt = seededOld();
  rt.svc.props.set("FEATURES", "base");
  assert.deepEqual(rt.api("getAccountCurrencySuggestions", {}).accounts, []);
  assert.throws(() => rt.api("applyAccountCurrencySuggestions", { items: [{ id: "h1", currencies: ["PEN"] }] }));
});
