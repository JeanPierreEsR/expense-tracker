// Regression tests for the loan / forgiveness / entry-split fixes (2026-10-05).
// They run the REAL backend code against the fake Google layer + made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

// A friend-shared expense that I paid: creates entry + split + loan via the real API.
function sharedExpense(rt, data, amount = 100, share = 40) {
  // A brand-new friend: the seeded friends already have years of loans, and
  // repayments are applied oldest-loan-first, so they'd land on those instead.
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  const cat = data.cats.find((c) => c.type === "expense");
  const entry = rt.api("createEntry", {
    type: "expense", date: today(), amount, currency: "PEN", category_id: cat.id,
    description: "Test dinner", paid_by: "me", payment_method_id: data.pms[3].id
  });
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: share }] });
  return { entry, friend, cat };
}
const loansFor = (rt, entryId) => rt.rows("Loans").filter((l) => l.entry_id === entryId);

test("shared expense creates exactly one loan", () => {
  const { rt, data } = freshApp();
  const { entry } = sharedExpense(rt, data);
  const loans = loansFor(rt, entry.id);
  assert.equal(loans.length, 1);
  assert.equal(Number(loans[0].amount), 40);
});

test("editing a shared expense AFTER a partial repayment does not double the debt", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = sharedExpense(rt, data, 100, 40);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, date: today(), currency: "PEN", payment_method_id: data.pms[3].id });

  // edit the split to 50 and save again (what the app does on every save)
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 50 }] });

  const loans = loansFor(rt, entry.id);
  assert.equal(loans.length, 1, "must still be ONE loan for this entry, not old + new");
  assert.equal(Number(loans[0].amount), 50);
  const settled = rt.rows("Settlements").filter((s) => s.loan_id === loans[0].id).reduce((a, s) => a + Number(s.amount), 0);
  assert.equal(settled, 10, "the repayment is still attached to the same loan");
});

test("a repaid loan whose friend leaves the split is kept but unlinked", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = sharedExpense(rt, data, 100, 40);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, date: today(), currency: "PEN", payment_method_id: data.pms[3].id });
  const loanId = loansFor(rt, entry.id)[0].id;

  rt.api("saveEntrySplits", { entryId: entry.id, splits: [] });

  assert.equal(loansFor(rt, entry.id).length, 0, "no longer linked to the entry");
  const kept = rt.rows("Loans").find((l) => l.id === loanId);
  assert.ok(kept, "loan row (with its repayment history) still exists");
});

test("forgiving a loan books an expense and links it", () => {
  const { rt, data } = freshApp();
  const { entry, friend, cat } = sharedExpense(rt, data, 100, 40);
  const loan = loansFor(rt, entry.id)[0];
  const before = rt.rows("Entries").length;

  const res = rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: cat.id, date: today() });

  assert.equal(res.entry.type, "expense");
  assert.equal(Number(res.entry.amount), 40);
  assert.equal(rt.rows("Entries").length, before + 1);
  const after = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.equal(after.status, "forgiven");
  assert.equal(after.forgiveness_entry_id, res.entry.id, "loan points at the booked expense");
});

test("forgiving ignores the old 'don't convert' opt-out — the balance is still booked", () => {
  const { rt, data } = freshApp();
  const { entry, cat } = sharedExpense(rt, data);
  const loan = loansFor(rt, entry.id)[0];
  const res = rt.api("forgiveLoan", { id: loan.id, convert: false, category_id: cat.id, date: today() });
  assert.ok(res.entry, "an entry was created even though convert was false");
});

test("forgiving with a missing category fails WITHOUT marking the loan forgiven", () => {
  const { rt, data } = freshApp();
  const { entry } = sharedExpense(rt, data);
  const loan = loansFor(rt, entry.id)[0];
  assert.throws(() => rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: "", date: today() }), /category/i);
  assert.notEqual(rt.rows("Loans").find((l) => l.id === loan.id).status, "forgiven");
});

test("editing the shared expense after forgiving does not resurrect the debt", () => {
  const { rt, data } = freshApp();
  const { entry, friend, cat } = sharedExpense(rt, data, 100, 40);
  const loan = loansFor(rt, entry.id)[0];
  rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: cat.id, date: today() });

  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 40 }] });

  const loans = loansFor(rt, entry.id);
  assert.equal(loans.length, 1, "still one loan, not forgiven + a new outstanding one");
  assert.equal(loans[0].status, "forgiven");
  const outstanding = rt.rows("Loans").filter((l) => l.entry_id === entry.id && l.status !== "forgiven");
  assert.equal(outstanding.length, 0);
});

test("deleting the entry a forgiveness booked reopens the loan", () => {
  const { rt, data } = freshApp();
  const { entry, cat } = sharedExpense(rt, data);
  const loan = loansFor(rt, entry.id)[0];
  const res = rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: cat.id, date: today() });

  const links = rt.api("getEntryRepaymentLinks", { id: res.entry.id });
  assert.ok(links.forgiveness, "the delete confirm can warn about it");
  const out = rt.api("discardEntry", { id: res.entry.id });

  assert.equal(out.undone_forgiveness, true);
  assert.equal(rt.rows("Entries").find((e) => e.id === res.entry.id), undefined);
  const reopened = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.equal(reopened.status, "outstanding");
  assert.equal(reopened.forgiveness_entry_id, "");
});

test("forgiving a debt I owed books INCOME", () => {
  const { rt, data } = freshApp();
  const friend = data.friends[1];
  const incomeCat = data.cats.find((c) => c.type === "income");
  const loan = rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 75, currency: "PEN", date: today(), payment_method_id: data.pms[3].id });
  const res = rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: incomeCat.id, date: today() });
  assert.equal(res.entry.type, "income");
  assert.equal(Number(res.entry.amount), 75);
});

const loansOf = (rt, friendId) => rt.rows("Loans").filter((l) => l.friend_id === friendId);
const repay = (rt, data, friend, amount) =>
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount, date: today(), currency: "PEN", payment_method_id: data.pms[3].id });

test("deleting an expense whose loan was repaid turns the repayment into a loan I owe", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = sharedExpense(rt, data, 100, 40);
  repay(rt, data, friend, 30);

  const links = rt.api("getEntryRepaymentLinks", { id: entry.id });
  assert.equal(links.refunds.length, 1);
  assert.equal(links.refunds[0].total, 30);

  rt.api("discardEntry", { id: entry.id });

  const loans = loansOf(rt, friend.id);
  assert.equal(loans.length, 1, "the repaid loan is gone, one refund loan replaces it");
  assert.equal(loans[0].direction, "i_owe_them");
  assert.equal(Number(loans[0].amount), 30);
  assert.equal(loans[0].origin, "cash");
  assert.equal(rt.rows("Settlements").some((s) => s.loan_id === loans[0].id), false);
  // it can be deleted like any cash loan (no repayment against it)
  rt.api("deleteLoan", { id: loans[0].id });
  assert.equal(loansOf(rt, friend.id).length, 0);
});

test("a refund loan cancels against a later loan with the same friend", () => {
  const { rt, data } = freshApp();
  const { entry, friend, cat } = sharedExpense(rt, data, 100, 40);
  repay(rt, data, friend, 40);
  rt.api("discardEntry", { id: entry.id });

  const e2 = rt.api("createEntry", { type: "expense", date: today(), amount: 50, currency: "PEN", category_id: cat.id, description: "Lunch", paid_by: "me", payment_method_id: data.pms[3].id });
  rt.api("saveEntrySplits", { entryId: e2.id, splits: [{ friend_id: friend.id, amount: 25 }] });
  repay(rt, data, friend, 0.01);   // the next repayment writes the offset between the two loans

  const open = loansOf(rt, friend.id).map((l) => (l.direction === "they_owe_me" ? 1 : -1) * (Number(l.amount) - rt.rows("Settlements").filter((s) => s.loan_id === l.id).reduce((a, s) => a + Number(s.amount), 0)));
  assert.ok(Math.abs(open.reduce((a, b) => a + b, 0) - (25 - 40)) < 0.02, "net = 25 owed to me minus 40 refund (± the 1-cent test repayment)");
});

test("deleting an expense with an unpaid loan just deletes the loan", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = sharedExpense(rt, data, 100, 40);
  rt.api("discardEntry", { id: entry.id });
  assert.equal(loansOf(rt, friend.id).length, 0);
});
