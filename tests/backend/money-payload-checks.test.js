// The checks every money save makes before writing (testers 2.68.2, Rafael): made-up accounts, absurd amounts, unknown currencies,
// impossible dates and huge texts are refused with a plain message; a request the code cannot read never shows a JavaScript error.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("money saves refuse made-up accounts, absurd amounts, unknown currencies, impossible dates and huge texts", () => {
  const { rt } = freshApp({ small: true });
  rt.ctx.__f = { name: "Payload Friend" };
  const f = rt.run("addFriend(__f)");
  const pm = rt.rows("Payment Methods")[0].id;
  const base = { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-03-01", payment_method_id: pm };
  assert.ok(rt.api("addLoan", base).id, "a normal loan is saved");
  assert.throws(() => rt.api("addLoan", { ...base, payment_method_id: "made-up" }), /Account not found/);
  assert.throws(() => rt.api("addLoan", { ...base, amount: 1e308 }), /valid amount/);
  assert.throws(() => rt.api("addLoan", { ...base, currency: "ZZZ" }), /valid currency/);
  assert.throws(() => rt.api("addLoan", { ...base, date: "2026-13-45" }), /Date/);
  assert.throws(() => rt.api("addLoan", { ...base, description: "x".repeat(3000) }), /too long/);
  assert.throws(() => rt.api("recordCurrencyExchange", { date: "2026-03-01", out: { payment_method_id: pm, amount: 1e15, currency: "PEN" }, in: { amount: 10, currency: "USD" } }), /valid amount/);
});

test("a request the code cannot read gets a plain message, not a JavaScript error", () => {
  const { rt } = freshApp({ small: true });
  const res = rt.rawPost(JSON.stringify({ accessCode: "test-access-code", action: "linkExchangePairs", payload: { pairs: "abc" } }));
  assert.equal(res.ok, false);
  assert.ok(!/is not a function|undefined/.test(res.error), res.error);
});
