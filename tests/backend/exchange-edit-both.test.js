// A whole currency exchange is edited in one form (owner, 2026-11-23): both sides change together, keep one account each and stay one
// exchange. Made-up accounts and amounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Edit PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Edit USD acct", type: "debit" });
  const usd2 = rt.api("addPaymentMethod", { nickname: "Edit USD acct 2", type: "debit" });
  const made = rt.api("recordCurrencyExchange", { date: "2026-03-02", house: "Casa Uno",
    out: { payment_method_id: pen.id, amount: 3500, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1000, currency: "USD" } });
  return { rt, pen, usd, usd2, made };
}
const edit = (s, extra) => s.rt.api("updateCurrencyExchange", Object.assign({ out_id: s.made.out.id, in_id: s.made.in.id, date: "2026-03-03",
  out: { payment_method_id: s.pen.id, amount: 3600, currency: "PEN" }, in: { payment_method_id: s.usd2.id, amount: 1010, currency: "USD" } }, extra));

test("both sides change together and stay one exchange", () => {
  const s = setup();
  const res = edit(s, { in_date: "2026-03-05" });
  assert.equal(res.out.date, "2026-03-03");
  assert.equal(Number(res.out.amount), 3600);
  assert.equal(res.out.payment_method_id, s.pen.id);
  assert.equal(res.out.to_payment_method_id, "");
  assert.equal(res.in.date, "2026-03-05");
  assert.equal(Number(res.in.amount), 1010);
  assert.equal(res.in.to_payment_method_id, s.usd2.id);
  assert.equal(res.in.payment_method_id, "");
  assert.equal(res.out.exchange_pair, s.made.out.exchange_pair);
  assert.equal(res.in.exchange_pair, s.made.out.exchange_pair);
});

test("the descriptions are written again only when the house changed", () => {
  const s = setup();
  const kept = edit(s, {});
  assert.equal(kept.out.description, s.made.out.description);
  const renamed = edit(s, { house: "Casa Dos" });
  assert.match(renamed.out.description, /Casa Dos/);
  assert.match(renamed.in.description, /Casa Dos/);
});

test("refused: a side with no account, the same currency, or a side that is no longer an exchange", () => {
  const s = setup();
  assert.throws(() => edit(s, { in: { payment_method_id: "", amount: 1010, currency: "USD" } }));
  assert.throws(() => edit(s, { in: { payment_method_id: s.usd.id, amount: 1010, currency: "PEN" } }));
  assert.throws(() => edit(s, { in_id: s.made.out.id }));
  const after = s.rt.api("getEntry", { id: s.made.out.id });
  assert.equal(Number(after.amount), 3500, "nothing changed by a refusal");
});
