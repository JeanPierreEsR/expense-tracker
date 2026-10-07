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
