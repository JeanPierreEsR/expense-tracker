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
