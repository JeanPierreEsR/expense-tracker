// Findings from the owner's phone test of "Fill my history" (2026-10-22): a purchase held back as a false "possible match" against an
// entry the same import had made; set-aside lines that can only be spending/income (not a transfer); long saves that the app could
// resend and run twice. Lines below are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "t", statements, actions })})`);
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

function accounts() {
  const { rt, data } = freshApp({ entries: 60 });
  const debits = data.pms.filter((p) => p.type === "debit");
  const card = data.pms.find((p) => p.type === "credit");
  const stmt = (pm, lines, kind = "savings") => ({ key: pm.last_4, kind, verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1 } }, file_name: "t.pdf", lines });
  return { rt, a: debits[0], b: debits[1], card, stmt };
}

test("a purchase is not held back as a 'possible match' against an entry an earlier upload made", () => {
  const { rt, a, b, stmt } = accounts();
  const first = stmt(a, [{ date: "2019-03-13", description: "COMPRA DIDI", amount: -10, currency: "PEN" }]);
  save(rt, [first], plan(rt, [first]).actions, false);
  const second = stmt(b, [{ date: "2019-03-14", description: "COMPRA OTRA TIENDA", amount: -10, currency: "PEN" }]);
  const p = plan(rt, [second]);
  assert.equal(p.summary.counts.expenses, 1, "a different line that shares the amount is new, not a duplicate");
  assert.equal(p.summary.leftOut.possible, 0);
});

test("an entry the person recorded themselves can still make a line a possible duplicate, and the line is listed with it", () => {
  const { rt, a, b, stmt } = accounts();
  rt.run(`appendRowObject('Entries', { id: 'mine-1', type: 'expense', date: '2019-03-14', amount: 25.5, currency: 'PEN', category_id: '', description: 'Lunch', payment_method_id: ${JSON.stringify(a.id)}, paid_by: 'me', status: 'confirmed', source: 'manual', created_at: '2019-03-14T10:00:00' })`);
  const s = stmt(b, [{ date: "2019-03-14", description: "RESTAURANTE X", amount: -25.5, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.leftOut.possible, 1);
  assert.equal(p.summary.counts.expenses, 0);
  const row = p.summary.aside.find((x) => x.reason === "possible");
  assert.ok(row, "the held-back line is in the set-aside list");
  assert.equal(row.maybe.description, "Lunch", "and says which entry it might duplicate");
  // The person decides it is new after all.
  const res = save(rt, [s], p.actions.concat([row.optIn]), false);
  assert.equal(res.created.purchases, 1);
});

test("a set-aside outflow can be counted as ONE SIDE of a transfer, and the other statement completes it later", () => {
  const { rt, a, b, stmt } = accounts();
  const out = stmt(a, [{ date: "2019-03-10", description: "I-BANC TRANSFERENCIA", amount: -800, currency: "PEN" }]);
  const p = plan(rt, [out]);
  const row = p.summary.aside.find((x) => x.reason === "waiting");
  assert.ok(row && row.optInTransfer, "offered as a transfer");
  const actions = p.actions.filter((x) => !(x.type === "wait")).concat([row.optInTransfer]);
  const res = save(rt, [out], actions, false);
  assert.equal(res.created.transfers, 1);
  const e = made(rt)[0];
  assert.equal(e.type, "transfer");
  assert.equal(e.status, "pending", "something is missing (the other end), so it waits in Needs review");
  assert.equal(e.payment_method_id, a.id, "From = this account");
  assert.equal(e.to_payment_method_id, "", "To is left empty");
  assert.equal(Number(e.amount), 800);
  // The other account's statement arrives: its inflow completes the open transfer instead of becoming income.
  const inn = stmt(b, [{ date: "2019-03-11", description: "ABONO DE CUENTA", amount: 800, currency: "PEN" }]);
  const p2 = plan(rt, [inn]);
  assert.ok(p2.actions.some((x) => x.type === "complete_transfer" && x.entryId === e.id && x.side === "to"), "completes the transfer");
  assert.equal(p2.summary.counts.income, 0);
  // Saving it completes the transfer AND confirms it: both ends are known and it is on two statements.
  save(rt, [inn], p2.actions, false);
  const done = run(rt, `getAllRows('Entries').filter(function (x) { return x.id === ${JSON.stringify(e.id)}; })[0]`);
  assert.equal(done.to_payment_method_id, b.id);
  assert.equal(done.status, "confirmed", "confirmed automatically once the other statement completes it");
});

test("money arriving on a card that looks like a payment cannot be income but can be a transfer into the card", () => {
  const { rt, card, stmt } = accounts();
  const s = stmt(card, [{ date: "2019-03-11", description: "PAGO DEUDA TOT APP", amount: 1234.56, currency: "PEN" }], "visa");
  const row = plan(rt, [s]).summary.aside[0];
  assert.equal(row.optIn, null);
  assert.equal(row.optInTransfer.type, "record_transfer_leg");
  const res = save(rt, [s], [row.optInTransfer], false);
  assert.equal(res.created.transfers, 1);
  const e = made(rt)[0];
  assert.equal(e.payment_method_id, "", "From is left empty");
  assert.equal(e.to_payment_method_id, card.id, "To = the card");
});

test("a set-aside line can be counted as an investment (or a withdrawal), with the platform guessed from the wording", () => {
  const { rt, a, stmt } = accounts();
  const hapi = run(rt, "savePaymentMethod({ nickname: 'Hapi', type: 'investment' })");
  const s = stmt(a, [
    { date: "2019-03-10", description: "TRANSFERENCIA A HAPI INC", amount: -500, currency: "PEN" },
    { date: "2019-03-20", description: "TRANSFERENCIA DE HAPI INC", amount: 120, currency: "PEN" },
    { date: "2019-03-21", description: "TRANSFERENCIA A OTRO", amount: -75, currency: "PEN" }
  ]);
  const p = plan(rt, [s]);
  assert.deepEqual(p.summary.platforms, [{ id: hapi.id, name: "Hapi" }]);
  const [dep, wd, other] = p.summary.aside;
  assert.equal(dep.optInInvestment.platformId, hapi.id, "named in the wording → guessed");
  assert.equal(wd.optInInvestment.platformId, hapi.id);
  assert.equal(other.optInInvestment.platformId, "", "no platform named → left blank");
  // Count all three; the third on a platform the person picks.
  const actions = p.actions.filter((x) => x.type !== "wait").concat([dep.optInInvestment, wd.optInInvestment, { ...other.optInInvestment, platformId: hapi.id }]);
  const res = save(rt, [s], actions, false);
  assert.equal(res.created.investments, 3);
  const rows = made(rt);
  const deposit = rows.find((e) => Number(e.amount) === 500);
  assert.equal(deposit.type, "investment");
  assert.equal(deposit.status, "confirmed");
  assert.equal(deposit.payment_method_id, a.id, "From = the account the money left");
  assert.equal(deposit.to_payment_method_id, hapi.id, "To = the platform");
  const withdrawal = rows.find((e) => Number(e.amount) === -120);
  assert.ok(withdrawal, "money coming back is a NEGATIVE investment entry, as the app stores a withdrawal");
  const cat = run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'investment' && c.name === 'Investments'; })[0]");
  assert.equal(deposit.category_id, cat.id, "filed under the default Investments category");
  const sum = run(rt, "getPeriodSummary({ startDate: '2019-03-01', endDate: '2019-03-31' })");
  assert.equal(sum.totals.expense, 0, "not spending");
  assert.ok(sum.totals.investment > 0, "counted as investment");
});

test("an investment needs a real platform, and a dry run does not create the Investments category", () => {
  const { rt, a, stmt } = accounts();
  rt.run("deleteRowsWhere_('Categories', function (r) { return r.type === 'investment' && r.name === 'Investments'; })");
  const s = stmt(a, [{ date: "2019-03-10", description: "ENVIO", amount: -50, currency: "PEN" }]);
  assert.throws(() => save(rt, [s], [{ type: "add_history_investment", stmt: 0, line: 0, platformId: "not-a-platform" }], false), /platform/i);
  save(rt, [s], [{ type: "add_history_investment", stmt: 0, line: 0 }], true);
  assert.equal(run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'investment' && c.name === 'Investments'; }).length"), 0, "a dry run creates nothing");
  save(rt, [s], [{ type: "add_history_investment", stmt: 0, line: 0 }], false);
  assert.equal(run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'investment' && c.name === 'Investments'; }).length"), 1);
});

test("money arriving on a credit card is never offered as an investment", () => {
  const { rt, card, stmt } = accounts();
  const s = stmt(card, [{ date: "2019-03-11", description: "PAGO DEUDA TOT APP", amount: 1234.56, currency: "PEN" }], "visa");
  assert.equal(plan(rt, [s]).summary.aside[0].optInInvestment, null);
});

// The owner's refund rule (the line-by-line comparison's): a refund in the SAME month as the charge it reverses cancels it (a negative
// expense); in any other month, or with no matching charge, it is income in "Refunds". Fill my history used to make every refund a
// negative expense (found 2026-10-23).
const refundsOf = (rt) => made(rt).filter((e) => e.type === "income" || Number(e.amount) < 0);

test("a refund in the month AFTER its charge is income in Refunds, not a negative expense", () => {
  const { rt, card, stmt } = accounts();
  const s = stmt(card, [
    { date: "2019-03-31", description: "INKAFARMA WEB", amount: -36.3, currency: "PEN" },
    { date: "2019-04-02", description: "REV.INKAFARMA WEB", amount: 36.3, currency: "PEN" }
  ], "visa");
  const p = plan(rt, [s]);
  assert.equal(p.summary.counts.refundIncome, 1);
  assert.equal(p.summary.counts.refunds, 0);
  const res = save(rt, [s], p.actions, false);
  assert.equal(res.created.income, 1);
  const refund = made(rt).find((e) => e.type === "income");
  assert.equal(Number(refund.amount), 36.3);
  assert.equal(refund.status, "confirmed");
  const cat = run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'income' && c.name === 'Refunds'; })[0]");
  assert.equal(refund.category_id, cat.id, "filed under Refunds");
  assert.ok(!made(rt).some((e) => Number(e.amount) < 0), "and no negative expense");
});

test("a refund with no matching charge is income in Refunds too", () => {
  const { rt, card, stmt } = accounts();
  const s = stmt(card, [{ date: "2019-03-18", description: "REV.TIENDA LEJANA", amount: 20, currency: "PEN" }], "visa");
  const p = plan(rt, [s]);
  assert.equal(p.summary.counts.refundIncome, 1);
  assert.equal(p.summary.counts.income, 0, "not counted as ordinary income");
});

test("one charge is reversed by one refund only; a second identical refund is income", () => {
  const { rt, card, stmt } = accounts();
  const s = stmt(card, [
    { date: "2019-03-10", description: "PARKING APP", amount: -17, currency: "PEN" },
    { date: "2019-03-12", description: "REV.PARKING APP", amount: 17, currency: "PEN" },
    { date: "2019-03-13", description: "REV.PARKING APP", amount: 17, currency: "PEN" }
  ], "visa");
  const c = plan(rt, [s]).summary.counts;
  assert.equal(c.refunds, 1);
  assert.equal(c.refundIncome, 1);
});

test("a refund of a charge that is already an entry (same month) cancels it in that charge's category", () => {
  const { rt, card, stmt, a } = accounts();
  const cat = run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'expense'; })[0]");
  rt.run(`appendRowObject('Entries', { id: 'mine-2', type: 'expense', date: '2019-03-05', amount: 44.4, currency: 'PEN', category_id: ${JSON.stringify(cat.id)}, description: 'Pharmacy', payment_method_id: ${JSON.stringify(card.id)}, paid_by: 'me', status: 'confirmed', source: 'manual', created_at: '2019-03-05T10:00:00' })`);
  const s = stmt(card, [{ date: "2019-03-20", description: "REV.PHARMACY", amount: 44.4, currency: "PEN" }], "visa");
  const p = plan(rt, [s]);
  assert.equal(p.summary.counts.refunds, 1);
  assert.equal(p.actions.find((x) => x.type === "add_history_reversal").entryId, "mine-2");
  save(rt, [s], p.actions, false);
  const neg = made(rt).find((e) => Number(e.amount) < 0);
  assert.equal(neg.category_id, cat.id, "the month nets to zero in the original category");
  assert.equal(Number(neg.amount), -44.4);
  assert.ok(a);
});

test("'See what it added': the entries of ONE upload can be listed, and its details say what else it did", () => {
  const { rt, a, b, card, stmt } = accounts();
  const one = [stmt(a, [
    { date: "2019-03-02", description: "ABONO SUELDO", amount: 3000.13, currency: "PEN" },
    { date: "2019-03-05", description: "COMPRA BODEGA", amount: -23.47, currency: "PEN" },
    { date: "2019-03-10", description: "I-BANC TRANSFERENCIA", amount: -800, currency: "PEN" },
    { date: "2019-03-12", description: "IMPUESTO ITF", amount: -0.5, currency: "PEN" }
  ])];
  const resOne = save(rt, one, plan(rt, one).actions, false);
  const two = [stmt(b, [{ date: "2019-03-07", description: "COMPRA OTRA", amount: -9.99, currency: "PEN" }])];
  const resTwo = save(rt, two, plan(rt, two).actions, false);

  const listed = run(rt, `listEntries({ importBatchId: ${JSON.stringify(resOne.batchId)} })`);
  assert.equal(listed.length, 3, "salary, purchase and fee — the waiting transfer is not an entry");
  assert.ok(listed.every((e) => e.import_batch_id === resOne.batchId), "nothing from the other upload");
  assert.equal(run(rt, `listEntries({ importBatchId: ${JSON.stringify(resTwo.batchId)} })`).length, 1);

  const d = run(rt, `getStatementBatchDetails({ batchId: ${JSON.stringify(resOne.batchId)} })`);
  assert.equal(d.statements.length, 1);
  assert.match(d.statements[0].label, new RegExp(a.last_4));
  assert.equal(d.statements[0].lines_total, 4);
  assert.equal(d.waiting.length, 1, "the unpaired transfer is listed as set aside");
  assert.equal(d.waiting[0].amount, -800);
  assert.equal(d.outcomes.waiting, 1);
  assert.equal(d.changedEntries, 0);
  assert.ok(card);
});

test("an upload that only remembered lines lists no entries", () => {
  const { rt, a, stmt } = accounts();
  const s = [stmt(a, [{ date: "2019-03-10", description: "I-BANC TRANSFERENCIA", amount: -800, currency: "PEN" }])];
  const res = save(rt, s, plan(rt, s).actions, false);
  assert.equal(run(rt, `listEntries({ importBatchId: ${JSON.stringify(res.batchId)} })`).length, 0);
  assert.equal(run(rt, `getStatementBatchDetails({ batchId: ${JSON.stringify(res.batchId)} })`).waiting.length, 1);
});

// ---- Round 4: the "Payments with people" group, "Send to Needs review", pending when something is missing ----

test("wallet payments are grouped by person: what you paid and what they paid you", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [
    { date: "2019-03-02", description: "Yape Ana Lopez", amount: -50, currency: "PEN" },
    { date: "2019-03-09", description: "Yape Ana Lopez", amount: 50, currency: "PEN" },
    { date: "2019-03-03", description: "PLIN-CARLA", amount: -20, currency: "PEN" },
    { date: "2019-03-04", description: "ABON PLIN-LUIS M", amount: 78, currency: "PEN" },
    { date: "2019-03-05", description: "Yape USD", amount: 205, currency: "PEN" },
    { date: "2019-03-06", description: "LUKITA JUAN PEREZ", amount: -15, currency: "PEN" },
    { date: "2019-03-07", description: "COMPRA BODEGA", amount: -9, currency: "PEN" }
  ]);
  const p = plan(rt, [s]);
  const out = p.summary.peopleOut;
  assert.deepEqual(out.map((o) => o.personName).sort(), ["Ana Lopez", "Carla", "Juan Perez"], "names read from the wording");
  assert.equal(p.summary.counts.expenses, 4, "payments you made are spending by default (the bodega too)");
  const incoming = p.summary.aside.filter((x) => x.reason === "person");
  assert.deepEqual(incoming.map((x) => x.personName).sort(), ["", "Ana Lopez", "Luis M"], "'Yape USD' names nobody");
  assert.ok(incoming.every((x) => x.optInReview && x.optInReview.type === "add_history_pending"));
  assert.ok(out.every((o) => o.optInReview.type === "add_history_pending" && o.optInLeave.type === "ignore"));
  assert.equal(p.summary.aside.filter((x) => x.reason === "person" && x.group).length, 0, "people are grouped by person, not by similar amounts");
});

test("a bank transfer or another wallet with a PERSON'S name is a payment with a person; banks, companies and generic wording are not", () => {
  const { rt } = accounts();
  const who = (d) => run(rt, `stmtPersonLine_({ description: ${JSON.stringify(d)} })`);
  // people
  assert.equal(who("TRANSF MARCO").name, "Marco");
  assert.equal(who("TRANSFERENCIA A JUAN PEREZ").name, "Juan Perez");
  assert.equal(who("TRANSFERENCIA A MARIA DE LA CRUZ").name, "Maria De La Cruz");
  assert.equal(who("SIP ANA LOPEZ").name, "Ana Lopez", "another wallet with a name");
  assert.equal(who("FALABELLA JUAN PEREZ").name, "Juan Perez");
  assert.equal(who("Yape Marco Vega").name, "Marco Vega");
  assert.equal(who("Yape USD").key, "", "a strong wallet line is a payment with a person even with no name");
  // English wording
  assert.equal(who("TRANSFER TO JOHN SMITH").name, "John Smith");
  assert.equal(who("Transfer from Jane Doe").name, "Jane Doe");
  assert.equal(who("ZELLE PAYMENT TO JOHN SMITH").name, "John Smith", "Zelle is a wallet between people");
  assert.equal(who("VENMO JANE DOE").name, "Jane Doe");
  assert.equal(who("PAYPAL JOHN SMITH").name, "John Smith", "PayPal also carries merchants, so it needs a name-like remainder");
  assert.equal(who("SENT TO MARIA GARCIA").name, "Maria Garcia");
  assert.equal(who("RECEIVED FROM LUIS PEREZ").name, "Luis Perez");
  ["PAYMENT THANK YOU", "ONLINE TRANSFER TO SAVINGS", "WIRE TRANSFER FROM ACME INC", "ACH DEPOSIT PAYROLL", "ATM WITHDRAWAL", "PAYPAL *SPOTIFY",
    "TRANSFER TO CHECKING ACCOUNT", "AUTOPAY CREDIT CARD"].forEach((d) => assert.equal(who(d), null, d + " is not a person"));
  // not people: banks, companies, own accounts, generic words, purchases
  ["TRANSF.BCO.INTERBA", "Transf. Inter. Recibida", "Transf. Inter. Enviada", "TRANSFER BPI", "TRAN.CTAS.TERC.BM", "TRANSF.BCO.SIP",
    "Transf. entre mis cuentas", "DE INVERSIONES ALT", "ABONO SUELDO", "AGORA SHOP COMPANIA FO", "PAGO DEUDA TOT APP", "COMPRA BODEGA LA ESQUINA",
    "TRANSFERENCIA A OTRA CUENTA 0001", "Pago de Tarjeta de Crédito", "I-BANC"].forEach((d) => assert.equal(who(d), null, d + " is not a person"));
});

test("unpaired bank transfers with a name go to Payments with people, not to 'waiting'; every choice is offered", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [
    { date: "2019-03-02", description: "TRANSF MARCO", amount: 267, currency: "PEN" },
    { date: "2019-03-03", description: "TRANSF PEDRO RUIZ", amount: -80, currency: "PEN" },
    { date: "2019-03-04", description: "ABONO SUELDO", amount: 3000, currency: "PEN" },
    { date: "2019-03-05", description: "TRANSF.BCO.INTERBA", amount: -500, currency: "PEN" }
  ]);
  const p = plan(rt, [s]);
  const inc = p.summary.aside.find((x) => x.reason === "person");
  assert.equal(inc.personName, "Marco");
  assert.equal(p.summary.peopleOut.length, 1);
  assert.equal(p.summary.peopleOut[0].personName, "Pedro Ruiz");
  assert.equal(p.summary.counts.expenses, 1, "what you paid a person is spending by default");
  assert.equal(p.summary.aside.filter((x) => x.reason === "waiting").length, 1, "the bank-to-bank transfer still waits for its other statement");
  // every classification is on offer for every kind of line
  const types = (o) => ["optInTransfer", "optInInvestment", "optInReview"].map((k) => o[k] && o[k].type);
  assert.deepEqual(types(inc), ["record_transfer_leg", "add_history_investment", "add_history_pending"], "money from a person");
  assert.deepEqual(types(p.summary.peopleOut[0]), ["record_transfer_leg", "add_history_investment", "add_history_pending"], "money to a person");
  assert.equal(p.summary.peopleOut[0].optInLeave.type, "ignore");
  const salary = p.summary.incomeLines[0];
  assert.equal(salary.description, "ABONO SUELDO", "income imported by default can be reclassified too");
  assert.deepEqual(types(salary), ["record_transfer_leg", "add_history_investment", "add_history_pending"]);
  const waiting = p.summary.aside.find((x) => x.reason === "waiting");
  assert.equal(waiting.optInReview.type, "add_history_pending", "a waiting line can go to Needs review too");
});

test("Send to Needs review: a pending expense or income, not in the totals, listed with the upload", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [
    { date: "2019-03-02", description: "Yape Ana Lopez", amount: -50, currency: "PEN" },
    { date: "2019-03-09", description: "Yape Ana Lopez", amount: 50, currency: "PEN" }
  ]);
  const actions = [{ type: "add_history_pending", stmt: 0, line: 0 }, { type: "add_history_pending", stmt: 0, line: 1 }];
  const res = save(rt, [s], actions, false);
  assert.equal(res.pendingCount, 2);
  const rows = made(rt);
  const exp = rows.find((e) => e.type === "expense"), inc = rows.find((e) => e.type === "income");
  assert.equal(exp.status, "pending"); assert.equal(Number(exp.amount), 50); assert.equal(exp.category_id, "");
  assert.equal(inc.status, "pending"); assert.equal(Number(inc.amount), 50);
  const sum = run(rt, "getPeriodSummary({ startDate: '2019-03-01', endDate: '2019-03-31' })");
  assert.equal(sum.totals.expense, 0, "pending is not counted until confirmed");
  assert.equal(sum.totals.income, 0);
  const listed = run(rt, `listEntries({ importBatchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(listed.length, 2, "the upload's own list includes what waits in Needs review");
  assert.ok(run(rt, "listEntries({ startDate: '2019-03-01', endDate: '2019-03-31' })").every((e) => e.status === "confirmed"), "other lists stay confirmed-only");
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(made(rt).length, 0, "Undo removes pending entries too");
});

test("leaving a payment out skips it and remembers that, so it is not offered again", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [{ date: "2019-03-02", description: "Yape-Bodega Sol", amount: -50, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const o = p.summary.peopleOut[0];
  const actions = p.actions.filter((x) => !(x.type === "add_history_expense" && x.stmt === o.stmt && x.line === o.line)).concat([o.optInLeave]);
  save(rt, [s], actions, false);
  assert.equal(made(rt).length, 0);
  const again = plan(rt, [s]);
  assert.equal(again.summary.peopleOut.length, 0);
  assert.equal(again.summary.leftOut.handled, 1);
});

test("interest earned is filed under Savings return; other income stays uncategorized", () => {
  const { rt, a, stmt } = accounts();
  const cat = run(rt, "(function () { var c = getAllRows('Categories').filter(function (x) { return x.type === 'income' && x.name === 'Savings return'; })[0]; return c || null; })()");
  assert.ok(cat, "the account has a Savings return category");
  const s = stmt(a, [
    { date: "2019-03-31", description: "Pago de intereses", amount: 17.86, currency: "PEN" },
    { date: "2019-03-02", description: "ABONO SUELDO", amount: 3000.13, currency: "PEN" }
  ]);
  save(rt, [s], plan(rt, [s]).actions, false);
  const rows = made(rt);
  assert.equal(rows.find((e) => Number(e.amount) === 17.86).category_id, cat.id);
  assert.equal(rows.find((e) => Number(e.amount) === 3000.13).category_id, "");
});

test("an investment with no platform waits in Needs review; with a platform it is confirmed", () => {
  const { rt, a, stmt } = accounts();
  const hapi = run(rt, "savePaymentMethod({ nickname: 'Hapi', type: 'investment' })");
  const s = stmt(a, [
    { date: "2019-03-10", description: "ENVIO UNO", amount: -500, currency: "PEN" },
    { date: "2019-03-11", description: "ENVIO DOS", amount: -300, currency: "PEN" }
  ]);
  save(rt, [s], [{ type: "add_history_investment", stmt: 0, line: 0 }, { type: "add_history_investment", stmt: 0, line: 1, platformId: hapi.id }], false);
  const rows = made(rt);
  assert.equal(rows.find((e) => Number(e.amount) === 500).status, "pending");
  assert.equal(rows.find((e) => Number(e.amount) === 300).status, "confirmed");
});

test("lines already remembered as waiting are not offered to be remembered again", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [{ date: "2019-03-10", description: "I-BANC TRANSFERENCIA", amount: -800, currency: "PEN" }]);
  const first = plan(rt, [s]);
  assert.ok(first.actions.some((x) => x.type === "wait"), "the first time it is remembered");
  save(rt, [s], first.actions, false);
  const again = plan(rt, [s]);
  assert.equal(again.actions.length, 0, "nothing left to do on a repeat");
  assert.equal(again.summary.aside.length, 1, "but it is still listed as set aside");
});

test("a repeated request runs once: the second copy gets the first one's answer and adds nothing", () => {
  const { rt, a, stmt } = accounts();
  const s = stmt(a, [{ date: "2019-03-05", description: "COMPRA TIENDA", amount: -12.34, currency: "PEN" }]);
  const payload = { dryRun: false, filename: "t", statements: [s], actions: plan(rt, [s]).actions, _requestId: "req-1" };
  const first = JSON.parse(rt.run(`JSON.stringify(routeActionOnce_('applyStatementDecisions', ${JSON.stringify(payload)}))`));
  const again = JSON.parse(rt.run(`JSON.stringify(routeActionOnce_('applyStatementDecisions', ${JSON.stringify(payload)}))`));
  assert.equal(again.batchId, first.batchId, "the same answer, not a second batch");
  assert.equal(made(rt).length, 1);
});

test("a 30-statement upload and its Undo take a handful of sheet writes, not one per statement", () => {
  const { rt, a } = accounts();
  const stmts = Array.from({ length: 30 }, (_, k) => ({
    key: a.last_4, kind: "savings", verified: true, period: { start: `${2000 + k}-03-01`, end: `${2000 + k}-03-28` }, balances: { PEN: { closing: 1 } }, file_name: "s" + k + ".pdf",
    lines: [{ date: `${2000 + k}-03-05`, description: "COMPRA " + k, amount: -(10 + k + 0.11), currency: "PEN" }, { date: `${2000 + k}-03-06`, description: "COMPRA B " + k, amount: -(20 + k + 0.22), currency: "PEN" }]
  }));
  const p = plan(rt, stmts);
  rt.resetStats();
  const res = save(rt, stmts, p.actions, false);
  const applyWrites = rt.stats.writes;
  rt.resetStats();
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  console.log(`30 statements: apply writes ${applyWrites}, undo writes ${rt.stats.writes}, row deletes ${rt.stats.rowDeletes}`);
  assert.ok(applyWrites < 40, `apply writes: ${applyWrites}`);
  assert.ok(rt.stats.rowDeletes <= 12, `undo row deletes: ${rt.stats.rowDeletes}`);
  assert.equal(run(rt, "listStatementBatches()").length, 0);
});
