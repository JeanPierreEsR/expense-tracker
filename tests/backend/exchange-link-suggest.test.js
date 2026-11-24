// "Exchanges to link" (owner, 2026-11-23): old exchange sides saved apart on different days are suggested in pairs; the person links
// or refuses each. Made-up accounts, amounts and rates.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Sugg PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Sugg USD acct", type: "debit" });
  rt.run(`setExchangeRate('USD', '2026-03', 3.5)`);
  const side = (fields) => {
    const e = rt.api("createEntry", Object.assign({ type: "transfer", paid_by: "me", status: "confirmed", description: "Currency exchange" }, fields));
    rt.run(`ensureEntriesToPaymentMethodColumn_(); ensureEntriesExchangeColumn_(); updateRowFields_('Entries', '${e.id}', ${JSON.stringify(fields.to_payment_method_id ? { exchange: "1", to_payment_method_id: fields.to_payment_method_id } : { exchange: "1" })})`);
    return rt.api("getEntry", { id: e.id });
  };
  return { rt, pen, usd, side };
}
const glance = (rt) => rt.api("getHomeGlance", {}).exchangeLinks;

test("sides a day apart are suggested; same-day sides and far-off amounts are not", () => {
  const s = setup();
  const out = s.side({ date: "2026-03-02", amount: 3500, currency: "PEN", payment_method_id: s.pen.id });
  const inn = s.side({ date: "2026-03-03", amount: 1000, currency: "USD", to_payment_method_id: s.usd.id });
  // Same day: Home already shows them as one.
  s.side({ date: "2026-03-10", amount: 700, currency: "PEN", payment_method_id: s.pen.id });
  s.side({ date: "2026-03-10", amount: 200, currency: "USD", to_payment_method_id: s.usd.id });
  // Amounts that do not fit the rate.
  s.side({ date: "2026-03-20", amount: 100, currency: "PEN", payment_method_id: s.pen.id });
  s.side({ date: "2026-03-21", amount: 900, currency: "USD", to_payment_method_id: s.usd.id });
  const list = s.rt.api("listExchangeLinkSuggestions", {});
  assert.deepEqual(list.map((p) => [p.out.id, p.in.id]), [[out.id, inn.id]]);
  assert.equal(glance(s.rt), 1);
  s.rt.api("linkExchangePairs", { pairs: [{ id: out.id, partner_id: inn.id }] });
  assert.equal(s.rt.api("getEntry", { id: out.id }).exchange_pair, s.rt.api("getEntry", { id: inn.id }).exchange_pair);
  assert.equal(glance(s.rt), 0, "linked: nothing left to suggest");
});

test("'Not these' is remembered; 'Don't ask again' turns it off", () => {
  const s = setup();
  const out = s.side({ date: "2026-03-02", amount: 3500, currency: "PEN", payment_method_id: s.pen.id });
  const inn = s.side({ date: "2026-03-04", amount: 1000, currency: "USD", to_payment_method_id: s.usd.id });
  assert.equal(glance(s.rt), 1);
  s.rt.api("refuseExchangeLinkSuggestion", { out_id: out.id, in_id: inn.id });
  assert.equal(glance(s.rt), 0);
  s.side({ date: "2026-03-12", amount: 350, currency: "PEN", payment_method_id: s.pen.id });
  s.side({ date: "2026-03-13", amount: 100, currency: "USD", to_payment_method_id: s.usd.id });
  assert.equal(glance(s.rt), 1);
  s.rt.api("stopExchangeLinkSuggestions", {});
  assert.equal(glance(s.rt), 0);
});

test("every copy since 2.69 (owner, 2026-11-24): a friend's copy gets the card and the list too", () => {
  const s = setup();
  s.side({ date: "2026-03-02", amount: 3500, currency: "PEN", payment_method_id: s.pen.id });
  s.side({ date: "2026-03-03", amount: 1000, currency: "USD", to_payment_method_id: s.usd.id });
  assert.equal(glance(s.rt), 1);
  s.rt.svc.props.set("FEATURES", "base");
  assert.equal(glance(s.rt), 1);
  assert.equal(s.rt.api("listExchangeLinkSuggestions", {}).length, 1);
});
