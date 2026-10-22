// "Fill my history": statements become past entries with one approval — confirmed, no category, transfers between the
// person's own accounts recorded once, lines whose other statement is missing left waiting. Lines below are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt, data } = freshApp({ entries: 60 });
  const savings = data.pms.find((p) => p.type === "debit");
  const card = data.pms.find((p) => p.type === "credit");
  assert.ok(savings && card, "seed has a debit and a credit account");
  // Dates in 2019 so nothing in the seed can match by accident.
  const savingsStmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "s.pdf",
    lines: [
      { date: "2019-03-02", description: "ABONO SUELDO", amount: 3000.13, currency: "PEN" },
      { date: "2019-03-05", description: "COMPRA BODEGA LA ESQUINA", amount: -23.47, currency: "PEN" },
      { date: "2019-03-10", description: "PAGO TARJETA DE CREDITO", amount: -200.11, currency: "PEN" },
      { date: "2019-03-12", description: "IMPUESTO ITF", amount: -0.5, currency: "PEN" },
      { date: "2019-03-20", description: "TRANSFERENCIA A OTRA CUENTA 0001", amount: -154.29, currency: "PEN" }
    ]
  };
  const cardStmt = {
    key: card.last_4, kind: "visa", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: -50 } }, file_name: "c.pdf",
    lines: [
      { date: "2019-03-11", description: "PAGO RECIBIDO", amount: 200.11, currency: "PEN", section: "payments" },
      { date: "2019-03-14", description: "RAPPI PERU LIMA PER", amount: -41.37, currency: "PEN" },
      { date: "2019-03-15", description: "AMAZON*ABC US", amount: -12.99, currency: "USD" },
      { date: "2019-03-18", description: "REV.RAPPI PERU LIMA PER", amount: 41.37, currency: "PEN" }
    ]
  };
  return { rt, data, savings, card, savingsStmt, cardStmt };
}

function plan(rt, statements) {
  return run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
}
function save(rt, statements, actions, dryRun) {
  return run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "history", statements, actions })})`);
}
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

test("the plan decides every line itself, with no per-line choices", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const p = plan(rt, [savingsStmt, cardStmt]);
  const s = p.summary;
  assert.equal(s.counts.expenses, 3, "bodega, Rappi and the USD purchase");
  assert.equal(s.counts.income, 1, "the salary");
  assert.equal(s.counts.refunds, 1, "the Rappi refund");
  assert.equal(s.counts.transfers, 1, "the card payment is ONE transfer, not an expense on either account");
  assert.equal(s.counts.fees, 1);
  assert.equal(s.leftOut.waiting, 1, "the unpaired transfer waits for its other statement");
  assert.deepEqual(s.unknownAccounts, []);
  assert.equal(s.spent.PEN, 23.47 + 41.37);
  assert.equal(s.spent.USD, 12.99);
  assert.equal(s.from, "2019-03-02");
  assert.equal(s.to, "2019-03-18");
});

test("saving it adds confirmed entries without a category, and nothing is counted twice", () => {
  const { rt, savings, card, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  const p = plan(rt, stmts);
  const dry = save(rt, stmts, p.actions, true);
  assert.equal(made(rt).length, 0, "a dry run writes nothing");
  assert.ok(dry.created.purchases >= 3);

  const res = save(rt, stmts, p.actions, false);
  assert.equal(res.created.transfers, 1);
  assert.equal(res.created.purchases, 3);
  assert.equal(res.created.income, 1);
  assert.equal(res.created.reversals, 1);
  assert.equal(res.created.fees, 1);

  const rows = made(rt);
  const byDesc = (re) => rows.find((e) => re.test(e.description));
  const rappi = rows.find((e) => /^Rappi/.test(e.description) && e.type === "expense" && Number(e.amount) > 0);
  assert.equal(rappi.status, "confirmed", "confirmed at once, not pending");
  assert.equal(rappi.category_id, "", "no category");
  assert.equal(rappi.source, "import");
  assert.equal(rappi.merchant, "rappi peru", "the merchant is kept (same form the e-mail entries use) so later categorising can find it");
  assert.equal(rappi.payment_method_id, card.id);
  assert.ok(rappi.import_batch_id, "one batch to undo");
  const refund = rows.find((e) => Number(e.amount) < 0);
  assert.equal(refund.type, "expense", "a refund nets the spending out instead of counting as income");
  assert.equal(Number(refund.amount), -41.37);
  const salary = byDesc(/Sueldo/);
  assert.equal(salary.type, "income");
  assert.equal(salary.status, "confirmed");
  assert.equal(salary.category_id, "");
  const transfers = rows.filter((e) => e.type === "transfer");
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].payment_method_id, savings.id);
  assert.equal(transfers[0].to_payment_method_id, card.id);
  assert.ok(!rows.some((e) => e.type === "expense" && Number(e.amount) === 200.11), "the card payment is not an expense");
  assert.ok(!rows.some((e) => Number(e.amount) === 154.29), "the unpaired transfer was not imported");
});

test("one Undo removes the whole import", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  const before = run(rt, "getAllRows('Entries').length");
  const res = save(rt, stmts, plan(rt, stmts).actions, false);
  assert.ok(run(rt, "getAllRows('Entries').length") > before);
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(run(rt, "getAllRows('Entries').length"), before);
});

test("uploading the same statements again adds nothing", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  save(rt, stmts, plan(rt, stmts).actions, false);
  const count = run(rt, "getAllRows('Entries').length");
  const again = plan(rt, stmts);
  assert.equal(again.summary.importable, 0);
  assert.equal(again.summary.leftOut.handled, 9 - 1 /* the waiting line is remembered as waiting, not handled */);
  save(rt, stmts, again.actions, false);
  assert.equal(run(rt, "getAllRows('Entries').length"), count);
});

test("the other statement can come later: a waiting line pairs with it", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  // Only the savings statement first: the card payment waits instead of becoming an expense.
  const first = plan(rt, [savingsStmt]);
  assert.equal(first.summary.counts.transfers, 0);
  assert.equal(first.summary.leftOut.waiting, 2, "card payment and the other transfer");
  save(rt, [savingsStmt], first.actions, false);
  assert.ok(!made(rt).some((e) => Number(e.amount) === 200.11));
  // The card statement arrives: the stored card payment now pairs with its line.
  const second = plan(rt, [cardStmt]);
  assert.equal(second.summary.counts.transfers, 1);
  save(rt, [cardStmt], second.actions, false);
  const rows = made(rt);
  assert.equal(rows.filter((e) => e.type === "transfer").length, 1);
  assert.ok(!rows.some((e) => e.type === "expense" && Number(e.amount) === 200.11));
});

test("a statement for an account that is not in the app is skipped and named", () => {
  const { rt, savingsStmt } = setup();
  const stranger = { key: "9999", kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "z.pdf",
    lines: [{ date: "2019-03-03", description: "COMPRA TIENDA", amount: -9.99, currency: "PEN" }] };
  const p = plan(rt, [savingsStmt, stranger]);
  assert.deepEqual(p.summary.unknownAccounts, ["9999"]);
  assert.equal(p.summary.leftOut.noAccount, 1);
  const res = save(rt, [savingsStmt, stranger], p.actions, false);
  assert.ok(res.batchId, "the rest still saves");
  assert.ok(!made(rt).some((e) => Number(e.amount) === 9.99));
});

test("foreign-currency months without an exchange rate are reported", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  const res = save(rt, stmts, plan(rt, stmts).actions, true);
  assert.deepEqual(res.rateNeeds.months, [{ currency: "USD", month: "2019-03" }]);
});

test("balances are not touched", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  const before = run(rt, "getAllRows('Account Opening Balances').length");
  const p = plan(rt, stmts);
  assert.ok(!p.actions.some((a) => a.type === "set_balance"));
  save(rt, stmts, p.actions, false);
  assert.equal(run(rt, "getAllRows('Account Opening Balances').length"), before);
});

test("a card charge with a payment word in its name is a purchase, not a transfer", () => {
  const { rt, card, cardStmt } = setup();
  const stmt = { ...cardStmt, lines: [{ date: "2019-03-14", description: "MDOPAGO*MERCADO PAGO LIMA PER", amount: -77.7, currency: "PEN" }] };
  const s = plan(rt, [stmt]).summary;
  assert.equal(s.counts.expenses, 1);
  assert.equal(s.leftOut.waiting, 0);
  assert.equal(card.type, "credit");
});

test("money from a person by Yape/Plin is set aside, not counted as income, and can be opted in", () => {
  const { rt, savings, savingsStmt } = setup();
  const stmt = { ...savingsStmt, lines: [
    { date: "2019-03-02", description: "ABONO SUELDO", amount: 3000.13, currency: "PEN" },
    { date: "2019-03-03", description: "Yape Ana Lo", amount: 50, currency: "PEN" },
    { date: "2019-03-04", description: "ABON PLIN-ANA LO", amount: 31.3, currency: "PEN" },
    { date: "2019-03-05", description: "Yape Ana Lo", amount: -19.9, currency: "PEN" }
  ] };
  const p = plan(rt, [stmt]);
  assert.equal(p.summary.counts.income, 1, "only the salary");
  assert.equal(p.summary.counts.expenses, 1, "paying a person is still spending");
  assert.equal(p.summary.leftOut.fromPeople, 2);
  const aside = p.summary.aside.filter((a) => a.reason === "person");
  assert.equal(aside.length, 2);
  assert.deepEqual(aside[0].optIn.type, "add_history_income");
  // Opting one in: add its action, and the entry is a confirmed uncategorized income on the right account.
  const res = save(rt, [stmt], p.actions.concat([aside[0].optIn]), false);
  assert.equal(res.created.income, 2);
  const mine = made(rt).filter((e) => e.type === "income" && Number(e.amount) === 50);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, "confirmed");
  assert.equal(mine[0].payment_method_id, savings.id);
});

test("a payment received on a credit card is set aside with no way to count it as income", () => {
  const { rt, cardStmt } = setup();
  const stmt = { ...cardStmt, lines: [{ date: "2019-03-11", description: "PAGO DEUDA TOT APP", amount: 1234.56, currency: "PEN" }] };
  const p = plan(rt, [stmt]);
  assert.equal(p.summary.aside.length, 1);
  assert.equal(p.summary.aside[0].optIn, null);
  assert.equal(p.summary.counts.income, 0);
});

test("a waiting line can be opted in: it replaces the wait action, nothing is counted twice", () => {
  const { rt, savingsStmt } = setup();
  const stmt = { ...savingsStmt, lines: [{ date: "2019-03-28", description: "PPA PAGOS", amount: 4321.09, currency: "PEN" }] };
  const p = plan(rt, [stmt]);
  assert.equal(p.summary.leftOut.waiting, 1, "looks like a payment between accounts");
  const a = p.summary.aside[0];
  assert.equal(a.reason, "waiting");
  const actions = p.actions.filter((x) => !(x.type === "wait" && x.stmt === a.stmt && x.line === a.line)).concat([a.optIn]);
  const res = save(rt, [stmt], actions, false);
  assert.equal(res.created.income, 1);
  assert.equal(res.linesRemembered, 1, "the line is remembered once, as added");
});
