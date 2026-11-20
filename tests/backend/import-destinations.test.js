// Import from another app (owner, 2026-11-20): a file's category that is not spending or income goes where it belongs in the app —
// Loans with a friend (record_loan_line), a move between the person's own accounts (record_move) — and the import's one Undo removes it
// all. Also: the category merge's money families and two-part names. Made-up lines only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ entries: 30 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-wallet', nickname: 'Wallet Prueba', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-save', nickname: 'Ahorro Prueba', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  rt.run(`appendRowObject('Friends', { id: 'fr-ana', name: 'Ana Prueba', notes: '', trip_id: '' });`);
  const lines = [
    { date: "2026-01-05", description: "prestamo ana", amount: 500, currency: "PEN", category: "Préstamos" },
    { date: "2026-01-06", description: "almuerzo", amount: -30, currency: "PEN", category: "Comidas" },
    { date: "2026-02-10", description: "pago deuda ana", amount: -200, currency: "PEN", category: "Pago préstamos" },
    { date: "2026-02-11", description: "ahorro del mes", amount: -150, currency: "PEN", category: "Ahorro General" }
  ];
  const stmt = { key: "ACCT-pm-wallet", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "mis-gastos.xlsx",
    period: { start: "2026-01-05", end: "2026-02-11" }, lines };
  return { rt, stmt };
}
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "mis-gastos.xlsx", statements, actions })})`);
const counts = (rt) => run(rt, "({ entries: getAllRows('Entries').length, loans: getAllRows('Loans').length, settlements: getAllRows('Settlements').length })");
const actionsFor = () => [
  { type: "record_loan_line", stmt: 0, line: 0, friendId: "fr-ana", kind: "loan" },
  { type: "add_history_expense", stmt: 0, line: 1 },
  { type: "record_loan_line", stmt: 0, line: 2, friendId: "fr-ana", kind: "repayment" },
  { type: "record_move", stmt: 0, line: 3, otherPmId: "pm-save" }
];

test("a loan received, its repayment and a move to savings are saved as such, never as income or spending", () => {
  const { rt, stmt } = setup();
  const before = counts(rt);
  const dry = save(rt, [stmt], actionsFor(), true);
  assert.equal(dry.created.loans, 1);
  assert.equal(dry.created.repayments, 1);
  assert.deepEqual(counts(rt), before, "the dry run writes nothing");
  const res = save(rt, [stmt], actionsFor(), false);
  assert.deepEqual(res.loanFailures, []);
  const loans = run(rt, "getAllRows('Loans').filter(function (l) { return l.friend_id === 'fr-ana'; })");
  assert.equal(loans.length, 1);
  assert.equal(loans[0].direction, "i_owe_them", "money that came in under Préstamos is a loan received");
  assert.equal(Number(loans[0].amount), 500);
  const settled = run(rt, `getAllRows('Settlements').filter(function (s) { return s.loan_id === ${JSON.stringify(loans[0].id)}; })`);
  assert.equal(settled.length, 1);
  assert.equal(Number(settled[0].amount), 200, "the repayment pays down that loan");
  const move = run(rt, "getAllRows('Entries').filter(function (e) { return e.external_id === 'stmt-' + e.external_id.substring(5) && e.type === 'transfer' && e.to_payment_method_id === 'pm-save'; })");
  assert.equal(move.length, 1);
  assert.equal(move[0].payment_method_id, "pm-wallet");
  assert.equal(Number(move[0].amount), 150);
  const batch = run(rt, `getAllRows('Entries').filter(function (e) { return e.import_batch_id === ${JSON.stringify(res.batchId)}; }).map(function (e) { return e.type; }).sort()`);
  assert.ok(!batch.includes("income"), "the loan is not income");
  assert.equal(batch.filter((t) => t === "expense").length, 1, "only the lunch is spending");
});

test("Undo removes the loans, the repayments and their money entries with the rest of the import", () => {
  const { rt, stmt } = setup();
  const before = counts(rt);
  const res = save(rt, [stmt], actionsFor(), false);
  const undo = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(undo.loansRemoved, 1);
  assert.equal(undo.repaymentsRemoved, 1);
  assert.deepEqual(counts(rt), before);
});

test("a repayment of an OLDER loan is undone and that loan is owed again", () => {
  const { rt, stmt } = setup();
  rt.run(`addLoan({ friend_id: 'fr-ana', direction: 'i_owe_them', amount: 200, currency: 'PEN', date: '2025-12-01', payment_method_id: '' })`);
  const old = run(rt, "getAllRows('Loans').filter(function (l) { return l.friend_id === 'fr-ana'; })[0]");
  const res = save(rt, [stmt], [{ type: "record_loan_line", stmt: 0, line: 2, friendId: "fr-ana", kind: "repayment" }], false);
  assert.equal(run(rt, `getAllRows('Settlements').filter(function (s) { return s.loan_id === ${JSON.stringify(old.id)}; }).length`), 1);
  assert.notEqual(run(rt, `getAllRows('Loans').filter(function (l) { return l.id === ${JSON.stringify(old.id)}; })[0].status`), "outstanding", "paid in full by the import");
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(run(rt, `getAllRows('Settlements').filter(function (s) { return s.loan_id === ${JSON.stringify(old.id)}; }).length`), 0);
  assert.equal(run(rt, `getAllRows('Loans').filter(function (l) { return l.id === ${JSON.stringify(old.id)}; })[0].status`), "outstanding");
});

test("a move needs another of the person's accounts; an unknown friend is refused before anything is written", () => {
  const { rt, stmt } = setup();
  const before = counts(rt);
  assert.throws(() => save(rt, [stmt], [{ type: "record_move", stmt: 0, line: 3, otherPmId: "pm-wallet" }], true), /OTHER account|OTRA cuenta/);
  assert.throws(() => save(rt, [stmt], [{ type: "record_move", stmt: 0, line: 3, otherPmId: "nope" }], true));
  assert.throws(() => save(rt, [stmt], [{ type: "record_loan_line", stmt: 0, line: 0, friendId: "nobody", kind: "loan" }], true));
  assert.deepEqual(counts(rt), before);
});

test("the category merge names the money families and reads two-part names", () => {
  const { rt } = setup();
  const res = run(rt, `suggestCategoryMap({ names: [
    { type: 'income', name: 'Préstamos', count: 2 }, { type: 'expense', name: 'Pago préstamos', count: 2 },
    { type: 'expense', name: 'Ahorro General', count: 1 }, { type: 'income', name: 'Inversiones', count: 1 },
    { type: 'expense', name: 'Efectivo recibo', count: 3 }, { type: 'income', name: 'Cashback', count: 4 },
    { type: 'expense', name: 'Transporte/Taxi', count: 5 }, { type: 'expense', name: 'Antojos', count: 5 } ] })`);
  const by = Object.fromEntries(res.items.map((it) => [it.name, it]));
  assert.equal(by["Préstamos"].family, "loan");
  assert.equal(by["Pago préstamos"].family, "repay");
  assert.equal(by["Ahorro General"].family, "saving");
  assert.equal(by["Inversiones"].family, "invest");
  assert.equal(by["Efectivo recibo"].family, "cash");
  assert.equal(by["Cashback"].family, undefined, "cashback is not cash");
  assert.equal(by["Transporte/Taxi"].action, "match", "both parts mean Transport");
  assert.equal(by["Antojos"].family, undefined);
  assert.equal(by["Antojos"].action, "create");
});
