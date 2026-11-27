// "Saved the wrong way round?" (owner's plan, 2026-11-26): a statement line that IS an entry in the app with the money going the other way
// (an income that is an expense, an expense that is an income, a transfer between the person's own accounts with From and To swapped).
// Clear pairs are turned around by default; an entry shared with a friend or part of a repayment is only shown. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const bank = rt.api("savePaymentMethod", { nickname: "Ahorros Prueba", type: "debit", currencies: ["PEN"], last_4: "4321" });
  const other = rt.api("savePaymentMethod", { nickname: "Otra Prueba", type: "debit", currencies: ["PEN"], last_4: "6543" });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta Prueba", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const add = (fields, opts) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ currency: "PEN", paid_by: "me", payment_method_id: bank.id }, fields),
    splits: opts && opts.splits }).id;
  const stmt = (key, lines, kind) => ({ key, kind: kind || "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "s.pdf", lines });
  return { rt, bank, other, card, add, stmt };
}
const plan = (rt, statements, flips) => run(rt, `planStatementHistory(${JSON.stringify({ statements, flips: flips !== false })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "s", statements, actions })})`);
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("an income saved for money that left: turned into an expense by default; Undo puts it back", () => {
  const { rt, add, stmt } = setup();
  const id = add({ type: "income", date: "2019-03-10", amount: 50, description: "Seguro Pacifico", paid_by: "" });
  const s = stmt("4321", [{ date: "2019-03-10", description: "PACIFICO SEGUROS", amount: -50, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.flips.length, 1);
  assert.ok(p.summary.flips[0].clear);
  assert.equal(p.summary.flips[0].options[0].kind, "type");
  assert.deepEqual(p.actions.map((a) => a.type), ["fix_entry_type"], "never added as a second entry");
  const res = save(rt, [s], p.actions, false);
  assert.equal(res.flips, 1);
  const e = row(rt, id);
  assert.equal(e.type, "expense");
  assert.equal(e.paid_by, "me");
  assert.equal(String(e.category_id || ""), "", "an income category never stays on an expense");
  assert.equal(plan(rt, [s]).summary.flips.length, 0, "read again: the line is already handled");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(row(rt, id).type, "income");
});

test("an expense saved for money that came in becomes an income; without the phone asking, nothing is paired", () => {
  const { rt, add, stmt } = setup();
  const id = add({ type: "expense", date: "2019-03-12", amount: 80, description: "Reembolso Rimac" });
  const s = stmt("4321", [{ date: "2019-03-12", description: "ABONO RIMAC", amount: 80, currency: "PEN" }]);
  assert.equal((plan(rt, [s], false).summary.flips || []).length, 0, "an older phone: no flips, no change it would not show");
  const p = plan(rt, [s]);
  assert.equal(p.summary.flips.length, 1);
  save(rt, [s], p.actions, false);
  assert.equal(row(rt, id).type, "income");
});

test("an exact match always wins; on a card, money back next to an expense is a refund, never a flip", () => {
  const { rt, add, card, stmt } = setup();
  add({ type: "expense", date: "2019-03-05", amount: 30, description: "Tambo" });
  add({ type: "income", date: "2019-03-05", amount: 30, description: "Tambo", paid_by: "" });
  const s = stmt("4321", [{ date: "2019-03-05", description: "TAMBO", amount: -30, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.flips.length, 0);
  assert.deepEqual(p.actions.map((a) => a.type), ["link"]);
  add({ type: "expense", date: "2019-03-07", amount: 45, description: "Saga", payment_method_id: card.id });
  const c = stmt("8765", [{ date: "2019-03-07", description: "SAGA FALABELLA", amount: 45, currency: "PEN" }], "visa");
  assert.equal(plan(rt, [c]).summary.flips.length, 0);
});

test("two possible entries, or no shop word in common: shown, never ticked", () => {
  const { rt, add, stmt } = setup();
  add({ type: "income", date: "2019-03-15", amount: 20, description: "Ana", paid_by: "" });
  add({ type: "income", date: "2019-03-16", amount: 20, description: "Luis", paid_by: "" });
  const s = stmt("4321", [{ date: "2019-03-15", description: "COMPRA WONG", amount: -20, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.flips.length, 1);
  assert.equal(p.summary.flips[0].clear, false);
  assert.equal(p.summary.flips[0].options.length, 2);
  assert.ok(!p.actions.some((a) => a.type === "fix_entry_type"));
});

test("a shared expense is only shown (fix it by hand), and the save refuses to turn it around", () => {
  const { rt, add, stmt } = setup();
  const friend = rt.api("addFriend", { name: "Ana Lo " + Math.random().toString(36).slice(2, 6) });
  const id = add({ type: "expense", date: "2019-03-20", amount: 60, description: "Cena Central" }, { splits: [{ friend_id: friend.id, amount: 30 }] });
  const s = stmt("4321", [{ date: "2019-03-20", description: "CENTRAL RESTAURANTE", amount: 60, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.flips.length, 1);
  assert.equal(p.summary.flips[0].options[0].locked, "shared");
  assert.equal(p.summary.flips[0].clear, false);
  assert.throws(() => save(rt, [s], [{ type: "fix_entry_type", stmt: 0, line: 0, entryId: id }], true), /wrong way round/);
});

test("a transfer saved the wrong way: From and To are swapped once, even when both statements are read together", () => {
  const { rt, bank, other, add, stmt } = setup();
  const id = "flip-tr-1";
  rt.run(`ensureEntriesToPaymentMethodColumn_(); appendRowObject('Entries', ${JSON.stringify({ id, type: "transfer", date: "2019-03-22", amount: 500, currency: "PEN",
    payment_method_id: bank.id, to_payment_method_id: other.id, status: "confirmed", source: "manual", description: "Transferencia a ahorros" })})`);
  const a = stmt("4321", [{ date: "2019-03-22", description: "TRANSF RECIBIDA", amount: 500, currency: "PEN" }]);
  const b = stmt("6543", [{ date: "2019-03-22", description: "TRANSF ENVIADA", amount: -500, currency: "PEN" }]);
  const p = plan(rt, [a, b]);
  assert.equal(p.summary.flips.length, 2);
  assert.ok(p.summary.flips.every((f) => f.clear && f.options[0].kind === "swap"));
  const res = save(rt, [a, b], p.actions, false);
  assert.equal(res.flips, 1);
  const e = row(rt, id);
  assert.equal(e.payment_method_id, other.id);
  assert.equal(e.to_payment_method_id, bank.id);
});

test("the balance check counts a clear flip as explained: twice the line", () => {
  const { rt, bank, add, stmt } = setup();
  rt.run(`addOpeningRow_(${JSON.stringify(bank.id)}, 'PEN', 1000, '2019-02-28', '2019-02-28T23:59:59')`);
  add({ type: "income", date: "2019-03-10", amount: 50, description: "Seguro Pacifico", paid_by: "" });
  const s = stmt("4321", [{ date: "2019-03-10", description: "PACIFICO SEGUROS", amount: -50, currency: "PEN" }]);
  s.balances = { PEN: { closing: 950 } };
  const p = plan(rt, [s]);
  const chk = p.balance_checks.find((c) => c.currency === "PEN");
  assert.equal(chk.diff, -100);
  assert.deepEqual(chk.flipped, { net: -100, lines: 1 });
  assert.equal(chk.unexplained, 0);
});
