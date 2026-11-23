// The money of an exchange can arrive another day (owner, 2026-11-23): the form's optional "arrived on" date goes to the arrived side only,
// and two sides linked by their pair id are never listed as "missing a side", however many days apart. Made-up accounts and amounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Late PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Late USD acct", type: "debit" });
  return { rt, pen, usd };
}
const exchange = (s, extra) => s.rt.api("recordCurrencyExchange", Object.assign({ date: "2026-03-02",
  out: { payment_method_id: s.pen.id, amount: 3500, currency: "PEN" }, in: { payment_method_id: s.usd.id, amount: 1000, currency: "USD" } }, extra));

test("the arrived side takes its own day; the side that left keeps the date", () => {
  const s = setup();
  const res = exchange(s, { in_date: "2026-03-09" });
  assert.equal(res.out.date, "2026-03-02");
  assert.equal(res.in.date, "2026-03-09");
  assert.ok(res.out.exchange_pair && res.out.exchange_pair === res.in.exchange_pair, "still one exchange");
});

test("no arrival day: both sides share the date; a bad one is refused", () => {
  const s = setup();
  const res = exchange(s, {});
  assert.equal(res.in.date, "2026-03-02");
  assert.throws(() => exchange(s, { in_date: "9 March" }));
});

test("sides linked by their pair id a week apart are not 'missing a side'", () => {
  const s = setup();
  exchange(s, { in_date: "2026-03-09" });
  assert.deepEqual(JSON.parse(JSON.stringify(s.rt.run("unpairedExchangeLegs_()"))), []);
});
