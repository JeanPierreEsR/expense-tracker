// The two sides of a currency exchange are ONE exchange for the person (owner, 2026-11-02): new ones carry the same
// exchange_pair id; older ones are paired with the opposite-side leg in another currency on the SAME day. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("a new exchange gives both sides the same pair id, and each names the other as its partner", () => {
  const { rt, data } = freshApp();
  const pm = data.pms.find((p) => p.type !== "investment").id;
  const r = rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: pm, amount: 500, currency: "PEN" }, in: { payment_method_id: pm, amount: 100, currency: "USD" } });
  const out = rt.rows("Entries").find((e) => e.id === r.out.id), inn = rt.rows("Entries").find((e) => e.id === r.in.id);
  assert.ok(out.exchange_pair);
  assert.equal(out.exchange_pair, inn.exchange_pair);
  assert.equal(rt.api("getEntryRepaymentLinks", { id: out.id }).exchangePartner.id, inn.id);
  assert.equal(rt.api("getEntryRepaymentLinks", { id: inn.id }).exchangePartner.id, out.id);
});

test("an older exchange (no pair id) is paired with the other side on the same day only", () => {
  const { rt, data } = freshApp();
  const pm = data.pms.find((p) => p.type !== "investment").id;
  const tr = rt.rows("Categories").find((c) => c.type === "transfer").id;
  rt.run("ensureEntriesExchangeColumn_()");
  const leg = (date, side, currency, amount) => {
    const e = rt.api("createEntry", { type: "transfer", date, amount, currency, category_id: tr, description: "Currency exchange: " + currency, paid_by: "me",
      payment_method_id: side === "out" ? pm : "", to_payment_method_id: side === "in" ? pm : "" });
    rt.run(`updateRowFields_('Entries', ${JSON.stringify(e.id)}, { exchange: '1' })`);
    return e.id;
  };
  const a = leg("2026-09-10", "out", "PEN", 370), b = leg("2026-09-10", "in", "USD", 100);
  const c = leg("2026-09-12", "out", "PEN", 74), d = leg("2026-09-13", "in", "USD", 20);
  const la = rt.api("getEntryRepaymentLinks", { id: a });
  assert.ok(la.exchangePartner, JSON.stringify(la) + " " + JSON.stringify(rt.rows("Entries").filter((e) => e.id === a || e.id === b)));
  assert.equal(la.exchangePartner.id, b, "same day: paired");
  assert.equal(rt.api("getEntryRepaymentLinks", { id: c }).exchangePartner, undefined, "a day apart: not paired");
  void d;
});
