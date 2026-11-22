// The standalone-loan and bank-loan practices: one cleanup call (removePracticeLoans), silent side effects, capability. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

const mkBank = (rt, data, over = {}) => rt.api("saveBankLoan", {
  friend_name: "Practice Bank", amount: 300, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "Practice bank loan",
  installments: [
    { due_date: "2099-01-05", principal: 100, interest: 10, fees: 2 },
    { due_date: "2099-02-05", principal: 100, interest: 7, fees: 2 },
    { due_date: "2099-03-05", principal: 100, interest: 4, fees: 2 }
  ],
  ...over
});

test("the capability is on", () => {
  const { rt } = freshApp({ small: true });
  assert.equal(rt.api("getMeta").capabilities.practiceLoansMore, true);
});

test("a standalone practice loan is removed with its money entry; the friend the practice added goes too; real loans stay", () => {
  const { rt, data } = freshApp({ small: true });
  const real = rt.api("addFriend", { name: "Real Pal " + Math.random().toString(36).slice(2, 6) });
  const realLoan = rt.api("addLoan", { friend_id: real.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "Lunch money" });
  const added = rt.api("addFriend", { name: "Practice Pal " + Math.random().toString(36).slice(2, 6) });
  const entriesBefore = rt.rows("Entries").length;
  const loan = rt.api("addLoan", { friend_id: added.id, direction: "i_owe_them", amount: 50, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, description: "Practice loan" });
  const es = rt.api("addLoan", { friend_id: added.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: today(), description: "Préstamo de práctica", opening: true });
  assert.equal(rt.rows("Entries").length, entriesBefore + 1, "the loan's own movement (the opening one makes none)");
  const res = rt.api("removePracticeLoans", { started_on: today(), delete_friend_ids: [added.id] });
  assert.equal(res.loans, 2);
  assert.deepEqual(res.friends_deleted, [added.id]);
  assert.equal(rt.rows("Entries").length, entriesBefore);
  const loans = rt.rows("Loans").map((l) => l.id);
  assert.ok(!loans.includes(loan.id) && !loans.includes(es.id));
  assert.ok(loans.includes(realLoan.id), "a real loan stays");
  assert.ok(rt.rows("Friends").some((f) => f.id === real.id), "a real friend stays");
  assert.equal(rt.api("removePracticeLoans", { delete_friend_ids: [added.id] }).loans, 0, "a repeat is harmless");
});

test("a friend the practice did not add (not in the list) is never deleted; one in use is kept", () => {
  const { rt, data } = freshApp({ small: true });
  const f = rt.api("addFriend", { name: "Old Friend " + Math.random().toString(36).slice(2, 6) });
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 10, currency: "PEN", date: today(), description: "Real", payment_method_id: data.pms[3].id });
  const res = rt.api("removePracticeLoans", { started_on: today(), delete_friend_ids: [] });
  assert.deepEqual(res.friends_deleted, []);
  const used = rt.api("removePracticeLoans", { started_on: today(), delete_friend_ids: [f.id] });
  assert.deepEqual(used.friends_deleted, [], "in use: refused, the call still succeeds");
  assert.ok(rt.rows("Friends").some((x) => x.id === f.id));
});

test("a bank practice loan with one installment recorded: loan, schedule, repayment, both entries and the lender are all gone", () => {
  const { rt, data } = freshApp({ small: true });
  const entriesBefore = rt.rows("Entries").length, friendsBefore = rt.rows("Friends").length, settlBefore = rt.rows("Settlements").length;
  const { loan, installments } = mkBank(rt, data);
  rt.api("recordInstallment", { id: installments[0].id, date: today(), payment_method_id: data.pms[3].id });
  assert.equal(rt.rows("Entries").length, entriesBefore + 3, "loan received, installment movement, interest + fees expense");
  const res = rt.api("removePracticeLoans", { started_on: today(), delete_friend_ids: [] });
  assert.equal(res.loans, 1);
  assert.equal(res.friends_deleted.length, 1, "the Practice Bank lender is removed without being passed");
  assert.equal(rt.rows("Entries").length, entriesBefore);
  assert.equal(rt.rows("Friends").length, friendsBefore);
  assert.equal(rt.rows("Settlements").length, settlBefore);
  assert.equal(rt.rows("Loan Installments").filter((r) => r.loan_id === loan.id).length, 0);
});

test("after the person deleted the bank loan themselves (cancel), the interest + fees expense that stays is swept; the Spanish names work", () => {
  const { rt, data } = freshApp({ small: true });
  const entriesBefore = rt.rows("Entries").length;
  const { loan, installments } = mkBank(rt, data, { friend_name: "Banco de práctica", description: "Préstamo bancario de práctica" });
  rt.api("recordInstallment", { id: installments[0].id, date: today(), payment_method_id: data.pms[3].id });
  rt.api("deleteLoan", { id: loan.id, repayments: "cancel" });
  assert.equal(rt.rows("Entries").length, entriesBefore + 1, "the expense for the interest and fees is still on record");
  const res = rt.api("removePracticeLoans", { started_on: today() });
  assert.equal(res.entries, 1);
  assert.equal(rt.rows("Entries").length, entriesBefore);
  assert.equal(res.friends_deleted.length, 1);
});

test("real entries are never deleted: older ones with the same text, other text, a real bank", () => {
  const { rt, data } = freshApp({ small: true });
  const cat = data.cats.find((c) => c.type === "expense");
  const mk = (description, date) => rt.api("createEntry", { type: "expense", date, amount: 9, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: data.pms[3].id });
  const old = mk("Practice loan", "2020-01-01");
  const other = mk("Installment 1/3: Car loan", today());
  const near = mk("Interest and fees, installment 1/3: Practice bank loan extra", today());
  const bank = rt.api("saveBankLoan", { friend_name: "Real Bank", amount: 100, currency: "PEN", date: today(), description: "Car loan", installments: [{ due_date: "2099-01-01", principal: 100, interest: 5, fees: 0 }] });
  rt.api("removePracticeLoans", { started_on: today(), delete_friend_ids: [] });
  const ids = rt.rows("Entries").map((e) => e.id);
  [old, other, near].forEach((e) => assert.ok(ids.includes(e.id), e.description + " stays"));
  assert.ok(rt.rows("Loans").some((l) => l.id === bank.loan.id), "a real bank loan stays");
  assert.ok(rt.rows("Friends").some((f) => f.name === "Real Bank"));
});

test("a practice loan left overdue never raises a notice or a reminder; a real overdue loan still does", () => {
  const { rt } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");   // the seed's own budgets can be over their limit on some days (its dates follow the clock): these tests are about the practice loans only
  rt.svc.props.set("FEATURES", "base");
  linkTelegram(rt);
  const friend = rt.rows("Friends")[0];
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2020-01-01", due_date: "2020-02-01", description: "Practice loan" });
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2020-01-01", due_date: "2020-02-01", description: "Préstamo bancario de práctica" });
  let out = rt.api("checkAlertsNow");
  assert.deepEqual(out.notices, [], "no notice for the practice loans");
  assert.equal(rt.svc.fetchLog.length, 0, "and nothing sent to Telegram");
  const detail = rt.api("getFriendLoanDetail", { friendId: friend.id });
  assert.ok(detail.filter((l) => /ractic/.test(l.description)).every((l) => l.overdue === false), "not shown as overdue either");
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 70, currency: "PEN", date: "2020-01-01", due_date: "2020-02-01", description: "Real one" });
  rt.svc.props.set("ALERT_CHECK_LAST_AT", String(Date.now() - 3 * 60 * 1000));
  out = rt.api("checkAlertsNow");
  assert.equal(out.notices.length, 1, "the real overdue loan alerts");
  assert.ok(rt.svc.fetchLog.length >= 1, "and reaches Telegram (so the silence above is the practice rule, not a broken link)");
});

test("recording an installment on a practice bank loan sends nothing to Telegram and leaves the interest + fees entry waiting (no category, no budget)", () => {
  const { rt, data } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");   // the seed's own budgets can be over their limit on some days (its dates follow the clock): these tests are about the practice loans only
  linkTelegram(rt);
  const sentBefore = rt.svc.fetchLog.length;
  const { installments } = mkBank(rt, data);
  const r = rt.api("recordInstallment", { id: installments[0].id, date: today(), payment_method_id: data.pms[3].id });
  const extra = rt.rows("Entries").find((e) => e.id === r.extra_entry_id);
  assert.equal(extra.status, "pending");
  assert.equal(extra.category_id, "");
  assert.equal(rt.svc.fetchLog.length, sentBefore);
  rt.api("checkAlertsNow");
  assert.equal(rt.svc.fetchLog.length, sentBefore, "the alert checks stay quiet too");
});

test("the person deleted the bank loan with 'keep the repayments': the refund loan the app makes is removed too, with the lender", () => {
  const { rt, data } = freshApp({ small: true });
  const entriesBefore = rt.rows("Entries").length, loansBefore = rt.rows("Loans").length, friendsBefore = rt.rows("Friends").length;
  const { loan, installments } = mkBank(rt, data);
  rt.api("recordInstallment", { id: installments[0].id, date: today(), payment_method_id: data.pms[3].id });
  rt.api("deleteLoan", { id: loan.id, repayments: "keep" });
  assert.equal(rt.rows("Loans").length, loansBefore + 1, "the refund loan");
  const res = rt.api("removePracticeLoans", { started_on: today() });
  assert.equal(res.loans, 1);
  assert.equal(rt.rows("Loans").length, loansBefore);
  assert.equal(rt.rows("Entries").length, entriesBefore);
  assert.equal(rt.rows("Friends").length, friendsBefore);
});
