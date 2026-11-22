// A bank loan from before the app (owner, 2026-11-08): no money entry, no account, only what is still owed, and the bank's own
// installment numbering ("7 of 24"). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function app() {
  const { rt, data } = freshApp({ entries: 5 });
  return { rt, pm: data.pms[3] };
}
const rows = (from, n) => Array.from({ length: n }, (_, i) => ({
  due_date: `2031-${String(((from + i - 1) % 12) + 1).padStart(2, "0")}-05`.replace(/^2031-(\d\d)/, (m, mm) => `${2031 + Math.floor((from + i - 1) / 12)}-${mm}`),
  principal: 100, interest: 5, fees: 1
}));

test("from before the app: no money entry, no account, numbering kept, count is the bank's", () => {
  const { rt, pm } = app();
  assert.equal(rt.api("getMeta").capabilities.bankOpening, true);
  const entriesBefore = rt.rows("Entries").length;
  const res = rt.api("saveBankLoan", {
    friend_name: "Old Bank", amount: 300, currency: "PEN", date: "2030-06-05", payment_method_id: pm.id, description: "Old loan",
    opening: true, first_number: 7, installments: rows(1, 3)
  });
  assert.equal(rt.rows("Entries").length, entriesBefore, "no money entry for a loan from before the app");
  const loan = rt.rows("Loans").find((l) => l.id === res.loan.id);
  assert.equal(String(loan.opening), "1");
  assert.equal(loan.payment_method_id || "", "", "no account");
  assert.deepEqual(res.installments.map((r) => r.number), [7, 8, 9]);
  const sched = rt.api("getLoanSchedule", { loan_id: res.loan.id });
  assert.equal(sched.loan.opening, true);
  assert.equal(sched.remaining_principal, 300);
  // paying the first one says "7 of 9" (the last number on file), like the bank's papers
  const first = sched.installments[0];
  const paid = rt.api("recordInstallment", { id: first.id, date: "2031-01-05", payment_method_id: pm.id, category_id: rt.api("getMeta").categories.find((c) => c.type === "expense").id });
  const transfer = rt.rows("Entries").find((e) => e.id === paid.transfer_entry_id);
  assert.match(transfer.description, /7/);
  assert.match(transfer.description, /9/);
  assert.ok(!/ 3\b/.test(transfer.description), "not '7 of 3'");
});

test("editing the schedule of a loan from before the app keeps the numbering", () => {
  const { rt } = app();
  const res = rt.api("saveBankLoan", { friend_name: "Old Bank 2", amount: 200, currency: "PEN", date: "2030-06-05", opening: true, first_number: 5, installments: rows(1, 2) });
  const sched = rt.api("saveLoanSchedule", { loan_id: res.loan.id, installments: rows(1, 4).map((r) => ({ ...r, principal: 50 })) });
  assert.deepEqual(sched.installments.map((r) => r.number), [5, 6, 7, 8]);
});

test("an ordinary bank loan still starts at 1 with its money entry", () => {
  const { rt, pm } = app();
  const res = rt.api("saveBankLoan", { friend_name: "New Bank", amount: 200, currency: "PEN", date: "2031-01-02", payment_method_id: pm.id, installments: rows(2, 2) });
  assert.deepEqual(res.installments.map((r) => r.number), [1, 2]);
  assert.ok(res.loan.transfer_entry_id, "the money arrived in an account");
});
