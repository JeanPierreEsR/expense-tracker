// Import data works with NO account: a person trying the app before setting any account or card up (or who just does not want to
// pick one) can bring another app's export; the entries are saved with an empty account. Made-up lines only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const lines = [
  { date: "2019-03-05", description: "Bodega la Esquina", amount: -23.47, currency: "PEN", category: "Food" },
  { date: "2019-03-06", description: "Sueldo", amount: 3000.13, currency: "PEN", category: "Salary" },
  { date: "2019-03-07", description: "Farmacia Sur", amount: -40.1, currency: "PEN", category: "Health" }
];
const stmt = () => ({ key: "NOACCOUNT", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "export.csv",
  period: { start: "2019-03-05", end: "2019-03-07" }, lines });
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "export.csv", statements, actions })})`);
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

test("an import with no account is planned (not set aside) and saved with an empty account", () => {
  const { rt } = freshApp({ entries: 40 });
  const p = plan(rt, [stmt()]);
  assert.deepEqual(p.summary.unknownAccounts, [], "no account is not an 'unknown account'");
  assert.equal(p.summary.counts.expenses, 2);
  assert.equal(p.summary.counts.income, 1);
  save(rt, [stmt()], p.actions);
  const rows = made(rt);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((e) => e.payment_method_id === "" && e.to_payment_method_id === "" && e.status === "confirmed" && e.source === "import"));
});

test("it works when the person has no accounts at all", () => {
  const { rt } = freshApp({ entries: 0 });
  rt.run("deleteRowsWhere_('Payment Methods', function () { return true; })");
  const p = plan(rt, [stmt()]);
  save(rt, [stmt()], p.actions);
  assert.equal(made(rt).length, 3);
});

test("the same file twice adds nothing twice, and Undo removes it", () => {
  const { rt } = freshApp({ entries: 40 });
  const before = run(rt, "getAllRows('Entries').length");
  const res = save(rt, [stmt()], plan(rt, [stmt()]).actions);
  assert.equal(plan(rt, [stmt()]).summary.counts.expenses, 0);
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(run(rt, "getAllRows('Entries').length"), before);
});

test("an import with no account is not listed as an account to keep up to date", () => {
  const { rt } = freshApp({ entries: 40 });
  save(rt, [stmt()], plan(rt, [stmt()]).actions);
  const cov = run(rt, "listStatementCoverage()");
  assert.ok(!cov.accounts.some((a) => /NOACCOUNT/.test(a.key)), "no 'No account' row to chase");
});

test("a line that matches an entry with no account assigns nothing (and does not blank anything)", () => {
  const { rt } = freshApp({ entries: 0 });
  rt.run(`appendRowObject('Entries', { id: 'e-free', type: 'expense', date: '2019-03-05', amount: 23.47, currency: 'PEN', category_id: '', description: 'Bodega la Esquina', payment_method_id: '', status: 'confirmed', source: 'manual', paid_by: 'me', external_id: '' })`);
  const p = plan(rt, [stmt()]);
  save(rt, [stmt()], p.actions);
  const e = run(rt, "getAllRows('Entries').find(function (r) { return r.id === 'e-free'; })");
  assert.equal(e.payment_method_id, "");
  assert.equal(made(rt).filter((x) => /bodega/i.test(x.description)).length, 0, "the existing entry was recognised, not duplicated");
});
