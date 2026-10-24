// A spreadsheet statement (docs/statement-table.js) goes through the SAME backend as a PDF: the person names the account,
// so an account with no last four digits works too (key ACCT-<id>). Made-up lines only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");
const ST = require("../../docs/statement-table.js");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt, data } = freshApp({ entries: 40 });
  // An account at a bank the PDF readers don't know, with no digits saved.
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-csv', nickname: 'Other Bank Savings', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  const csv = "Fecha,Descripción,Cargo,Abono\n05/03/2019,COMPRA BODEGA LA ESQUINA,23.47,\n06/03/2019,ABONO SUELDO,,3000.13\n07/03/2019,COMPRA FARMACIA SUR,40.10,\n";
  const rows = ST.parseCsv(csv);
  const m = ST.guessMapping(rows);
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  const stmt = (lines, end) => ({ key: "ACCT-pm-csv", kind: "csv", holder: "", verified: false, balances: {}, file_name: "export.csv",
    period: { start: r.period.start, end: end || r.period.end }, lines });
  return { rt, data, stmt, lines: r.lines };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "export.csv", statements, actions })})`);
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

test("a CSV for an account with no digits is planned and saved on that account", () => {
  const { rt, stmt, lines } = setup();
  const s = [stmt(lines)];
  const p = plan(rt, s);
  assert.deepEqual(p.summary.unknownAccounts, [], "the account is found by its id");
  assert.equal(p.summary.counts.expenses, 2);
  assert.equal(p.summary.counts.income, 1);
  save(rt, s, p.actions, false);
  const rows = made(rt);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((e) => e.payment_method_id === "pm-csv" && e.status === "confirmed" && e.category_id === "" && e.source === "import"));
  const bodega = rows.find((e) => /bodega/i.test(e.description));
  assert.equal(bodega.merchant, "compra bodega la esquina");
  assert.equal(Number(bodega.amount), 23.47);
});

test("uploading the same file again, or an overlapping export, adds nothing twice", () => {
  const { rt, stmt, lines } = setup();
  save(rt, [stmt(lines)], plan(rt, [stmt(lines)]).actions, false);
  const again = plan(rt, [stmt(lines)]);
  assert.equal(again.summary.counts.expenses, 0);
  assert.equal(made(rt).length, 3);
  // A later export that repeats the last two lines and adds one.
  const later = lines.slice(1).concat([{ date: "2019-03-09", description: "COMPRA PANADERIA", amount: -8.5, currency: "PEN" }]);
  const p = plan(rt, [stmt(later, "2019-03-09")]);
  save(rt, [stmt(later, "2019-03-09")], p.actions, false);
  assert.equal(made(rt).length, 4, "only the new line was added");
});

test("Undo removes the whole spreadsheet import", () => {
  const { rt, stmt, lines } = setup();
  const before = run(rt, "getAllRows('Entries').length");
  const res = save(rt, [stmt(lines)], plan(rt, [stmt(lines)]).actions, false);
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(run(rt, "getAllRows('Entries').length"), before);
});

test("the upload is listed under the account's name, not under a raw key", () => {
  const { rt, stmt, lines } = setup();
  save(rt, [stmt(lines)], plan(rt, [stmt(lines)]).actions, false);
  const cov = run(rt, "listStatementCoverage()");
  const row = cov.accounts.find((a) => /Other Bank Savings/.test(a.label));
  assert.ok(row, "a coverage row exists for the account");
  assert.doesNotMatch(row.label, /ACCT-/);
  assert.equal(row.last.period_end, "2019-03-07");
});

test("a card account without digits: purchases stay purchases, a payment received is not income", () => {
  const { rt } = setup();
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-card', nickname: 'Other Bank Card', type: 'credit', bank_id: '', last_4: '', currency: 'PEN' });`);
  const rows = ST.parseCsv("Date,Merchant,Amount\n03/05/2019,MERCADOPAGO*TIENDA,41.37\n03/20/2019,PAGO RECIBIDO GRACIAS,-200.00\n");
  const m = ST.guessMapping(rows, { isCard: true });
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.equal(m.sign, "positive");
  const s = [{ key: "ACCT-pm-card", kind: "csv", holder: "", verified: false, balances: {}, file_name: "card.csv", period: r.period, lines: r.lines }];
  const p = plan(rt, s);
  assert.equal(p.summary.counts.expenses, 1, "the MercadoPago charge is a purchase");
  assert.equal(p.summary.counts.income, 0, "money arriving on a card is never income");
});
