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

test("history: a repayment shows the full amount that arrived, and what no longer sits on a loan", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const keep = cashLoan(rt, data, friend, 100, "2026-01-01");
  const gone = cashLoan(rt, data, friend, 300, "2026-02-01");
  repay(rt, data, friend, 250);   // 100 on `keep`, 150 on `gone`: one money movement of 250

  rt.api("deleteLoan", { id: gone.id, repayments: "keep" });   // the 150 stays as a refund loan, the money movement stays 250

  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  assert.equal(h.repayments.length, 1);
  const r = h.repayments[0];
  assert.equal(r.amount, 250, "the money that really arrived");
  assert.equal(r.applied, 100, "what loans still hold");
  assert.equal(r.unapplied, 150);
  assert.deepEqual(r.parts.map((p) => p.amount), [100]);

  // re-pointing works on the part loans hold, never on the refund
  const other = cashLoan(rt, data, friend, 500, "2026-03-01");
  rt.api("reassignRepayment", { id: rt.rows("Settlements").find((s) => s.loan_id === keep.id).id, loan_ids: [other.id] });
  assert.equal(paidOn(rt, other.id), 100);
  assert.equal(rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].unapplied, 150);
});

test("an automatic cancel-out can be undone from either half: both loans owe again", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const owed = cashLoan(rt, data, friend, 50);
  const refund = rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "Refund" });
  repay(rt, data, friend, 0.01);   // writes the cancel-out pair between the two loans
  const status = (id) => rt.rows("Loans").find((l) => l.id === id).status;
  assert.equal(status(refund.id), "repaid");
  const half = rt.rows("Settlements").find((s) => s.loan_id === refund.id && s.offset_loan_id);

  const out = rt.api("undoCancelOut", { id: half.id });

  assert.equal(out.both, true);
  assert.equal(rt.rows("Settlements").some((s) => s.offset_loan_id && [owed.id, refund.id].includes(s.loan_id)), false, "both halves gone");
  assert.equal(status(refund.id), "outstanding");
  assert.equal(status(owed.id), "partially_repaid", "still holds the 0.01 real repayment");
  assert.throws(() => rt.api("undoCancelOut", { id: rt.rows("Settlements").find((s) => s.loan_id === owed.id && !s.offset_loan_id).id }), "a real repayment is not a cancel-out");
});

test("undoing the cancel-out of a refund loan reopens room, so a repayment can then be moved onto that loan", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const bao = cashLoan(rt, data, friend, 457, "2026-09-01");
  const sar = cashLoan(rt, data, friend, 171.32, "2026-09-10");
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 301.56, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "Refund" });
  repay(rt, data, friend, 0.01);   // the oldest open loan (Bao) is canceled out against the refund: 301.56 of its room is used up
  assert.equal(paidOn(rt, bao.id), 301.57);
  // a repayment of 171.32 that the person assigned entirely to Sarcletti
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 171.32, date: today(), currency: "PEN", payment_method_id: data.pms[3].id, allocations: [{ loan_id: sar.id, amount: 171.32 }] });
  const onSar = () => rt.rows("Settlements").find((s) => s.loan_id === sar.id && !s.offset_loan_id);

  // Bao has only 155.43 of room, so moving the repayment onto Bao alone still leaves part on Sarcletti
  rt.api("reassignRepayment", { id: onSar().id, loan_ids: [bao.id] });
  assert.ok(paidOn(rt, sar.id) > 15, "the rest had nowhere else to go");

  // undo the cancel-out: Bao has room again, and the whole repayment fits on it
  const half = rt.rows("Settlements").find((s) => s.loan_id === bao.id && s.offset_loan_id);
  rt.api("undoCancelOut", { id: half.id });
  rt.api("reassignRepayment", { id: onSar().id, loan_ids: [bao.id] });
  assert.equal(paidOn(rt, sar.id), 0, "Sarcletti is free of it");
  assert.ok(Math.abs(paidOn(rt, bao.id) - (0.01 + 171.32)) < 0.005);
});

// ---- "Paid earlier, no loan": wording, flag, and applying it to a loan ----
test("a payment kept from a deleted loan is worded 'Paid earlier, no loan' and remembers its repayment", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  cashLoan(rt, data, friend, 164.14, "2026-09-17");
  const bao = cashLoan(rt, data, friend, 457, "2026-09-22");
  repay(rt, data, friend, 465.70);   // 164.14 on the first loan, 301.56 on Bao

  rt.api("deleteLoan", { id: bao.id, repayments: "keep" });

  const held = loansOf(rt, friend.id).find((l) => l.direction === "i_owe_them");
  assert.match(held.description, /^Paid earlier, no loan: Cash loan 457 \(deleted\)\. .* had paid PEN 301\.56$/);
  const sources = JSON.parse(held.unapplied_sources);
  assert.equal(Object.keys(sources).length, 1, "tied to the one repayment it came from");
  assert.equal(Object.values(sources)[0], 301.56);
});

test("'Apply to a loan' attaches the payment to the selected loans and the history shows it applied again", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  cashLoan(rt, data, friend, 164.14, "2026-09-17");
  const bao = cashLoan(rt, data, friend, 457, "2026-09-22");
  repay(rt, data, friend, 465.70);
  rt.api("deleteLoan", { id: bao.id, repayments: "keep" });
  const newBao = cashLoan(rt, data, friend, 457, "2026-09-22");   // re-registered
  const held = loansOf(rt, friend.id).find((l) => l.direction === "i_owe_them");
  assert.equal(rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].unapplied, 301.56);

  const out = rt.api("applyUnappliedPayment", { id: held.id, loan_ids: [newBao.id] });

  assert.equal(out.applied, 301.56);
  assert.equal(paidOn(rt, newBao.id), 301.56);
  assert.equal(loansOf(rt, friend.id).some((l) => l.id === held.id), false, "nothing left, so the 'paid earlier' loan is gone");
  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  assert.equal(h.repayments.length, 1, "still one repayment of 465.70");
  assert.equal(h.repayments[0].amount, 465.70);
  assert.equal(h.repayments[0].unapplied, 0);
});

test("applying only part leaves the rest as 'paid earlier'; a loan with room is required", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const bao = cashLoan(rt, data, friend, 300, "2026-09-22");
  repay(rt, data, friend, 300);
  rt.api("deleteLoan", { id: bao.id, repayments: "keep" });
  const small = cashLoan(rt, data, friend, 100, "2026-10-01");
  const held = loansOf(rt, friend.id).find((l) => l.direction === "i_owe_them");

  const out = rt.api("applyUnappliedPayment", { id: held.id, loan_ids: [small.id] });

  assert.equal(out.applied, 100);
  assert.equal(out.left, 200);
  assert.equal(Number(rt.rows("Loans").find((l) => l.id === held.id).amount), 200);
  assert.throws(() => rt.api("applyUnappliedPayment", { id: held.id, loan_ids: [small.id] }), "the loan is full now");
  assert.throws(() => rt.api("applyUnappliedPayment", { id: small.id, loan_ids: [] }), "an ordinary loan is not a payment");
});

test("a 'Refund:' loan made by an earlier release is reworded and matched to its repayment", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  cashLoan(rt, data, friend, 164.14, "2026-09-17");
  const bao = cashLoan(rt, data, friend, 457, "2026-09-22");
  repay(rt, data, friend, 465.70);
  // what the earlier release left: Bao and its repayment rows gone, a plain "Refund: …" loan, no flag column yet
  rt.run(`deleteRowsWhere_('Settlements', function (s) { return s.loan_id === ${JSON.stringify(bao.id)}; }); deleteRowsWhere_('Loans', function (l) { return l.id === ${JSON.stringify(bao.id)}; });`);
  rt.run(`appendRowObject('Loans', { id: 'old-refund', friend_id: ${JSON.stringify(friend.id)}, direction: 'i_owe_them', origin: 'cash', entry_id: '', amount: 301.56, currency: 'PEN', date: '2026-10-27', due_date: '', payment_method_id: '', description: 'Refund: Taxi ride was deleted, Ana Lo* had repaid PEN 301.56', status: 'outstanding', transfer_entry_id: '' })`);

  const loans = rt.api("getFriendLoanDetail", { friendId: friend.id });   // first read creates the column and upgrades the row

  const old = loans.find((l) => l.id === "old-refund");
  assert.equal(old.description, "Paid earlier, no loan: Taxi ride (deleted). Ana Lo* had paid PEN 301.56");
  assert.equal(Object.keys(JSON.parse(old.unapplied_sources)).length, 1, "matched to the 465.70 repayment");
  const target = cashLoan(rt, data, friend, 400, "2026-09-22");
  rt.api("applyUnappliedPayment", { id: "old-refund", loan_ids: [target.id] });
  assert.equal(rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].unapplied, 0);
});

test("a recorded repayment can get a new amount and date from the history", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  const two = cashLoan(rt, data, friend, 200, "2026-02-01");
  repay(rt, data, friend, 150);
  const row = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  const tid = row.transfer_entry_id;

  rt.api("reassignRepayment", { id: row.id, loan_ids: [], amount: 180, date: "2026-03-05", payment_method_id: "" });

  assert.equal(paidOn(rt, one.id) + paidOn(rt, two.id), 180);
  const lines = rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amount, 180);
  assert.equal(lines[0].date, "2026-03-05");
  const te = rt.rows("Entries").find((e) => e.id === tid);
  assert.equal(Number(te.amount), 180, "the money movement follows");
  assert.equal(String(te.date).slice(0, 10), "2026-03-05");
  assert.throws(() => rt.api("reassignRepayment", { id: row.id, loan_ids: [], amount: 999 }), "more than the loans hold");
});

test("a 'paid earlier' loan is recognised even if the column already existed or its flag is missing", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  rt.api("getFriendLoanDetail", { friendId: friend.id });   // the column exists now, so no first-time upgrade will run
  const mk = (id, description) => rt.run(`appendRowObject('Loans', { id: ${JSON.stringify(id)}, friend_id: ${JSON.stringify(friend.id)}, direction: 'i_owe_them', origin: 'cash', entry_id: '', amount: 50, currency: 'PEN', date: '2026-10-27', due_date: '', payment_method_id: '', description: ${JSON.stringify(description)}, status: 'outstanding', transfer_entry_id: '' })`);
  mk("old-1", "Refund: Taxi ride was deleted, Ana Lo* had repaid PEN 50");   // no decimals
  mk("new-1", "Paid earlier, no loan: Lunch (deleted). Ana Lo* had paid PEN 50.00");   // new wording, flag missing
  const target = cashLoan(rt, data, friend, 100, "2026-09-22");

  const loans = rt.api("getFriendLoanDetail", { friendId: friend.id });
  assert.equal(loans.find((l) => l.id === "old-1").description, "Paid earlier, no loan: Taxi ride (deleted). Ana Lo* had paid PEN 50.00");
  assert.equal(loans.find((l) => l.id === "old-1").unapplied, true);
  assert.equal(loans.find((l) => l.id === "new-1").unapplied, true);
  assert.equal(loans.find((l) => l.id === target.id).unapplied, false);

  rt.api("applyUnappliedPayment", { id: "new-1", loan_ids: [target.id] });
  assert.equal(paidOn(rt, target.id), 50);
});

test("an old repayment with no entry can be recorded in the accounts, once", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const loan = cashLoan(rt, data, friend, 100, "2026-01-01");
  repay(rt, data, friend, 40);
  const row = rt.rows("Settlements").find((s) => s.loan_id === loan.id);
  const tid = row.transfer_entry_id;
  // make it look like one recorded before repayments had an entry
  rt.run(`deleteEntry_(${JSON.stringify(tid)}); var sh = getSheet('Settlements'); var h = getHeaders(sh); setCellByRow_(sh, h, findRowIndexById(sh, h, ${JSON.stringify(row.id)}), 'transfer_entry_id', '');`);
  assert.equal(rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].has_transfer_entry, false);

  const before = rt.rows("Entries").length;
  rt.api("recordRepaymentEntry", { id: row.id, date: "2026-09-18", payment_method_id: data.pms[3].id });

  const after = rt.rows("Settlements").find((s) => s.id === row.id);
  assert.ok(after.transfer_entry_id);
  assert.equal(rt.rows("Entries").length, before + 1);
  const te = rt.rows("Entries").find((e) => e.id === after.transfer_entry_id);
  assert.equal(Number(te.amount), 40);
  assert.equal(te.type, "transfer");
  assert.equal(String(te.date).slice(0, 10), "2026-09-18");
  assert.equal(rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].has_transfer_entry, true);
  assert.throws(() => rt.api("recordRepaymentEntry", { id: row.id }), "a second time");
});

test("'pay only the selected loans' leaves the others alone and records the gap as income", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  const two = cashLoan(rt, data, friend, 200, "2026-02-01");
  const three = cashLoan(rt, data, friend, 300, "2026-03-01");
  repay(rt, data, friend, 250);   // 100 on one, 150 on two
  const row = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  const tid = row.transfer_entry_id;
  const incomeCat = rt.rows("Categories").find((c) => c.type === "income").id;
  const entriesBefore = rt.rows("Entries").length;

  // only the 100 loan is selected: it takes 100, the other 150 is a gap
  rt.api("reassignRepayment", { id: row.id, loan_ids: [one.id], limit: true, overpay_category_id: incomeCat });

  assert.equal(paidOn(rt, one.id), 100);
  assert.equal(paidOn(rt, two.id), 0, "nothing spills onto the others");
  assert.equal(paidOn(rt, three.id), 0);
  const te = rt.rows("Entries").find((e) => e.id === tid);
  assert.equal(Number(te.amount), 100, "the money movement is what loans took");
  const created = rt.rows("Entries").slice(entriesBefore);
  const income = created.find((e) => e.type === "income");
  assert.ok(income, "the gap became income");
  assert.equal(Number(income.amount), 150);
  assert.equal(income.category_id, incomeCat);
  // without a category it waits in the review queue
  const row2 = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  rt.api("reassignRepayment", { id: row2.id, loan_ids: [one.id], limit: true, amount: 130 });
  assert.equal(rt.rows("Entries").filter((e) => e.type === "income" && e.status === "pending").length >= 1, true);
  assert.throws(() => rt.api("reassignRepayment", { id: row2.id, loan_ids: [], limit: true }), "nothing selected");
});

test("history: one loan paid in two pieces by the same repayment is one line, not two", () => {
  const { rt, data } = freshApp();
  const friend = newFriend(rt);
  const one = cashLoan(rt, data, friend, 100, "2026-01-01");
  const two = cashLoan(rt, data, friend, 100, "2026-02-01");
  repay(rt, data, friend, 150);   // 100 on one, 50 on two
  const row = rt.rows("Settlements").find((s) => s.loan_id === one.id);
  // a second piece on loan two with the same money movement (what "Apply to a loan" leaves behind)
  rt.run(`recordSettlementRow_(${JSON.stringify(two.id)}, '2026-03-01', 25, '', '', ${JSON.stringify(row.transfer_entry_id)})`);
  const line = rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0];
  assert.equal(line.parts.length, 2, "two loans, not three lines");
  assert.equal(line.parts.find((x) => x.loan_id === two.id).amount, 75);
});
