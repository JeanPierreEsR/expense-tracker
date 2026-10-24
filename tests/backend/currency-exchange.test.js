// Currency exchange = two one-sided transfers (2026-10-07): PEN leaves account A
// (no "To"), USD arrives in account B (no "From"). Each balance moves in its own
// currency, and neither leg is an expense or income.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("an exchange recorded as two one-sided transfers moves each balance in its own currency", () => {
  const { rt, data } = freshApp();
  const a = rt.api("addPaymentMethod", { nickname: "Exch PEN acct", type: "debit" });
  const b = rt.api("addPaymentMethod", { nickname: "Exch USD acct", type: "debit" });
  const day = today();
  rt.api("setPaymentMethodOpeningBalance", { id: a.id, balances: [{ currency: "PEN", amount: 5000, date: "2020-01-01" }] });
  rt.api("setPaymentMethodOpeningBalance", { id: b.id, balances: [{ currency: "USD", amount: 100, date: "2020-01-01" }] });
  const cat = data.cats.find((c) => c.type === "transfer");

  rt.api("createEntry", { type: "transfer", date: day, amount: 3700, currency: "PEN", category_id: cat.id,
    description: "exchange out", paid_by: "me", payment_method_id: a.id });
  // no payment_method_id (no "From"), only the destination
  rt.api("createEntry", { type: "transfer", date: day, amount: 1000, currency: "USD", category_id: cat.id,
    description: "exchange in", paid_by: "me", payment_method_id: "", to_payment_method_id: b.id });

  const bal = rt.api("listPaymentMethodBalances", {});
  const of = (id, cur) => bal.find((x) => x.id === id).balances.find((x) => x.currency === cur).amount;
  assert.equal(of(a.id, "PEN"), 1300);
  assert.equal(of(b.id, "USD"), 1100);
});

test("an exchange works the other way too: dollars leave one account, soles arrive in another", () => {
  const { rt, data } = freshApp();
  const a = rt.api("addPaymentMethod", { nickname: "Exch USD acct 2", type: "debit" });
  const b = rt.api("addPaymentMethod", { nickname: "Exch PEN acct 2", type: "debit" });
  const day = today();
  rt.api("setPaymentMethodOpeningBalance", { id: a.id, balances: [{ currency: "USD", amount: 2000, date: "2020-01-01" }] });
  rt.api("setPaymentMethodOpeningBalance", { id: b.id, balances: [{ currency: "PEN", amount: 100, date: "2020-01-01" }] });
  const cat = data.cats.find((c) => c.type === "transfer");

  rt.api("createEntry", { type: "transfer", date: day, amount: 500, currency: "USD", category_id: cat.id,
    description: "exchange out", paid_by: "me", payment_method_id: a.id });
  rt.api("createEntry", { type: "transfer", date: day, amount: 1850, currency: "PEN", category_id: cat.id,
    description: "exchange in", paid_by: "me", payment_method_id: "", to_payment_method_id: b.id });

  const bal = rt.api("listPaymentMethodBalances", {});
  const of = (id, cur) => bal.find((x) => x.id === id).balances.find((x) => x.currency === cur).amount;
  assert.equal(of(a.id, "USD"), 1500);
  assert.equal(of(b.id, "PEN"), 1950);
});

test("both legs of a saved exchange carry the exchange marker and listEntries returns it", () => {
  const { rt } = freshApp();
  const a = rt.api("addPaymentMethod", { nickname: "Marker A", type: "debit" });
  const b = rt.api("addPaymentMethod", { nickname: "Marker B", type: "debit" });
  rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: a.id, amount: 100, currency: "USD" }, in: { payment_method_id: b.id, amount: 370, currency: "PEN" }, house: "Some House" });
  const legs = rt.api("listEntries", { limit: 10 }).filter((e) => e.exchange === "1");
  assert.equal(legs.length, 2);
  assert.ok(rt.api("listEntries", { limit: 50 }).every((e) => e.exchange === "1" || !/Some House/.test(e.description)));
});
