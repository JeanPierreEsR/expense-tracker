// A spreadsheet can bring accounts the app does not have yet (owner, 2026-11-21): a statement keyed NEW-… carries `newAccount`, the plan
// and the dry run use a stand-in, the real save creates the account (or reuses one of that name, or shows a hidden one again) and Undo
// takes it away while nothing else uses it. Made-up lines only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const lines = [
  { date: "2019-03-05", description: "Bodega la Esquina", amount: -23.47, currency: "PEN", category: "Food" },
  { date: "2019-03-07", description: "Farmacia Sur", amount: -40.1, currency: "PEN", category: "Health" }
];
const stmt = (key, newAccount, ls) => ({ key, kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "wallets.csv",
  period: { start: "2019-03-05", end: "2019-03-07" }, lines: ls || lines, newAccount });
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, dryRun) => {
  const p = plan(rt, statements);
  return run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "wallets.csv", statements, actions: p.actions })})`);
};
const pms = (rt) => run(rt, "getAllRows('Payment Methods')");
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

test("the plan and the dry run create nothing; the save creates the account and puts the lines on it", () => {
  const { rt } = freshApp({ entries: 30 });
  const n0 = pms(rt).length;
  const s = [stmt("NEW-a-0", { name: "Mi Billetera Azul", type: "wallet", currencies: ["PEN"] })];
  const p = plan(rt, s);
  assert.deepEqual(p.summary.unknownAccounts, [], "a new account is not an unknown one");
  assert.deepEqual(p.summary.newAccounts, [], "and not proposed a second time as a PDF account");
  assert.equal(p.summary.counts.expenses, 2);
  save(rt, s, true);
  assert.equal(pms(rt).length, n0, "the dry run made nothing");
  const res = save(rt, s, false);
  const all = pms(rt);
  assert.equal(all.length, n0 + 1);
  const acct = all.find((a) => a.nickname === "Mi Billetera Azul");
  assert.equal(acct.type, "wallet");
  assert.deepEqual(res.accountsCreated, [{ id: acct.id, nickname: "Mi Billetera Azul", incomplete: false }]);
  const rows = made(rt);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => e.payment_method_id === acct.id));
});

test("a second upload of the same file reuses the account and adds nothing twice", () => {
  const { rt } = freshApp({ entries: 30 });
  save(rt, [stmt("NEW-a-0", { name: "Cuenta Naranja", type: "debit", last4: "4821" })], false);
  const acct = pms(rt).find((a) => a.nickname === "Cuenta Naranja");
  assert.equal(String(acct.last_4).padStart(4, "0"), "4821");
  // The phone now finds it by name and sends its real key (the last four digits); the lines are already there.
  const again = plan(rt, [stmt("4821")]);
  assert.equal(again.summary.counts.expenses, 0);
  // An older layout still saying "new" for that name: the name is taken, so the same account is used, never a second one.
  const n = pms(rt).length;
  save(rt, [stmt("NEW-b-0", { name: "Cuenta Naranja", type: "debit" })], false);
  assert.equal(pms(rt).length, n);
  assert.equal(made(rt).length, 2);
});

test("two names of one file make two accounts; Undo removes both and their entries", () => {
  const { rt } = freshApp({ entries: 30 });
  const n0 = pms(rt).length, e0 = run(rt, "getAllRows('Entries').length");
  const res = save(rt, [stmt("NEW-a-0", { name: "Tarjeta Verde", type: "credit" }), stmt("NEW-a-1", { name: "Ahorros Rojo", type: "debit" },
    [{ date: "2019-03-06", description: "Panadería", amount: -8.5, currency: "PEN", category: "Food" }])], false);
  assert.equal(pms(rt).length, n0 + 2);
  assert.equal(pms(rt).find((a) => a.nickname === "Tarjeta Verde").type, "credit");
  const u = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(u.accountsRemoved, 2);
  assert.equal(pms(rt).length, n0);
  assert.equal(run(rt, "getAllRows('Entries').length"), e0);
});

test("Undo keeps an account the person has used since", () => {
  const { rt } = freshApp({ entries: 30 });
  const res = save(rt, [stmt("NEW-a-0", { name: "Cuenta Lila", type: "debit" })], false);
  const acct = pms(rt).find((a) => a.nickname === "Cuenta Lila");
  rt.run(`appendRowObject('Entries', { id: 'e-mine', type: 'expense', date: '2019-04-01', amount: 5, currency: 'PEN', category_id: '', description: 'Mine', payment_method_id: '${acct.id}', status: 'confirmed', source: 'manual', paid_by: 'me', external_id: '' })`);
  const u = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(u.accountsKept, 1);
  assert.ok(pms(rt).some((a) => a.id === acct.id));
});

test("a hidden account of that name is shown again (not duplicated), and hidden again by Undo", () => {
  const { rt } = freshApp({ entries: 30 });
  rt.run("appendRowObject('Payment Methods', { id: 'pm-old', nickname: 'Cuenta Vieja', type: 'debit', bank_id: '', last_4: '', hidden: 'yes' })");
  const n0 = pms(rt).length;
  const res = save(rt, [stmt("NEW-a-0", { name: "Cuenta Vieja", type: "debit", unhideId: "pm-old" })], false);
  assert.equal(pms(rt).length, n0);
  assert.equal(pms(rt).find((a) => a.id === "pm-old").hidden, "");
  assert.ok(made(rt).every((e) => e.payment_method_id === "pm-old"));
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(pms(rt).find((a) => a.id === "pm-old").hidden, "yes");
});

test("digits another account already has are not given to the new one", () => {
  const { rt } = freshApp({ entries: 30 });
  rt.run("appendRowObject('Payment Methods', { id: 'pm-dig', nickname: 'Existing', type: 'debit', bank_id: '', last_4: '7777' })");
  save(rt, [stmt("NEW-a-0", { name: "Otra 7777", type: "debit", last4: "7777" })], false);
  const acct = pms(rt).find((a) => a.nickname === "Otra 7777");
  assert.equal(String(acct.last_4 || ""), "");
  assert.ok(made(rt).every((e) => e.payment_method_id === acct.id), "the lines went to the new account, not to the one with those digits");
});

test("a new account with no name is refused before anything is made", () => {
  const { rt } = freshApp({ entries: 30 });
  const n0 = pms(rt).length;
  assert.throws(() => save(rt, [stmt("NEW-a-0", { name: "  ", type: "debit" })], false));
  assert.equal(pms(rt).length, n0);
});

test("a line can move money to an account the same import creates", () => {
  const { rt } = freshApp({ entries: 30 });
  const yape = stmt("NEW-a-0", { name: "Billetera Prueba", type: "wallet" }, [{ date: "2019-03-05", description: "Ahorro mes", amount: -100, currency: "PEN", category: "Ahorro" }]);
  const savings = stmt("NEW-a-1", { name: "Ahorros Prueba", type: "debit" }, [{ date: "2019-03-06", description: "Bodega", amount: -5, currency: "PEN", category: "Food" }]);
  const statements = [yape, savings];
  const p = plan(rt, statements);
  const actions = p.actions.map((a) => (a.stmt === 0 && a.line === 0 && /add_history/.test(a.type) ? { type: "record_move", stmt: 0, line: 0, otherPmId: "new:NEW-a-1" } : a));
  assert.ok(actions.some((a) => a.type === "record_move"));
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: true, filename: "f", statements, actions })})`);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "f", statements, actions })})`);
  const all = pms(rt), w = all.find((a) => a.nickname === "Billetera Prueba"), s = all.find((a) => a.nickname === "Ahorros Prueba");
  const mv = run(rt, "getAllRows('Entries').filter(function (e) { return e.type === 'transfer' && String(e.external_id).indexOf('stmt-') === 0; })");
  assert.equal(mv.length, 1);
  assert.equal(mv[0].payment_method_id, w.id);
  assert.equal(mv[0].to_payment_method_id, s.id);
});

test("Yape in the file: a new BCP account named Yape carries Yape, and Undo takes the link and the account away", () => {
  const { rt } = freshApp({ entries: 30 });
  rt.run("setSetting_('yape_pen', ''); setSetting_('yape_usd', ''); deleteRowsWhere_('Payment Methods', function (p) { return /yape/i.test(p.nickname); })");
  const s = [stmt("NEW-a-0", { name: "Yape", type: "debit", bankName: "BCP", last4: "1357", rail: "yape" })];
  const res = save(rt, s, false);
  const acct = pms(rt).find((a) => a.nickname === "Yape");
  assert.equal(acct.type, "debit");
  assert.equal(String(acct.last_4).padStart(4, "0"), "1357");
  assert.equal(run(rt, "getSettingsMap().yape_pen"), acct.id);
  assert.deepEqual(res.accountsCreated.map((a) => a.incomplete), [false]);
  const u = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(u.railsUnlinked, 1);
  assert.equal(run(rt, "getSettingsMap().yape_pen"), "");
  assert.ok(!pms(rt).some((a) => a.id === acct.id));
});

test("Yape on an existing BCP account: linked with no new account; a card is never linked", () => {
  const { rt } = freshApp({ entries: 30 });
  rt.run("setSetting_('yape_pen', ''); var b = addBank({ name: 'BCP' }); appendRowObject('Payment Methods', { id: 'pm-bcp', nickname: 'Mi BCP', type: 'debit', bank_id: b.id, last_4: '' }); appendRowObject('Payment Methods', { id: 'pm-card', nickname: 'Tarjeta X', type: 'credit', bank_id: b.id, last_4: '' });");
  const n0 = pms(rt).length;
  save(rt, [Object.assign(stmt("ACCT-pm-bcp"), { rail: "yape" })], false);
  assert.equal(pms(rt).length, n0);
  assert.equal(run(rt, "getSettingsMap().yape_pen"), "pm-bcp");
  rt.run("setSetting_('yape_pen', '')");
  const r2 = save(rt, [Object.assign(stmt("ACCT-pm-card", undefined, [{ date: "2019-04-05", description: "Otra", amount: -3, currency: "PEN", category: "Food" }]), { rail: "yape" })], false);
  assert.equal(run(rt, "getSettingsMap().yape_pen"), "");
  assert.deepEqual(r2.railSkipped, ["yape"]);
});

test("a new account with no bank or digits is marked incomplete", () => {
  const { rt } = freshApp({ entries: 30 });
  const res = save(rt, [stmt("NEW-a-0", { name: "Cuenta Gris", type: "debit" })], false);
  assert.deepEqual(res.accountsCreated.map((a) => a.incomplete), [true]);
});

test("a move whose lines have no account takes the side the person named (an account the import creates, too)", () => {
  const { rt } = freshApp({ entries: 30 });
  const noAcct = { key: "NOACCOUNT", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "f.csv",
    period: { start: "2019-03-05", end: "2019-03-05" }, lines: [{ date: "2019-03-05", description: "Ahorro", amount: -70, currency: "PEN", category: "Ahorro" }] };
  const savings = stmt("NEW-a-1", { name: "Ahorros Nuevos", type: "debit" }, [{ date: "2019-03-06", description: "Bodega", amount: -5, currency: "PEN", category: "Food" }]);
  const cash = run(rt, "getAllRows('Payment Methods').find(function (p) { return p.type === 'cash'; }).id");
  const statements = [noAcct, savings];
  const p = plan(rt, statements);
  const actions = p.actions.map((a) => (a.stmt === 0 && a.line === 0 && /add_history/.test(a.type) ? { type: "record_move", stmt: 0, line: 0, otherPmId: "new:NEW-a-1", herePmId: cash } : a));
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: true, filename: "f", statements, actions })})`);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "f", statements, actions })})`);
  const s = pms(rt).find((a) => a.nickname === "Ahorros Nuevos");
  const mv = run(rt, "getAllRows('Entries').filter(function (e) { return e.type === 'transfer' && String(e.external_id).indexOf('stmt-') === 0; })");
  assert.equal(mv.length, 1);
  assert.equal(mv[0].payment_method_id, cash);
  assert.equal(mv[0].to_payment_method_id, s.id);
});

test("an app's export on a credit card is never asked for a pay-by date", () => {
  const { rt } = freshApp({ entries: 30 });
  const p = plan(rt, [stmt("NEW-a-0", { name: "Tarjeta Azul", type: "credit" })]);
  assert.deepEqual(p.due_asks, []);
});
