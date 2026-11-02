// First-use Currency exchange practice: the one-call cleanup deletes only the practice's own legs, recording one writes no rate and
// teaches the app nothing about real exchange houses. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Xp PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Xp USD acct", type: "debit" });
  const exchange = (house, amounts = [370, 100]) => rt.api("recordCurrencyExchange", {
    date: today(), house,
    out: { payment_method_id: pen.id, amount: amounts[0], currency: "PEN" },
    in: { payment_method_id: usd.id, amount: amounts[1], currency: "USD" }
  });
  return { rt, data, pen, usd, exchange };
}
const ids = (rt) => rt.rows("Entries").map((e) => e.id);

test("removePracticeExchange deletes both legs of the practice exchange (English and Spanish name) and nothing else", () => {
  const { rt, exchange } = setup();
  const real = exchange("Rextie", [3700, 1000]);
  const realNoHouse = exchange("", [740, 200]);
  const mine = exchange("Practice exchange");
  const es = exchange("Cambio de práctica", [37, 10]);
  const before = ids(rt).length;
  const res = rt.api("removePracticeExchange", { started_on: today() });
  assert.equal(res.entries, 4);
  const left = ids(rt);
  assert.equal(left.length, before - 4);
  for (const e of [mine, es]) assert.ok(!left.includes(e.out.id) && !left.includes(e.in.id), "practice legs gone");
  for (const e of [real, realNoHouse]) assert.ok(left.includes(e.out.id) && left.includes(e.in.id), "real exchange legs stay");
  assert.equal(rt.api("removePracticeExchange", { started_on: today() }).entries, 0, "a repeat is harmless");
});

test("a practice exchange dated before the practice started is not touched, unless it was saved since (the person changed its date)", () => {
  const { rt, pen, usd } = setup();
  rt.api("recordCurrencyExchange", { date: "2020-01-02", house: "Practice exchange", out: { payment_method_id: pen.id, amount: 3.7, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 1, currency: "USD" } });
  // saved just now (created_at is today) but dated in the past: the practice made it, so it goes
  assert.equal(rt.api("removePracticeExchange", { started_on: today() }).entries, 2);
  // an old row (made long ago) with the marker is left alone
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "old-pe", type: "transfer", date: "2020-01-02", created_at: "2020-01-02T10:00:00", amount: 5, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Practice exchange)", paid_by: "me", payment_method_id: pen.id })})`);
  assert.equal(rt.api("removePracticeExchange", { started_on: today() }).entries, 0);
  assert.ok(ids(rt).includes("old-pe"));
});

test("a real entry that merely mentions the practice words is never deleted", () => {
  const { rt, pen, usd } = setup();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "r1", type: "transfer", date: today(), created_at: today() + "T09:00:00", amount: 50, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Practice exchange house)", paid_by: "me", payment_method_id: pen.id })})`);
  const cat = rt.rows("Categories").find((c) => c.type === "expense");
  rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat.id, description: "Practice exchange", paid_by: "me", payment_method_id: pen.id });
  assert.equal(rt.api("removePracticeExchange", { started_on: today() }).entries, 0);
  assert.ok(ids(rt).includes("r1"));
  void usd;
});

test("recording an exchange writes no exchange rate, makes nothing pending and sends nothing", () => {
  const { rt, exchange } = setup();
  const ratesBefore = JSON.stringify(rt.rows("Exchange Rates"));
  const pendingBefore = rt.rows("Entries").filter((e) => e.status === "pending").length;
  exchange("Practice exchange");
  assert.equal(JSON.stringify(rt.rows("Exchange Rates")), ratesBefore, "the rates table is untouched (the rate line in the form is only shown)");
  assert.equal(rt.rows("Entries").filter((e) => e.status === "pending").length, pendingBefore);
  rt.api("removePracticeExchange", { started_on: today() });
  assert.equal(JSON.stringify(rt.rows("Exchange Rates")), ratesBefore, "and the cleanup does not touch them either");
});

test("the practice's house name is never learned as an exchange house, and its legs never pair with a real exchange e-mail", () => {
  const { rt, exchange, pen, usd } = setup();
  exchange("Practice exchange", [370, 100]);
  assert.equal(rt.run("exchangeHouseIn_('Practice exchange')"), false);
  assert.equal(rt.run("exchangeHouseIn_('Cambio de práctica')"), false);
  assert.equal(rt.run("exchangeHouseIn_('Rextie SAC')"), true, "the built-in houses still work");
  // a real hand-made exchange house is still learned
  exchange("Cambios Zeta Norte");
  assert.equal(rt.run("exchangeHouseIn_('Cambios Zeta Norte S.')"), true);
  // the account memory ignores the practice's legs: only the real exchange's accounts are remembered
  const only = setup();
  const other = only.rt.api("addPaymentMethod", { nickname: "Xp other", type: "debit" });
  only.rt.api("recordCurrencyExchange", { date: today(), house: "Practice exchange", out: { payment_method_id: only.pen.id, amount: 37, currency: "PEN" }, in: { payment_method_id: other.id, amount: 10, currency: "USD" } });
  assert.equal(only.rt.run("lastExchangeAccount_(getAllRows('Entries'), 'USD', 'in')"), "");
  // a practice leg is no "twin" of a real leg of the same size
  const twin = JSON.parse(JSON.stringify(rt.run("findExchangeLegTwin_(getAllRows('Entries').filter(function (e) { return isPracticeExchange_(e); }), 'out', 'PEN', 370, '" + today() + "', '', 'house')")));
  assert.equal(twin, null);
  void pen; void usd;
});

test("one practice leg left alone is not reported under 'Not captured automatically'", () => {
  const { rt, pen } = setup();
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "lone", type: "transfer", date: "2026-03-20", created_at: "2026-03-20T10:00:00", amount: 5, currency: "PEN", status: "confirmed", source: "manual", description: "Currency exchange (Practice exchange)", paid_by: "me", payment_method_id: pen.id })})`);
  assert.deepEqual(JSON.parse(JSON.stringify(rt.run("unpairedExchangeLegs_()"))), []);
});

test("the backend says it can clean the Currency exchange practice up", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta").capabilities.practiceExchange, true);
});
