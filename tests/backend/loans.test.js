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

// ---- Choices when deleting a repaid loan / expense, and choosing which loan a repayment goes to ----
const cashLoan = (rt, data, friend, amount, date) =>
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount, currency: "PEN", date: date || today(), payment_method_id: data.pms[3].id, description: "Cash loan " + amount });
const newFriend = (rt) => rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
const transferEntryIds = (rt, loanId) => rt.rows("Settlements").filter((s) => s.loan_id === loanId && s.transfer_entry_id).map((s) => s.transfer_entry_id);

test("deleting a repaid cash loan is refused without a choice", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const loan = cashLoan(rt, data, friend, 50);
  repay(rt, data, friend, 20);
  assert.throws(() => rt.api("deleteLoan", { id: loan.id }));
  assert.equal(rt.api("getLoanDeleteInfo", { id: loan.id }).paid, 20);
});

test("deleting a repaid cash loan and cancelling its repayments removes both", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const loan = cashLoan(rt, data, friend, 50);
  repay(rt, data, friend, 20);
  const tid = transferEntryIds(rt, loan.id)[0];
  assert.ok(rt.rows("Entries").some((e) => e.id === tid));

  rt.api("deleteLoan", { id: loan.id, repayments: "cancel" });

  assert.equal(loansOf(rt, friend.id).length, 0, "no loan, no refund loan");
  assert.equal(rt.rows("Settlements").some((s) => s.loan_id === loan.id), false);
  assert.equal(rt.rows("Entries").some((e) => e.id === tid), false, "the repayment's money movement is cancelled too");
});

test("deleting a repaid cash loan but keeping the repayments leaves a refund loan", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const loan = cashLoan(rt, data, friend, 50);
  repay(rt, data, friend, 20);
  const tid = transferEntryIds(rt, loan.id)[0];

  rt.api("deleteLoan", { id: loan.id, repayments: "keep" });

  const loans = loansOf(rt, friend.id);
  assert.equal(loans.length, 1);
  assert.equal(loans[0].direction, "i_owe_them");
  assert.equal(Number(loans[0].amount), 20);
  assert.ok(rt.rows("Entries").some((e) => e.id === tid), "the money that really moved stays on record");
});

test("deleting a repaid loan with an auto-offset gives that offset back to the other loan", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const owedToMe = cashLoan(rt, data, friend, 50);
  const iOwe = rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "I owe" });
  repay(rt, data, friend, 0.01);   // writes the offset between the two loans
  assert.ok(rt.rows("Settlements").some((s) => s.loan_id === iOwe.id && s.offset_loan_id === owedToMe.id));

  rt.api("deleteLoan", { id: owedToMe.id, repayments: "cancel" });

  assert.equal(rt.rows("Settlements").some((s) => s.loan_id === iOwe.id && s.offset_loan_id), false, "the other loan owes its full amount again");
});

test("deleting a repaid expense can cancel the repayments instead of keeping them", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = sharedExpense(rt, data, 100, 40);
  repay(rt, data, friend, 30);
  const loanId = loansFor(rt, entry.id)[0].id;
  const tid = transferEntryIds(rt, loanId)[0];

  rt.api("discardEntry", { id: entry.id, repayments: "cancel" });

  assert.equal(loansOf(rt, friend.id).length, 0, "no refund loan");
  assert.equal(rt.rows("Entries").some((e) => e.id === tid), false);
});

// ---- Repayment history per person ----
test("repayment history lists every loan and repayment, also for a person who is fully repaid", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const a = cashLoan(rt, data, friend, 50, "2026-01-01");
  const b = cashLoan(rt, data, friend, 30, "2026-02-01");
  repay(rt, data, friend, 80);   // pays both, oldest first

  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  assert.equal(h.loans.length, 2);
  assert.equal(h.repayments.length, 1, "one repayment of 80, however many loans it paid");
  assert.equal(h.repayments[0].amount, 80);
  assert.deepEqual(h.repayments[0].parts.map((p) => p.amount).sort(), [30, 50], "listed under it: the loans it paid");
  assert.deepEqual(h.loans.map((l) => [l.amount, l.paid, l.remaining, l.status]).sort(), [[30, 30, 0, "repaid"], [50, 50, 0, "repaid"]]);
  assert.equal(h.repayments.every((r) => !r.is_offset && r.currency === "PEN"), true);
  assert.ok(a.id && b.id);
});

test("repayment history tells real repayments from automatic offsets", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const owed = cashLoan(rt, data, friend, 50);
  const iOwe = rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "I owe" });
  repay(rt, data, friend, 0.01);   // writes the offset pair between the two loans

  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  const offsets = h.repayments.filter((r) => r.is_offset);
  assert.equal(offsets.length, 2, "one offset line on each loan");
  const owedRow = h.loans.find((l) => l.id === owed.id);
  assert.equal(owedRow.offset, 30);
  assert.ok(Math.abs(owedRow.remaining - (50 - 30 - 0.01)) < 0.001);
  assert.ok(h.loans.find((l) => l.id === iOwe.id).offset === 30);
});

test("settled people are listed apart from people with a balance", () => {
  const { rt, data } = freshApp();
  const settled = newFriend(rt);
  cashLoan(rt, data, settled, 40);
  repay(rt, data, settled, 40);
  const open = newFriend(rt);
  cashLoan(rt, data, open, 40);
  const never = newFriend(rt);   // no loans at all: not listed

  const ids = rt.api("listSettledLoanFriends", {}).map((f) => f.friend_id);
  assert.ok(ids.includes(settled.id));
  assert.equal(ids.includes(open.id), false);
  assert.equal(ids.includes(never.id), false);
});

// ---- Changing which loans a recorded repayment paid ----
const paidOn = (rt, loanId) => rt.rows("Settlements").filter((s) => s.loan_id === loanId).reduce((a, s) => a + Number(s.amount), 0);

test("a whole repayment can be re-pointed at other loans", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  const two = cashLoan(rt, data, friend, 200, "2026-02-01");
  const three = cashLoan(rt, data, friend, 300, "2026-03-01");
  repay(rt, data, friend, 250);   // oldest first: 100 on one, 150 on two
  const row = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  assert.equal(paidOn(rt, two.id), 150);

  rt.api("reassignRepayment", { id: row.id, loan_ids: [three.id] });

  assert.equal(paidOn(rt, three.id), 250, "all of it on the selected loan");
  assert.equal(paidOn(rt, one.id), 0);
  assert.equal(paidOn(rt, two.id), 0);
  const status = (id) => rt.rows("Loans").find((l) => l.id === id).status;
  assert.deepEqual([status(one.id), status(two.id), status(three.id)], ["outstanding", "outstanding", "partially_repaid"]);
  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  assert.equal(h.repayments.length, 1);
  assert.equal(h.repayments[0].amount, 250, "still one repayment of 250");
  const mine = [one.id, two.id, three.id];
  const transfers = new Set(rt.rows("Settlements").filter((s) => mine.includes(s.loan_id)).map((s) => s.transfer_entry_id));
  assert.equal(transfers.size, 1, "the money movement is untouched");
});

test("selected loans are paid first, the rest goes to the oldest others", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  const two = cashLoan(rt, data, friend, 200, "2026-02-01");
  const three = cashLoan(rt, data, friend, 300, "2026-03-01");
  repay(rt, data, friend, 250);
  const mine = [one.id, two.id, three.id];
  const anyRow = () => rt.rows("Settlements").find((s) => mine.includes(s.loan_id));

  rt.api("reassignRepayment", { id: anyRow().id, loan_ids: [three.id] });   // 250 < 300: all fits on three
  rt.api("reassignRepayment", { id: anyRow().id, loan_ids: [two.id] });   // 200 on two, 50 to the oldest other (one)

  assert.equal(paidOn(rt, two.id), 200);
  assert.equal(paidOn(rt, one.id), 50);
  assert.equal(paidOn(rt, three.id), 0);
});

test("re-pointing a repayment that cannot fit changes nothing", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  repay(rt, data, friend, 100);
  const row = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  const other = newFriend(rt);
  const theirs = cashLoan(rt, data, other, 100);

  assert.throws(() => rt.api("reassignRepayment", { id: row.id, loan_ids: [theirs.id] }), "another person's loan");
  assert.equal(paidOn(rt, one.id), 100, "untouched");
  assert.equal(rt.rows("Loans").find((l) => l.id === one.id).status, "repaid");
});

test("an automatic cancel-out line cannot be re-pointed", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  cashLoan(rt, data, friend, 50);
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "I owe" });
  repay(rt, data, friend, 0.01);
  const offset = rt.rows("Settlements").find((s) => s.offset_loan_id);
  assert.throws(() => rt.api("reassignRepayment", { id: offset.id, loan_ids: [] }));
});
