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

test("a new account has no Bank fees category: it is created on first use, once, and not by a dry run", () => {
  // Found on a fresh install (2026-10-22): only the owner's copy had "Bank fees", so the whole save was refused.
  const { rt, savingsStmt } = setup();
  rt.run("deleteRowsWhere_('Categories', function (r) { return r.type === 'expense' && (r.name === 'Bank fees' || r.key === 'bank_fees'); })");
  const count = () => run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'expense' && c.name === 'Bank fees'; }).length");
  assert.equal(count(), 0);
  const stmt = { ...savingsStmt, lines: [{ date: "2019-03-12", description: "IMPUESTO ITF", amount: -0.5, currency: "PEN" }, { date: "2019-03-13", description: "ITF 0123", amount: -0.2, currency: "PEN" }] };
  const p = plan(rt, [stmt]);
  assert.equal(p.summary.counts.fees, 2);
  save(rt, [stmt], p.actions, true);
  assert.equal(count(), 0, "a dry run creates nothing");
  const res = save(rt, [stmt], p.actions, false);
  assert.equal(res.created.fees, 2);
  assert.equal(count(), 1, "one category for both fees");
  const cat = run(rt, "getAllRows('Categories').filter(function (c) { return c.type === 'expense' && c.name === 'Bank fees'; })[0]");
  const fees = made(rt);
  assert.ok(fees.every((e) => e.category_id === cat.id && e.status === "confirmed"));
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

test("set-aside lines that repeat (same wording, amount within 10%) share a group; a different amount does not", () => {
  const { rt, savingsStmt } = setup();
  const l = (date, amount) => ({ date, description: "PPA PAGOS", amount, currency: "PEN" });
  const stmt = { ...savingsStmt, lines: [l("2019-03-02", 4000), l("2019-03-12", 4100.5), l("2019-03-22", 4350), l("2019-03-25", 9000),
    { date: "2019-03-26", description: "TRANSF ANA", amount: 4000, currency: "PEN" }] };
  const aside = plan(rt, [stmt]).summary.aside;
  const by = (amt) => aside.find((a) => a.amount === amt);
  const g = by(4100.5).group;
  assert.ok(g, "similar amounts are grouped");
  assert.equal(aside.filter((a) => a.group === g).length, 3, "4000, 4100.5 and 4350 are within 10% of 4000");
  assert.equal(by(9000).group, null, "same wording but a very different amount stays on its own");
  assert.notEqual(aside.find((a) => a.description === "TRANSF ANA").group, g, "different wording is never grouped");
});

test("a salary-like line on another account is not grouped with the first account's", () => {
  const { rt, data, savings, savingsStmt } = setup();
  const other = data.pms.filter((p) => p.type === "debit" && p.id !== savings.id)[0];
  const mk = (key) => ({ ...savingsStmt, key, lines: [{ date: "2019-03-02", description: "PPA PAGOS", amount: 4000, currency: "PEN" }, { date: "2019-03-09", description: "PPA PAGOS", amount: 4000, currency: "PEN" }] });
  const aside = plan(rt, [mk(savings.last_4), mk(other.last_4)]).summary.aside;
  assert.equal(aside.length, 4);
  assert.equal(new Set(aside.map((a) => a.group)).size, 2, "one group per account");
});

function exchangeSetup() {
  const s = setup();
  const second = s.data.pms.filter((p) => p.type === "debit" && p.id !== s.savings.id)[0];
  s.second = second;
  const penOut = { ...s.savingsStmt, lines: [{ date: "2019-03-20", description: "TRAN.CTAS.TERC.BM", amount: -7123.45, currency: "PEN" }] };
  const usdIn = { key: second.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { USD: { closing: 1 } }, file_name: "u.pdf",
    lines: [{ date: "2019-03-21", description: "DE INVERSIONES XYZ", amount: 2119.47, currency: "USD" }] };
  s.stmts = [penOut, usdIn];
  return s;
}

test("a currency exchange looks like one expense and one income, and is suggested when rates are on file", () => {
  const { rt, stmts } = exchangeSetup();
  const before = plan(rt, stmts);
  assert.equal(before.summary.counts.expenses, 1);
  assert.equal(before.summary.counts.income, 1);
  assert.deepEqual(before.summary.exchangeSuggestions, [], "no rates on file: nothing is guessed");
  assert.equal(before.summary.candidates.length, 2, "both lines can still be linked by hand");
  run(rt, `setExchangeRate('USD', '2019-03', 3.36)`);
  const after = plan(rt, stmts);
  assert.equal(after.summary.exchangeSuggestions.length, 1);
  assert.equal(after.summary.exchangeSuggestions[0].out.amount, -7123.45);
  assert.equal(after.summary.exchangeSuggestions[0].in.currency, "USD");
});

test("an exchange is only suggested within 24 hours: the same or the next day, not two days apart", () => {
  const { rt, stmts } = exchangeSetup();
  run(rt, `setExchangeRate('USD', '2019-03', 3.36)`);
  assert.equal(plan(rt, stmts).summary.exchangeSuggestions.length, 1, "the next day is inside the window");
  const later = [stmts[0], { ...stmts[1], lines: [{ ...stmts[1].lines[0], date: "2019-03-22" }] }];
  assert.deepEqual(plan(rt, later).summary.exchangeSuggestions, [], "two days apart is not suggested");
  const sameDay = [stmts[0], { ...stmts[1], lines: [{ ...stmts[1].lines[0], date: "2019-03-20" }] }];
  assert.equal(plan(rt, sameDay).summary.exchangeSuggestions.length, 1, "the same day is");
});

test("an amount that does not fit the rate is not suggested", () => {
  const { rt, stmts } = exchangeSetup();
  run(rt, `setExchangeRate('USD', '2019-03', 5.5)`);
  assert.deepEqual(plan(rt, stmts).summary.exchangeSuggestions, []);
});

test("linking an exchange records two one-sided transfers that are neither spending nor income", () => {
  const { rt, savings, second, stmts } = exchangeSetup();
  const link = { type: "record_exchange", out: { stmt: 0, line: 0 }, in: { stmt: 1, line: 0 } };
  const res = save(rt, stmts, [link], false);
  assert.equal(res.created.exchanges, 1);
  assert.equal(res.created.transfers, 2);
  const rows = made(rt);
  const out = rows.find((e) => e.currency === "PEN");
  const inn = rows.find((e) => e.currency === "USD");
  assert.equal(out.type, "transfer");
  assert.equal(out.payment_method_id, savings.id);
  assert.equal(out.to_payment_method_id, "", "the money that left has no destination in the app");
  assert.equal(Number(out.amount), 7123.45);
  assert.equal(inn.type, "transfer");
  assert.equal(inn.payment_method_id, "", "the money that arrived has no source in the app");
  assert.equal(inn.to_payment_method_id, second.id);
  assert.equal(Number(inn.amount), 2119.47);
  assert.equal(out.status, "confirmed");
  const sum = run(rt, `getPeriodSummary({ startDate: '2019-03-01', endDate: '2019-03-31' })`);
  assert.equal(sum.totals.expense, 0);
  assert.equal(sum.totals.income, 0);
  // Both lines are remembered, so a second upload offers nothing.
  assert.equal(plan(rt, stmts).summary.importable, 0);
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(made(rt).length, 0, "Undo removes both legs");
});

test("an exchange needs different currencies and the right directions", () => {
  const { rt, savingsStmt } = setup();
  const stmt = { ...savingsStmt, lines: [{ date: "2019-03-02", description: "A", amount: -10, currency: "PEN" }, { date: "2019-03-02", description: "B", amount: 10, currency: "PEN" }] };
  assert.throws(() => save(rt, [stmt], [{ type: "record_exchange", out: { stmt: 0, line: 0 }, in: { stmt: 0, line: 1 } }], false), /currency exchange/i);
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

test("the plan carries the balance checks, with the account's name, and nothing sets a balance by itself", () => {
  const { rt, savings, savingsStmt, cardStmt } = setup();
  const p = plan(rt, [savingsStmt, cardStmt]);
  assert.ok(Array.isArray(p.balance_checks) && p.balance_checks.length >= 1, "one check per statement and currency");
  const c = p.balance_checks.find((x) => x.stmt === 0 && x.currency === "PEN");
  assert.ok(c, "the savings statement has a check");
  assert.equal(c.accountName, savings.nickname);
  assert.equal(c.closing, 1000);
  assert.ok(!p.actions.some((a) => a.type === "set_balance"));
});

test("a balance chosen on the plan is set with the batch, and Undo restores it", () => {
  const { rt, savingsStmt, cardStmt } = setup();
  const stmts = [savingsStmt, cardStmt];
  const p = plan(rt, stmts);
  const c = p.balance_checks.find((x) => x.stmt === 0 && x.currency === "PEN");
  assert.ok(c.canSet);
  const openings = () => run(rt, "getAllRows('Account Opening Balances').map(function (r) { return r.id + ':' + r.amount + ':' + r.date; }).sort()");
  const before = openings();
  const action = c.direction === "forward" && typeof c.unexplained === "number"
    ? { type: "set_balance", stmt: c.stmt, currency: c.currency, gap: c.unexplained, app_balance: c.appAtEnd }
    : { type: "set_balance", stmt: c.stmt, currency: c.currency };
  const res = save(rt, stmts, p.actions.concat([action]), false);
  assert.equal(res.balancesSet.length, 1);
  assert.equal(res.balancesSet[0].amount, 1000);
  assert.notDeepEqual(openings(), before);
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.deepEqual(openings(), before);
});
