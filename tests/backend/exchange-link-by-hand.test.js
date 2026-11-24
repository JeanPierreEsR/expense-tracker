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

// Testers 2.68.2 (Rafael, Mark): the day limit only lived in the list, and a far-off rate linked silently.
test("linking sides months apart is refused on the server; a candidate says when its rate is far from the table", () => {
  const s = setup();
  const penFar = s.rt.api("createEntry", { type: "transfer", paid_by: "me", status: "confirmed", date: "2026-01-02", amount: 50, currency: "PEN", description: "Currency exchange", payment_method_id: s.pen.id });
  s.rt.run(`updateRowFields_('Entries', '${penFar.id}', { exchange: '1' })`);
  assert.throws(() => s.rt.api("linkExchangeSides", { id: penFar.id, partner_id: s.far.id }), /days apart/);
  const c = s.rt.api("listExchangeLinkCandidates", { id: s.out.id })[0];
  assert.equal(typeof c.far, "boolean");
  assert.equal(c.from, "USD");
  assert.equal(c.to, "PEN");
  assert.equal(c.rate, 3.5);
});

// Testers 2.68.2 (Valeria): an exchange made from a waiting USD e-mail left the bank's "Abono" of the soles waiting as a duplicate.
test("an exchange from a waiting item can take a second waiting item as its other side; both are turned in place", () => {
  const { rt } = freshApp({ small: true });
  const pen = rt.api("addPaymentMethod", { nickname: "Wait PEN", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Wait USD", type: "debit" });
  const cat = (t) => rt.rows("Categories").find((c) => c.type === t).id;
  const outW = rt.api("createEntry", { type: "expense", date: "2026-03-02", amount: 100, currency: "USD", category_id: cat("expense"), description: "Casa de cambio", payment_method_id: usd.id, paid_by: "me", status: "pending", source: "email" });
  const inW = rt.api("createEntry", { type: "income", date: "2026-03-03", amount: 375, currency: "PEN", category_id: cat("income"), description: "Abono por cambio", payment_method_id: pen.id, paid_by: "me", status: "pending", source: "email" });
  rt.run(`updateRowFields_('Entries', '${outW.id}', { status: 'pending' }); updateRowFields_('Entries', '${inW.id}', { status: 'pending' });`);   // as a bank e-mail leaves them
  const offered = rt.api("listExchangeOtherPending", { id: outW.id });
  assert.deepEqual(offered.map((x) => x.id), [inW.id]);
  const res = rt.api("recordCurrencyExchange", { date: "2026-03-02", in_date: "2026-03-03", out: { payment_method_id: usd.id, amount: 100, currency: "USD" },
    in: { payment_method_id: pen.id, amount: 375, currency: "PEN" }, pending_entry_id: outW.id, pending_leg: "out", other_pending_id: inW.id });
  assert.equal(res.out.id, outW.id);
  assert.equal(res.in.id, inW.id, "the waiting Abono became the other side");
  assert.equal(rt.rows("Entries").filter((e) => e.status === "pending" && (e.id === outW.id || e.id === inW.id)).length, 0, "nothing left waiting");
  assert.equal(res.out.exchange_pair, res.in.exchange_pair);
});
