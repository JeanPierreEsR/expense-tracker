// "Add USD to this account" from the exchange form (testers 2.68.2): the account keeps its currencies and gains one; any copy.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("addAccountCurrency adds one currency, keeps the others, refuses a made-up code", () => {
  const { rt } = freshApp({ small: true });
  const pm = rt.rows("Payment Methods").find((p) => p.type === "debit") || rt.rows("Payment Methods")[0];
  rt.run(`ensurePaymentMethodCurrenciesColumn_()`);
  rt.api("addAccountCurrency", { id: pm.id, currency: "PEN" });
  const out = rt.api("addAccountCurrency", { id: pm.id, currency: "usd" });
  assert.equal(out.currencies, "PEN,USD");
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === pm.id).currencies, "PEN,USD");
  assert.equal(rt.api("addAccountCurrency", { id: pm.id, currency: "USD" }).currencies, "PEN,USD", "a second add changes nothing");
  assert.throws(() => rt.api("addAccountCurrency", { id: pm.id, currency: "ZZZ" }));
  assert.throws(() => rt.api("addAccountCurrency", { id: "nope", currency: "EUR" }));
});
