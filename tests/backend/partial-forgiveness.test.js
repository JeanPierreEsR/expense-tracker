// Forgiving only PART of a loan (owner's request, 2026-10-28). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup(direction = "they_owe_me", amount = 200) {
  const { rt, data } = freshApp();
  const pm = data.pms[3].id;
  const friend = rt.api("addFriend", { name: "Part Friend " + Math.random().toString(36).slice(2, 6) });
  const loan = rt.api("addLoan", { friend_id: friend.id, direction, amount, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const cat = (type) => data.cats.find((c) => c.type === type);
  const loanRow = () => rt.rows("Loans").find((l) => l.id === loan.id);
  const detail = () => rt.api("getFriendLoanDetail", { friendId: friend.id }).find((l) => l.id === loan.id);
  const forgive = (amt, extra = {}) => rt.api("forgiveLoan", { id: loan.id, amount: amt, category_id: cat(direction === "they_owe_me" ? "expense" : "income").id, date: today(), ...extra });
  return { rt, pm, friend, loan, cat, loanRow, detail, forgive };
}

test("forgiving part books that much as an expense and leaves the loan open for the rest", () => {
  const { rt, forgive, loanRow, detail } = setup();
  const res = forgive(50);
  assert.equal(res.partial, true);
  assert.equal(res.entry.type, "expense");
  assert.equal(Number(res.entry.amount), 50);
  assert.notEqual(loanRow().status, "forgiven");
  assert.equal(detail().remaining, 150);
  assert.equal(detail().forgiven_so_far, 50);
  assert.equal(Number(loanRow().amount), 200, "the loan's own amount never changes");
  assert.equal(rt.rows("Entries").filter((e) => e.description && /forgave/i.test(e.description)).length, 1);
});

test("a debt the owner owed is forgiven as income", () => {
  const { forgive } = setup("i_owe_them", 100);
  const res = forgive(30);
  assert.equal(res.entry.type, "income");
  assert.equal(Number(res.entry.amount), 30);
});

test("more than is owed is refused, and nothing is booked", () => {
  const { rt, forgive } = setup();
  const before = rt.rows("Entries").length;
  assert.throws(() => forgive(250), /more than is still owed/i);
  assert.throws(() => forgive(0), /amount/i);
  assert.equal(rt.rows("Entries").length, before);
});

test("several parts add up, and forgiving all that is left forgives the loan whole", () => {
  const { forgive, loanRow, detail } = setup();
  forgive(50); forgive(25);
  assert.equal(detail().remaining, 125);
  const last = forgive(125);
  assert.notEqual(last.partial, true);
  assert.equal(loanRow().status, "forgiven");
});

test("no amount means everything that is left, as before", () => {
  const { forgive, loanRow } = setup();
  const res = rt_noAmount(forgive);
  assert.equal(Number(res.entry.amount), 200);
  assert.equal(loanRow().status, "forgiven");
});
function rt_noAmount(forgive) { return forgive(undefined); }

test("repayments and forgiven parts together settle the loan", () => {
  const { rt, pm, friend, forgive, loanRow, detail } = setup();
  forgive(50);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: today(), payment_method_id: pm });
  assert.equal(detail().remaining, 50);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: pm });
  assert.equal(loanRow().status, "repaid");
});

test("a repayment larger than what is left is an overpayment: forgiven parts are not repayable again", () => {
  const { rt, pm, friend, forgive } = setup();
  forgive(150);
  const res = rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 80, currency: "PEN", date: today(), payment_method_id: pm, overpay_pending_ok: true });
  assert.ok(Math.abs(res.overpaid - 30) < 0.01, "50 left, 80 paid: 30 over");
});

test("deleting a part's entry undoes only that part", () => {
  const { rt, forgive, loanRow, detail } = setup();
  const a = forgive(50), b = forgive(25);
  rt.api("discardEntry", { id: a.entry.id });
  assert.equal(detail().forgiven_so_far, 25);
  assert.equal(detail().remaining, 175);
  assert.equal(JSON.parse(loanRow().forgiven_parts)[0].entry_id, b.entry.id);
  rt.api("discardEntry", { id: b.entry.id });
  assert.equal(detail().remaining, 200);
  assert.equal(loanRow().status, "outstanding");
});

test("undoing the final whole forgiveness keeps the earlier parts forgiven", () => {
  const { rt, forgive, loanRow, detail } = setup();
  forgive(50);
  const last = forgive(150);
  assert.equal(loanRow().status, "forgiven");
  rt.api("discardEntry", { id: last.entry.id });
  assert.notEqual(loanRow().status, "forgiven");
  assert.equal(detail().remaining, 150);
  assert.equal(detail().forgiven_so_far, 50);
});

test("a forgiveness entry cannot change type, whole or partial", () => {
  const { rt, forgive } = setup();
  const res = forgive(50);
  assert.throws(() => rt.api("updateEntry", { id: res.entry.id, fields: { type: "income" } }), /forgiven/i);
  assert.match(rt.api("getEntryRepaymentLinks", { id: res.entry.id }).forgiveness.friend, /Part Friend/);
  assert.equal(rt.api("getEntryRepaymentLinks", { id: res.entry.id }).forgiveness.partial, true);
});

test("the loan's amount cannot be edited below what is repaid plus forgiven", () => {
  const { rt, pm, loan, friend, forgive } = setup();
  forgive(80);
  assert.throws(() => rt.api("updateLoan", { id: loan.id, friend_id: friend.id, direction: "they_owe_me", amount: 70, currency: "PEN", date: "2026-01-01", payment_method_id: pm }), /repaid or forgiven/i);
});

test("a part forgiven on a loan from a shared expense keeps that loan when the expense is edited", () => {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Share Friend " + Math.random().toString(36).slice(2, 6) });
  const exp = rt.api("createEntry", { type: "expense", date: "2026-02-01", amount: 100, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "Dinner", payment_method_id: data.pms[3].id, paid_by: "me" });
  rt.api("saveEntrySplits", { entryId: exp.id, splits: [{ friend_id: f.id, amount: 40 }] });
  const loan = rt.rows("Loans").find((l) => l.entry_id === exp.id);
  rt.api("forgiveLoan", { id: loan.id, amount: 10, category_id: data.cats.find((c) => c.type === "expense").id, date: today() });
  rt.api("saveEntrySplits", { entryId: exp.id, splits: [{ friend_id: f.id, amount: 40 }] });
  const after = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.ok(after, "the loan with a forgiven part is kept, not deleted and re-created");
});
