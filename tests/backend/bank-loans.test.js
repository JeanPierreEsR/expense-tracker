// Personal bank loans: a loan the owner owes plus a schedule of installments entered by hand. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const make = (over = {}) => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const body = {
    friend_name: "Test Bank", amount: 300, currency: "PEN", date: "2026-01-05", payment_method_id: pm.id, description: "Personal loan",
    installments: [
      { due_date: "2026-02-05", principal: 100, interest: 10, fees: 2 },
      { due_date: "2026-03-05", principal: 100, interest: 7, fees: 2 },
      { due_date: "2026-04-05", principal: 100, interest: 4, fees: 2 }
    ],
    ...over
  };
  return { rt, data, pm, body };
};

test("a bank loan is a loan I owe with a schedule; the money received is not income", () => {
  const { rt, body } = make();
  const res = rt.api("saveBankLoan", body);
  assert.equal(res.loan.direction, "i_owe_them");
  assert.equal(Number(res.loan.amount), 300);
  assert.equal(res.installments.length, 3);
  assert.deepEqual(res.installments.map((r) => r.number), [1, 2, 3]);
  assert.equal(res.installments[0].total, 112);
  // the money received is the loan's own transfer entry, never an income
  const received = rt.rows("Entries").find((e) => e.id === res.loan.transfer_entry_id);
  assert.equal(received.type, "transfer");
  const sched = rt.api("getLoanSchedule", { loan_id: res.loan.id });
  assert.equal(sched.remaining_principal, 300);
  assert.deepEqual(sched.totals, { principal: 300, interest: 21, fees: 6 });
});

test("a schedule whose principal does not add up to the loan creates nothing", () => {
  const { rt, body } = make({ amount: 350 });
  const loansBefore = rt.rows("Loans").length;
  assert.throws(() => rt.api("saveBankLoan", body), /must add up/);
  assert.equal(rt.rows("Loans").length, loansBefore, "no loan was made");
  assert.throws(() => rt.api("saveBankLoan", { ...body, amount: 300, installments: [] }), /at least one installment/);
});

test("recording an installment: principal is a repayment, interest + fees are ONE linked expense", () => {
  const { rt, pm, body } = make();
  const { loan, installments } = rt.api("saveBankLoan", body);
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const entriesBefore = rt.rows("Entries").length;

  const res = rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id, category_id: cat });

  const created = rt.rows("Entries").slice(entriesBefore);
  const transfer = created.find((e) => e.type === "transfer");
  const expense = created.find((e) => e.type === "expense");
  assert.equal(Number(transfer.amount), 100, "the principal moves, as a transfer");
  assert.equal(Number(expense.amount), 12, "interest 10 + fees 2");
  assert.equal(expense.category_id, cat);
  assert.equal(res.installment.status, "paid");
  const sched = rt.api("getLoanSchedule", { loan_id: loan.id });
  assert.equal(sched.remaining_principal, 200);
  assert.deepEqual(sched.installments.map((r) => r.status).slice(0, 2), ["paid", "overdue"], "the next one is past due in this made-up calendar");
  // the repayment history shows ONE total with the expense as its extra
  const line = rt.api("getFriendRepaymentHistory", { friendId: loan.friend_id }).repayments[0];
  assert.equal(line.amount, 112);
  assert.equal(line.gap.type, "expense");
  assert.equal(line.gap.amount, 12);
  assert.equal(line.limited, true);
  assert.throws(() => rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-06" }), /already recorded/);
});

test("what the bank really charged can be typed over the schedule, and a zero-interest installment makes no expense entry", () => {
  const { rt, pm, body } = make();
  const { installments } = rt.api("saveBankLoan", body);
  const before = rt.rows("Entries").length;
  const res = rt.api("recordInstallment", { id: installments[1].id, date: "2026-03-05", payment_method_id: pm.id, interest: 0, fees: 0, principal: 100 });
  assert.equal(rt.rows("Entries").slice(before).filter((e) => e.type === "expense").length, 0);
  assert.equal(res.installment.total, 100);
  assert.throws(() => rt.api("recordInstallment", { id: installments[2].id, date: "2026-04-05", principal: 500 }), /more principal/);
});

test("cancelling the installment's repayment makes it due again; deleting the loan takes the schedule", () => {
  const { rt, pm, body } = make();
  const { loan, installments } = rt.api("saveBankLoan", body);
  const res = rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id });
  assert.equal(rt.api("getLoanSchedule", { loan_id: loan.id }).installments[0].paid, true);
  const line = rt.api("getFriendRepaymentHistory", { friendId: loan.friend_id }).repayments[0];
  rt.api("deleteRepayment", { id: line.id });   // the repayment is deleted as a whole from its screen: money entry and interest entry go too
  assert.equal(rt.api("getLoanSchedule", { loan_id: loan.id }).installments[0].paid, false);
  assert.equal(rt.rows("Entries").some((e) => e.id === res.transfer_entry_id || e.id === line.gap.entry_id), false);

  rt.api("deleteLoan", { id: loan.id });
  assert.equal(rt.rows("Loan Installments").filter((r) => r.loan_id === loan.id).length, 0);
});

test("editing the schedule keeps paid installments and replaces the rest", () => {
  const { rt, pm, body } = make();
  const { loan, installments } = rt.api("saveBankLoan", body);
  rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id });
  // 200 principal left: the bank re-issued it as two installments of 100 with new interest
  const sched = rt.api("saveLoanSchedule", { loan_id: loan.id, installments: [
    { due_date: "2026-03-10", principal: 100, interest: 6, fees: 2 },
    { due_date: "2026-04-10", principal: 100, interest: 3, fees: 2 }
  ] });
  assert.equal(sched.installments.length, 3);
  assert.equal(sched.installments[0].paid, true);
  assert.deepEqual(sched.installments.map((r) => r.number), [1, 2, 3]);
  assert.throws(() => rt.api("saveLoanSchedule", { loan_id: loan.id, installments: [{ due_date: "2026-03-10", principal: 150 }] }), /must add up/);
});

test("the person's screen is told which loans have a schedule, and what is next", () => {
  const { rt, pm, body } = make();
  const { loan, installments } = rt.api("saveBankLoan", body);
  rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id });
  const row = rt.api("getFriendLoanDetail", { friendId: loan.friend_id }).find((l) => l.id === loan.id);
  assert.equal(row.schedule.count, 3);
  assert.equal(row.schedule.paid, 1);
  assert.equal(row.schedule.next_due, "2026-03-05");
  assert.equal(row.schedule.next_total, 109);
});

test("a statement line for the installment total matches it (principal + interest + fees in one bank debit)", () => {
  const { rt, pm, body } = make();
  const { installments } = rt.api("saveBankLoan", body);
  rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id });
  const stmt = { key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-02-01", end: "2026-02-28" }, balances: { PEN: { closing: 1000 } }, file_name: "x.pdf",
    lines: [{ date: "2026-02-05", description: "CUOTA PRESTAMO", amount: -112, currency: "PEN" }] };
  const line = JSON.parse(rt.run(`JSON.stringify(analyzeStatements(${JSON.stringify({ statements: [stmt] })}))`)).statements[0].lines[0];
  assert.equal(line.status, "matched");
  assert.equal(line.viaRepayment, true);
});

test("early payment shortens the term by default: the last installments lose principal and rows empty out", () => {
  const { rt, pm, body } = make();
  const { loan, installments } = rt.api("saveBankLoan", body);
  rt.api("recordInstallment", { id: installments[0].id, date: "2026-02-05", payment_method_id: pm.id });   // 200 principal left in two installments
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const entriesBefore = rt.rows("Entries").length;

  const res = rt.api("recordEarlyPayment", { loan_id: loan.id, date: "2026-02-20", payment_method_id: pm.id, principal: 130, fee: 5, category_id: cat });

  const created = rt.rows("Entries").slice(entriesBefore);
  assert.equal(Number(created.find((e) => e.type === "transfer").amount), 130, "the principal is a repayment");
  assert.equal(Number(created.find((e) => e.type === "expense").amount), 5, "the fee is one expense");
  const rows = res.schedule.installments;
  assert.equal(rows.length, 2, "the paid one + the second (the last, 100, is gone and the second lost 30)");
  assert.equal(rows[1].number, 2);
  assert.equal(rows[1].principal, 70);
  assert.equal(res.schedule.remaining_principal, 70);
  assert.equal(rows[1].interest, 7, "a kept row keeps its interest and fees (typed over by hand if the bank says otherwise)");
});

test("early payment: the fee defaults to nothing, and paying everything removes the rest and repays the loan", () => {
  const { rt, pm, body } = make();
  const { loan } = rt.api("saveBankLoan", body);
  const before = rt.rows("Entries").length;
  const res = rt.api("recordEarlyPayment", { loan_id: loan.id, date: "2026-02-20", payment_method_id: pm.id, principal: 300 });
  assert.equal(rt.rows("Entries").slice(before).filter((e) => e.type === "expense").length, 0, "no fee, no expense entry");
  assert.equal(res.schedule.installments.length, 0);
  assert.equal(rt.rows("Loans").find((l) => l.id === loan.id).status, "repaid");
  assert.equal(res.schedule.remaining_principal, 0);
});

test("early payment can keep the term and shrink every unpaid installment instead", () => {
  const { rt, pm, body } = make();
  const { loan } = rt.api("saveBankLoan", body);
  const res = rt.api("recordEarlyPayment", { loan_id: loan.id, date: "2026-02-20", payment_method_id: pm.id, principal: 150, mode: "reduce" });
  const rows = res.schedule.installments;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.principal), [50, 50, 50]);
  assert.equal(rows[0].interest, 5, "interest shrinks in proportion (an estimate)");
  assert.throws(() => rt.api("recordEarlyPayment", { loan_id: loan.id, date: "2026-02-21", payment_method_id: pm.id, principal: 500 }), /more principal/);
  assert.throws(() => rt.api("recordEarlyPayment", { loan_id: loan.id, date: "2026-02-21", payment_method_id: pm.id, principal: 0 }), /how much principal/);
});
