// An investment deposit / withdrawal turned into a loan or repayment (entry-type conversions plan, step 6).
// The money direction decides: a deposit (left) is a loan given / repayment paid; a withdrawal (arrived) is a loan
// received / repayment received. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const tag = Math.random().toString(36).slice(2, 6);
  const pm = data.pms[3].id;
  const broker = rt.api("addPaymentMethod", { nickname: "Step6 Broker " + tag, type: "investment" });
  const friend = rt.api("addFriend", { name: "Step6 Friend " + tag });
  const invest = (amount) => rt.api("createEntry", { type: "investment", date: today(), amount, currency: "PEN", description: "Step6 invest", payment_method_id: pm, to_payment_method_id: broker.id, paid_by: "me" });
  const base = (entry, extra = {}) => ({ entry_id: entry.id, friend_id: friend.id, amount: Math.abs(entry.amount), currency: "PEN", date: today(), payment_method_id: pm, ...extra });
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  return { rt, data, pm, broker, friend, invest, base, row };
}

test("a deposit becomes a loan the owner gave: the investment is gone, the loan's entry is a plain transfer", () => {
  const { rt, invest, base, row } = setup();
  const dep = invest(100);
  const res = rt.api("convertEntryToLoan", base(dep, { direction: "they_owe_me" }));
  assert.equal(res.loan.direction, "they_owe_me");
  assert.equal(row(dep.id), undefined);
  const moved = row(res.loan.transfer_entry_id);
  assert.equal(moved.type, "transfer");
  assert.equal(Number(moved.amount), 100);
});

test("a withdrawal becomes a loan the owner received", () => {
  const { rt, invest, base } = setup();
  const wd = invest(-80);
  const res = rt.api("convertEntryToLoan", base(wd, { direction: "i_owe_them" }));
  assert.equal(res.loan.direction, "i_owe_them");
  assert.equal(Number(res.loan.amount), 80);
});

test("the wrong direction is refused with the reason, and nothing changes", () => {
  const { rt, invest, base, row } = setup();
  const dep = invest(100), wd = invest(-60);
  assert.throws(() => rt.api("convertEntryToLoan", base(dep, { direction: "i_owe_them" })), /deposit.*loan you gave/i);
  assert.throws(() => rt.api("convertEntryToLoan", base(wd, { direction: "they_owe_me" })), /withdrawal.*loan you received/i);
  assert.throws(() => rt.api("convertEntryToRepayment", base(dep, { direction: "they_owe_me", overpay_pending_ok: true })), /deposit.*repayment you paid/i);
  assert.throws(() => rt.api("convertEntryToRepayment", base(wd, { direction: "i_owe_them", overpay_pending_ok: true })), /withdrawal.*repayment you received/i);
  assert.equal(row(dep.id).type, "investment");
  assert.equal(row(wd.id).type, "investment");
});

test("a deposit becomes a repayment the owner paid, settling the debt", () => {
  const { rt, pm, friend, invest, base, row } = setup();
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const dep = invest(100);
  rt.api("convertEntryToRepayment", base(dep, { direction: "i_owe_them", overpay_pending_ok: true }));
  assert.equal(row(dep.id), undefined);
  assert.equal(rt.rows("Loans").find((l) => l.friend_id === friend.id).status, "repaid");
});

test("a withdrawal becomes a repayment received", () => {
  const { rt, pm, friend, invest, base } = setup();
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const wd = invest(-50);
  rt.api("convertEntryToRepayment", base(wd, { direction: "they_owe_me", overpay_pending_ok: true }));
  assert.equal(rt.rows("Loans").find((l) => l.friend_id === friend.id).status, "repaid");
});
