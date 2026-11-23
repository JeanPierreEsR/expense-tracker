// Linking one side of an exchange to its other side by hand (owner, 2026-11-23). Made-up accounts and amounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Link PEN acct", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Link USD acct", type: "debit" });
  // Two lone sides, saved one by one as plain exchange sides (as a statement or an old entry would be), four days apart.
  const side = (fields) => {
    const e = rt.api("createEntry", Object.assign({ type: "transfer", paid_by: "me", status: "confirmed" }, fields));
    rt.run(`ensureEntriesToPaymentMethodColumn_(); ensureEntriesExchangeColumn_(); updateRowFields_('Entries', '${e.id}', { exchange: '1' })`);
    return rt.api("getEntry", { id: e.id });
  };
  const out = side({ date: "2026-03-02", amount: 3500, currency: "PEN", description: "Currency exchange", payment_method_id: pen.id });
  const inn = side({ date: "2026-03-06", amount: 1000, currency: "USD", description: "Currency exchange", to_payment_method_id: usd.id });
  const far = side({ date: "2026-04-20", amount: 500, currency: "USD", description: "Currency exchange", to_payment_method_id: usd.id });
  return { rt, pen, usd, out, inn, far };
}

test("the other side is offered within 10 days; one too far away is not", () => {
  const s = setup();
  const list = s.rt.api("listExchangeLinkCandidates", { id: s.out.id });
  assert.deepEqual(list.map((c) => c.id), [s.inn.id]);
  assert.equal(list[0].side, "in");
  assert.equal(list[0].taken, false);
});

test("linking gives both one link id; the old partner of a wrong link is left on its own", () => {
  const s = setup();
  const res = s.rt.api("linkExchangeSides", { id: s.inn.id, partner_id: s.out.id });
  assert.equal(res.out.id, s.out.id);
  assert.ok(res.out.exchange_pair && res.out.exchange_pair === res.in.exchange_pair);
  // Now listed as taken from the other side's point of view of a third side in PEN.
  const pen2 = s.rt.api("createEntry", { type: "transfer", paid_by: "me", status: "confirmed", date: "2026-03-05", amount: 3400, currency: "PEN", description: "Currency exchange", payment_method_id: s.pen.id });
  s.rt.run(`updateRowFields_('Entries', '${pen2.id}', { exchange: '1' })`);
  const list = s.rt.api("listExchangeLinkCandidates", { id: pen2.id });
  assert.equal(list.find((c) => c.id === s.inn.id).taken, true);
  s.rt.api("linkExchangeSides", { id: pen2.id, partner_id: s.inn.id });
  const before = s.rt.api("getEntry", { id: s.out.id });
  assert.notEqual(before.exchange_pair, s.rt.api("getEntry", { id: s.inn.id }).exchange_pair, "the first side is on its own again");
});

test("refused: two sides in the same direction or the same currency, or an entry that is not an exchange side", () => {
  const s = setup();
  assert.throws(() => s.rt.api("linkExchangeSides", { id: s.inn.id, partner_id: s.far.id }));
  const plain = s.rt.api("createEntry", { type: "expense", paid_by: "me", status: "confirmed", date: "2026-03-02", amount: 10, currency: "USD", description: "Lunch" });
  assert.throws(() => s.rt.api("linkExchangeSides", { id: s.out.id, partner_id: plain.id }));
  assert.throws(() => s.rt.api("listExchangeLinkCandidates", { id: plain.id }));
});
