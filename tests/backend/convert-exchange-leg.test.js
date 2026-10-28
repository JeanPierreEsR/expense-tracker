// One side of a currency exchange turned into an expense / income (entry-type conversions plan, step 5).
// The two sides are separate entries: only the one edited changes, and the app is told where the other side is.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const pen = rt.api("addPaymentMethod", { nickname: "Leg PEN", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Leg USD", type: "debit" });
  const res = rt.api("recordCurrencyExchange", { date: today(), house: "Cambios Zeta", out: { payment_method_id: pen.id, amount: 370, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 100, currency: "USD" } });
  const cat = (type) => data.cats.find((c) => c.type === type);
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  return { rt, data, pen, usd, res, cat, row };
}

test("the money-out side becomes an expense; the marker goes and the other side is left alone", () => {
  const { rt, pen, res, cat, row } = setup();
  const out = rt.api("updateEntry", { id: res.out.id, fields: { type: "expense", category_id: cat("expense").id, payment_method_id: pen.id, to_payment_method_id: "", description: "Fee at the house" } });
  assert.equal(out.type, "expense");
  assert.ok(!row(res.out.id).exchange);
  assert.equal(row(res.in.id).type, "transfer");
  assert.equal(row(res.in.id).exchange, "1");
});

test("the money-in side becomes an income, taking its account as the account received at", () => {
  const { rt, usd, res, cat, row } = setup();
  rt.api("updateEntry", { id: res.in.id, fields: { type: "income", category_id: cat("income").id, payment_method_id: usd.id, to_payment_method_id: "" } });
  assert.equal(row(res.in.id).type, "income");
  assert.equal(row(res.in.id).payment_method_id, usd.id);
  assert.ok(!row(res.in.id).exchange);
});

test("the check names the other side before the change", () => {
  const { rt, res } = setup();
  const out = rt.api("checkEntryTypeChange", { id: res.out.id, type: "expense" });
  assert.equal(out.blocked, "");
  assert.equal(out.exchangePartner.id, res.in.id);
  assert.equal(rt.api("checkEntryTypeChange", { id: res.in.id, type: "income" }).exchangePartner.id, res.out.id);
  assert.match(rt.api("checkEntryTypeChange", { id: res.out.id, type: "income" }).blocked, /money-out/i);
  assert.equal(rt.api("checkEntryTypeChange", { id: res.out.id, type: "transfer" }).exchangePartner, null);
});

test("no partner is named when the other side is missing or far away in time", () => {
  const { rt, pen } = setup();
  const lone = rt.api("recordCurrencyExchange", { date: "2020-03-01", out: { payment_method_id: pen.id, amount: 37, currency: "PEN" }, in: { payment_method_id: "", amount: 10, currency: "USD" } });
  assert.equal(rt.api("checkEntryTypeChange", { id: lone.out.id, type: "expense" }).exchangePartner, null);
});

test("an exchange side can become an investment deposit", () => {
  const { rt, res, pen, row } = setup();
  const platform = rt.api("addPaymentMethod", { nickname: "Leg Broker", type: "investment" });
  rt.api("updateEntry", { id: res.out.id, fields: { type: "investment", payment_method_id: pen.id, to_payment_method_id: platform.id } });
  assert.equal(row(res.out.id).type, "investment");
  assert.ok(!row(res.out.id).exchange);
});
