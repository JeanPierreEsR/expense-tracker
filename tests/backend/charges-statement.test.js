// A card statement fills in the charges left pending (owner, 2026-11-07): the line in USD and the purchase recorded in ARS on the same
// card, 5 days apart at most. Clear pairs are filled in by default; Undo puts them back to pending. Lines and amounts are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta en dólares", type: "credit", currencies: ["USD"], last_4: "4321" });
  for (const m of ["2019-03", "2019-04"]) {
    rt.api("setExchangeRate", { currency: "USD", month: m, rate: 3.75 });
    rt.api("setExchangeRate", { currency: "ARS", month: m, rate: 0.0026 });   // 1 USD ≈ 1,442 ARS
  }
  const friend = rt.api("addFriend", { name: "Ana Lo" });
  const add = (date, amount, description, splits) => rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date, amount, currency: "ARS", description,
    paid_by: "me", payment_method_id: card.id, charge_pending: "1" }, splits }).id;
  const hotel = add("2019-03-10", 30000, "Hotel", [{ friend_id: friend.id, amount: 10000 }]);
  const cena = add("2019-03-12", 12500, "Cena");
  const stmt = (lines) => ({ key: "4321", kind: "visa", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "c.pdf", lines });
  return { rt, card, friend, hotel, cena, stmt };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "c", statements, actions })})`);
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("clear pairs are filled in by default; nothing is added twice", () => {
  const { rt, hotel, cena, stmt } = setup();
  const s = stmt([
    { date: "2019-03-13", description: "HOTEL ALVEAR BS AS", amount: -21.37, currency: "USD" },
    { date: "2019-03-14", description: "LA CABRERA", amount: -8.75, currency: "USD" },
    { date: "2019-03-20", description: "AMAZON", amount: -12.99, currency: "USD" }
  ]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.charges.length, 2);
  const fills = p.actions.filter((a) => a.type === "fill_charge").map((a) => a.entryId).sort();
  assert.deepEqual(fills, [hotel, cena].sort());
  assert.equal(p.actions.filter((a) => a.type === "add_history_expense").length, 1, "only Amazon is a purchase not in the app");
  assert.ok(p.summary.charges.every((c) => c.clear));
  save(rt, [s], p.actions, true);
  const res = save(rt, [s], p.actions, false);
  assert.equal(res.chargesFilled, 2);
  assert.equal(row(rt, hotel).currency, "USD");
  assert.equal(Number(row(rt, hotel).amount), 21.37);
  assert.equal(Number(row(rt, hotel).paid_amount), 30000);
  assert.ok(!row(rt, cena).charge_pending);
  const loan = rt.rows("Loans").find((l) => l.entry_id === hotel);
  assert.equal(loan.currency, "ARS");
  assert.equal(Number(loan.amount), 10000);
  // the same statement read again: the lines are already handled
  const again = plan(rt, [s]);
  assert.equal(again.actions.filter((a) => a.type === "fill_charge").length, 0);

  // Undo: both are pending again, in ARS, and the friend's split is back in ARS
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(row(rt, hotel).charge_pending, "1");
  assert.equal(row(rt, hotel).currency, "ARS");
  assert.equal(Number(row(rt, hotel).amount), 30000);
  const split = rt.rows("Entry Splits").find((x) => x.entry_id === hotel);
  assert.equal(Number(split.amount), 10000);
  assert.equal(Number(rt.rows("Loans").find((l) => l.entry_id === hotel).amount), 10000);
  assert.equal(rt.api("listPendingCharges", {}).length, 2);
});

test("more than 5 days apart, another card, or the same currency: no pair", () => {
  const { rt, stmt } = setup();
  const p = plan(rt, [stmt([{ date: "2019-03-16", description: "HOTEL", amount: -21.37, currency: "USD" }])]);   // 6 days after the hotel, 4 after the cena
  assert.equal(p.summary.charges.length, 1);
  assert.equal(p.summary.charges[0].options.length, 1, "only the Cena is within 5 days");
  const none = plan(rt, [stmt([{ date: "2019-03-12", description: "X", amount: -10, currency: "ARS" }])]);
  assert.equal(none.summary.charges.length, 0);
});

test("unclear: two purchases that both fit one line, or a rate far from the table, are not filled in by themselves", () => {
  const { rt, stmt } = setup();
  rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date: "2019-03-11", amount: 30500, currency: "ARS", description: "Hotel 2", paid_by: "me",
    payment_method_id: rt.rows("Payment Methods").find((p) => p.nickname === "Tarjeta en dólares").id, charge_pending: "1" } });
  const p = plan(rt, [stmt([{ date: "2019-03-11", description: "COMPRA", amount: -21.37, currency: "USD" }])]);   // both hotels fit that rate
  assert.equal(p.summary.charges.length, 1);
  assert.equal(p.summary.charges[0].clear, false);
  assert.equal(p.summary.charges[0].options.length, 3, "hotel, hotel 2 and the cena are all within 5 days");
  assert.equal(p.actions.filter((a) => a.type === "fill_charge" || (a.stmt === 0 && a.line === 0)).length, 0, "no action until the person picks");
  const far = plan(rt, [stmt([{ date: "2019-03-15", description: "LA CABRERA", amount: -80, currency: "USD" }])]);   // 12,500 ARS for USD 80: far off
  assert.equal(far.summary.charges[0].clear, false);
});

test("two lines given to the same purchase are refused", () => {
  const { rt, cena, stmt } = setup();
  const s = stmt([{ date: "2019-03-13", description: "A", amount: -8.75, currency: "USD" }, { date: "2019-03-14", description: "B", amount: -8.8, currency: "USD" }]);
  assert.throws(() => save(rt, [s], [{ type: "fill_charge", stmt: 0, line: 0, entryId: cena }, { type: "fill_charge", stmt: 0, line: 1, entryId: cena }], true));
});

test("a bank e-mail in USD in Needs review offers the pending purchase it is the charge of", () => {
  const { rt, card, hotel } = setup();
  const pending = rt.run(`(function () { var e = { id: 'mail-1', type: 'expense', date: '2019-03-11', amount: 21.37, currency: 'USD', category_id: '', description: 'HOTEL ALVEAR',
    payment_method_id: ${JSON.stringify(card.id)}, paid_by: 'me', status: 'pending', source: 'email', external_id: 'msg-1', import_batch_id: '', created_at: '' }; appendRowObject('Entries', e); return e.id; })()`);
  const item = rt.api("listPendingEntries", {}).find((e) => e.id === pending);
  assert.equal(item.charge_match.entryId, hotel);
  rt.api("fillChargeFromReview", { pendingId: pending, entryId: hotel });
  assert.equal(row(rt, hotel).currency, "USD");
  assert.equal(Number(row(rt, hotel).amount), 21.37);
  assert.ok(!row(rt, pending), "the e-mail's own entry is gone, so nothing counts twice");
});
