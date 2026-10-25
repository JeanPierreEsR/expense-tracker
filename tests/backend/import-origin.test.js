// Import data and Statements keep their uploads apart (2026-10-25): an app's export is recorded as an import, never as a bank statement.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ entries: 40 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-x', nickname: 'Other Bank Savings', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  const stmt = (source, file) => ({ key: "ACCT-pm-x", kind: "csv", holder: "", verified: false, balances: {}, file_name: file, source,
    period: { start: "2019-03-05", end: "2019-03-07" },
    lines: [{ date: "2019-03-05", description: "lunch", amount: -23.47, currency: "PEN", category: source === "app" ? "Food" : "" },
      { date: "2019-03-07", description: "pay", amount: 100, currency: "PEN" }] });
  const save = (statements) => {
    const plan = run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
    return run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "f", statements, actions: plan.actions })})`);
  };
  const uploads = () => run(rt, "getAllRows('Statement Uploads')");
  return { rt, stmt, save, uploads };
}
const batches = (rt, kind) => rt.api("listStatementBatches", { limit: 20, kind });

test("an app's export is recorded as an import: Statements' list, coverage and inbox never see it", () => {
  const { rt, stmt, save, uploads } = setup();
  save([stmt("app", "export.csv")]);
  assert.deepEqual(uploads().map((u) => u.source), ["import"]);
  assert.equal(batches(rt, "statement").length, 0, "not in Recent uploads under Statements");
  const imp = batches(rt, "import");
  assert.equal(imp.length, 1);
  assert.equal(imp[0].spreadsheet, true);
  assert.ok(!rt.api("listStatementCoverage", {}).accounts.some((a) => a.key === "ACCT-pm-x"), "an import is not an account to keep up to date");
});

test("a bank file is recorded as a statement and the list defaults to statements", () => {
  const { rt, stmt, save, uploads } = setup();
  save([stmt("", "bank.csv")]);
  assert.deepEqual(uploads().map((u) => u.source), ["upload"]);
  assert.equal(batches(rt, undefined).length, 1);
  assert.equal(batches(rt, "import").length, 0);
  assert.ok(rt.api("listStatementCoverage", {}).accounts.some((a) => a.key === "ACCT-pm-x"));
});

test("the same account and last day in both lists never overwrite each other", () => {
  const { stmt, save, uploads } = setup();
  save([stmt("app", "export.csv")]);
  save([stmt("", "bank.csv")]);
  assert.deepEqual(uploads().map((u) => u.source).sort(), ["import", "upload"]);
});

test("a spreadsheet upload can be moved to the other list and back; the entries it made stay", () => {
  const { rt, stmt, save, uploads } = setup();
  save([stmt("", "bank.csv")]);
  const id = batches(rt, "statement")[0].batchId;
  const before = run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; }).length");
  assert.equal(rt.api("setBatchOrigin", { batchId: id, origin: "import" }).moved, 1);
  assert.equal(batches(rt, "statement").length, 0);
  assert.equal(batches(rt, "import").length, 1);
  assert.equal(run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; }).length"), before);
  assert.equal(rt.api("setBatchOrigin", { batchId: id, origin: "statement" }).moved, 1);
  assert.deepEqual(uploads().map((u) => u.source), ["upload"]);
  assert.equal(rt.api("setBatchOrigin", { batchId: id, origin: "statement" }).moved, 0, "already there: nothing to do");
});

test("a PDF statement cannot be moved into Import data", () => {
  const { rt } = setup();
  rt.run("ensureStatementUploadsSheet_();");
  rt.run(`appendRowObject('Statement Uploads', { id: 'u1', account_key: '1234', account_label: 'Card', kind: 'credit', period_start: '2019-03-01', period_end: '2019-03-31', closing_json: '{}', file_name: 'a.pdf', processed_at: '2019-04-01', batch_id: 'b-pdf', lines_total: 3, verified: 'true', source: 'upload' });`);
  assert.throws(() => rt.api("setBatchOrigin", { batchId: "b-pdf", origin: "import" }), /spreadsheet/i);
  assert.equal(batches(rt, "statement")[0].spreadsheet, false, "so the list offers no move for it");
});

test("Undo works on an import from its own list", () => {
  const { rt, stmt, save } = setup();
  save([stmt("app", "export.csv")]);
  const b = batches(rt, "import")[0];
  rt.api("undoStatementBatch", { batchId: b.batchId });
  assert.equal(batches(rt, "import").length, 0);
});
