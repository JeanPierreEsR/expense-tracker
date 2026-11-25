// Refunds on a purchase (Refunds.gs, owner's plan 2026-11-24): same month = a minus expense in the purchase's category, a later month =
// Refunds income; a shared purchase's refund is divided like it; a refund on its way counts nowhere until it arrives. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));

function setup() {
  const { rt } = freshApp({ small: true });
  const meta = rt.api("getMeta");
  const pm = meta.paymentMethods.filter((p) => p.type !== "investment")[0].id;
  const cat = meta.categories.find((c) => c.type === "expense").id;
  const friend = rt.api("addFriend", { name: "Refund Friend " + Math.random().toString(36).slice(2, 6) });
  const purchase = (fields = {}) => {
    const e = rt.api("createEntry", Object.assign({ type: "expense", date: "2031-03-05", category_id: cat, status: "confirmed", paid_by: "me", amount: 300, currency: "PEN",
      description: "Jacket", payment_method_id: pm }, fields));
    return e;
  };
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  const refundsOf = (id) => rt.rows("Entries").filter((e) => e.refund_of === id);
  const owed = (fid) => {
    const f = rt.api("listLoanBalances", {}).find((x) => x.friend_id === fid);
    const b = f && f.balances.find((x) => x.currency === "PEN");
    return b ? Math.round(b.net * 100) / 100 : 0;
  };
  return { rt, meta, pm, cat, friend, purchase, row, refundsOf, owed };
}

test("same month: a minus expense in the purchase's category, on the account, linked", () => {
  const t = setup();
  const p = t.purchase();
  const out = t.rt.api("recordRefund", { entry_id: p.id, amount: 120, date: "2031-03-20", payment_method_id: t.pm });
  assert.equal(out.kind, "offset");
  const r = t.row(out.entry.id);
  assert.equal(r.type, "expense");
  assert.equal(Number(r.amount), -120);
  assert.equal(r.category_id, t.cat);
  assert.equal(r.payment_method_id, t.pm);
  assert.equal(r.refund_of, p.id);
  const listed = t.rt.api("listEntries", { startDate: "2031-03-01", endDate: "2031-03-31" }).find((e) => e.id === p.id);
  assert.equal(listed.refunded, 120);
});

test("a later month: income in Refunds; the purchase's month is untouched", () => {
  const t = setup();
  const p = t.purchase();
  const out = t.rt.api("recordRefund", { entry_id: p.id, amount: 300, date: "2031-04-02", payment_method_id: t.pm });
  assert.equal(out.kind, "income");
  const r = t.row(out.entry.id);
  assert.equal(r.type, "income");
  assert.equal(Number(r.amount), 300);
  const cat = t.rt.rows("Categories").find((c) => c.id === r.category_id);
  assert.equal(cat.name, "Refunds");
  assert.equal(Number(t.row(p.id).amount), 300);
});

test("never more than the purchase, together; never before it", () => {
  const t = setup();
  const p = t.purchase();
  t.rt.api("recordRefund", { entry_id: p.id, amount: 200, date: "2031-03-06", payment_method_id: t.pm });
  assert.equal(post(t.rt, "recordRefund", { entry_id: p.id, amount: 150, date: "2031-03-07", payment_method_id: t.pm }).ok, false);
  assert.equal(post(t.rt, "recordRefund", { entry_id: p.id, amount: 50, date: "2031-03-01", payment_method_id: t.pm }).ok, false);
  t.rt.api("recordRefund", { entry_id: p.id, amount: 100, date: "2031-03-07", payment_method_id: t.pm });
  assert.equal(t.refundsOf(p.id).length, 2);
  // the purchase can't go below what came back; a refund can't grow past what is left
  assert.equal(post(t.rt, "updateEntry", { id: p.id, fields: { amount: 250 } }).ok, false);
  const first = t.refundsOf(p.id)[0];
  assert.equal(post(t.rt, "updateEntry", { id: first.id, fields: { amount: 260 } }).ok, false);
  t.rt.api("updateEntry", { id: first.id, fields: { amount: 150 } });   // typed positive, stored minus
  assert.equal(Number(t.row(first.id).amount), -150);
  assert.equal(post(t.rt, "updateEntry", { id: first.id, fields: { type: "income" } }).ok, false);
});

test("shared purchase, back to my account: divided like the purchase; the friend's part is a debt to them that nets", () => {
  const t = setup();
  const p = t.purchase();
  t.rt.api("saveEntrySplits", { entryId: p.id, splits: [{ friend_id: t.friend.id, amount: 150 }] });
  assert.equal(t.owed(t.friend.id), 150);
  const out = t.rt.api("recordRefund", { entry_id: p.id, amount: 300, date: "2031-03-10", payment_method_id: t.pm });
  assert.deepEqual(out.parts, { me: 150, [t.friend.id]: 150 });
  assert.equal(Number(t.row(out.entry.id).amount), -150);
  assert.equal(t.owed(t.friend.id), 0);   // what she owed and what is now owed to her cancel
  const loan = t.rt.rows("Loans").find((l) => l.refund_of === p.id);
  assert.equal(loan.direction, "i_owe_them");
  assert.equal(t.row(loan.transfer_entry_id).refund_of, p.id);
  assert.equal(t.rt.api("listEntries", { startDate: "2031-03-01", endDate: "2031-03-31" }).find((e) => e.id === p.id).refunded, 300);
});

test("shared purchase, chosen parts: only the friend's item came back", () => {
  const t = setup();
  const p = t.purchase();
  t.rt.api("saveEntrySplits", { entryId: p.id, splits: [{ friend_id: t.friend.id, amount: 150 }] });
  const out = t.rt.api("recordRefund", { entry_id: p.id, amount: 120, date: "2031-03-10", payment_method_id: t.pm, parts: { me: 0, [t.friend.id]: 120 } });
  assert.equal(out.entry, null);
  assert.equal(t.owed(t.friend.id), 30);
  assert.equal(post(t.rt, "recordRefund", { entry_id: p.id, amount: 100, date: "2031-03-11", payment_method_id: t.pm, parts: { [t.friend.id]: 100 } }).ok, false);
});

test("a friend paid and got the money back on their card: my part, no account, and they owe it", () => {
  const t = setup();
  const p = t.purchase({ paid_by: t.friend.id, payment_method_id: "" });
  t.rt.api("saveEntrySplits", { entryId: p.id, splits: [{ friend_id: t.friend.id, amount: 150 }] });
  assert.equal(t.owed(t.friend.id), -150);
  const out = t.rt.api("recordRefund", { entry_id: p.id, amount: 300, date: "2031-03-12", back_to: t.friend.id });
  assert.equal(Number(t.row(out.entry.id).amount), -150);
  assert.equal(t.row(out.entry.id).payment_method_id, "");
  assert.equal(t.owed(t.friend.id), 0);
  assert.equal(post(t.rt, "recordRefund", { entry_id: t.purchase().id, amount: 10, date: "2031-03-12", back_to: t.friend.id }).ok, false);
});

test("on its way: nothing counts; Home lists it; Mark as received clears it; a Needs review item can be it", () => {
  const t = setup();
  const p = t.purchase();
  const before = t.rt.rows("Entries").length;
  t.rt.api("recordRefund", { entry_id: p.id, amount: 80, waiting: true, expected_by: "2031-03-30" });
  assert.equal(t.rt.rows("Entries").length, before);
  const groups = t.rt.api("listExpectedRecurringItems").groups.filter((g) => g.refund);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items[0].entry_id, p.id);
  assert.equal(groups[0].items[0].expected_date, "2031-03-30");
  // a bank e-mail of that money waits in Needs review: it is asked about, and "yes" records the refund
  t.rt.run(`appendRowObject('Entries', { id: 'pend-refund', type: 'income', date: '2031-03-25', amount: 80, currency: 'PEN', category_id: '', status: 'pending', payment_method_id: '${t.pm}', description: 'Store', source: 'email', paid_by: '' });`);
  const pend = { id: "pend-refund" };
  const card = t.rt.api("listPendingEntries").find((e) => e.id === pend.id);
  assert.equal(card.refund_match.entry_id, p.id);
  const done = t.rt.api("applyRefundMatch", { pending_id: pend.id, entry_id: p.id });
  assert.equal(done.kind, "offset");
  assert.ok(!t.row(pend.id));
  assert.equal(t.rt.api("listExpectedRecurringItems").groups.filter((g) => g.refund).length, 0);
});

test("It won't come: the note goes", () => {
  const t = setup();
  const p = t.purchase();
  t.rt.api("recordRefund", { entry_id: p.id, amount: 80, waiting: true });
  t.rt.api("cancelExpectedRefund", { entry_id: p.id });
  assert.equal(t.rt.api("listExpectedRecurringItems").groups.filter((g) => g.refund).length, 0);
});

test("deleting the purchase: its refund is kept as Refunds income, or deleted with it when asked", () => {
  const t = setup();
  const p = t.purchase();
  const r = t.rt.api("recordRefund", { entry_id: p.id, amount: 100, date: "2031-03-08", payment_method_id: t.pm }).entry;
  const links = t.rt.api("getEntryRepaymentLinks", { id: p.id });
  assert.deepEqual(links.purchaseRefunds, { amount: 100, currency: "PEN" });
  t.rt.api("discardEntry", { id: p.id });
  const kept = t.row(r.id);
  assert.equal(kept.type, "income");
  assert.equal(Number(kept.amount), 100);
  assert.equal(kept.refund_of, "");
  const p2 = t.purchase();
  const r2 = t.rt.api("recordRefund", { entry_id: p2.id, amount: 100, date: "2031-03-08", payment_method_id: t.pm }).entry;
  t.rt.api("discardEntry", { id: p2.id, refunds: "delete" });
  assert.ok(!t.row(r2.id));
});

// Part C: statements recognise refunds. Lines and amounts are made up.
const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
function stmtSetup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta refund", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const cat = rt.api("getMeta").categories.find((c) => c.type === "expense").id;
  const friend = rt.api("addFriend", { name: "Refund Stmt Friend" });
  const buy = (date, amount, description) => rt.api("createEntry", { type: "expense", date, amount, currency: "PEN", category_id: cat, status: "confirmed", paid_by: "me", payment_method_id: card.id, description });
  const stmt = (lines) => ({ key: "8765", kind: "visa", verified: true, period: { start: "2019-05-01", end: "2019-06-30" }, balances: {}, file_name: "r.pdf", lines });
  const plan = (statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
  const save = (statements, actions) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "r", statements, actions })})`);
  return { rt, card, cat, friend, buy, stmt, plan, save };
}

test("statement: a refund on its way becomes that refund, linked, by the month rule; Undo brings the note back", () => {
  const t = stmtSetup();
  const p = t.buy("2019-05-04", 90, "Zapatos");
  t.rt.api("recordRefund", { entry_id: p.id, amount: 90, waiting: true });
  const s = t.stmt([{ date: "2019-06-03", description: "ABONO TIENDA", amount: 90, currency: "PEN" }]);
  const pl = t.plan([s]);
  const a = pl.actions.find((x) => x.refundOf === p.id);
  assert.ok(a, "planned as the refund of that purchase");
  const res = t.save([s], pl.actions);
  const r = t.rt.rows("Entries").find((e) => e.refund_of === p.id);
  assert.equal(r.type, "income");
  assert.equal(Number(t.rt.rows("Entries").find((e) => e.id === p.id).refund_expected || 0), 0);
  run(t.rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(Number(t.rt.rows("Entries").find((e) => e.id === p.id).refund_expected), 90);
});

test("statement: one line for a shared refund saved in two pieces adds nothing", () => {
  const t = stmtSetup();
  const p = t.buy("2019-05-04", 200, "Cena");
  t.rt.api("saveEntrySplits", { entryId: p.id, splits: [{ friend_id: t.friend.id, amount: 100 }] });
  t.rt.api("recordRefund", { entry_id: p.id, amount: 200, date: "2019-05-09", payment_method_id: t.card.id });
  const s = t.stmt([{ date: "2019-05-10", description: "REV.RESTAURANTE", amount: 200, currency: "PEN" }]);
  const pl = t.plan([s]);
  assert.equal(pl.actions.filter((x) => x.type.indexOf("add_history") === 0).length, 0);
});

test("statement: a REV line for a charge already in the app is linked to it", () => {
  const t = stmtSetup();
  const p = t.buy("2019-05-04", 55, "LIBRERIA");
  const s = t.stmt([{ date: "2019-05-08", description: "REV.LIBRERIA", amount: 55, currency: "PEN" }]);
  const pl = t.plan([s]);
  t.save([s], pl.actions);
  const r = t.rt.rows("Entries").find((e) => e.refund_of === p.id);
  assert.ok(r, "linked");
  assert.equal(Number(r.amount), -55);
});
