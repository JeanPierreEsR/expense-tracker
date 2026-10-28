// A shared expense whose debt friends already (partly) repaid, converted into a loan or repayment
// (convertEntryToLoan / convertEntryToRepayment with repayments 'keep' | 'cancel'). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const ana = rt.api("addFriend", { name: "Shared Ana " + Math.random().toString(36).slice(2, 6) });
  const bo = rt.api("addFriend", { name: "Shared Bo " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat.id, description: "Shared dinner", payment_method_id: pm, paid_by: "me" });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: ana.id, amount: 40 }] });
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 25, currency: "PEN", date: today(), payment_method_id: pm });
  const repaymentEntryId = rt.rows("Settlements").find((s) => s.transfer_entry_id).transfer_entry_id;
  const toLoan = (extra = {}) => rt.api("convertEntryToLoan", { entry_id: e.id, friend_id: bo.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: today(), payment_method_id: pm, description: "Really a loan", ...extra });
  const exists = (id) => rt.rows("Entries").some((x) => x.id === id);
  return { rt, data, ana, bo, pm, e, repaymentEntryId, toLoan, exists };
}

test("without a choice a repaid shared expense is still refused, and nothing is touched", () => {
  const { rt, e, toLoan, repaymentEntryId, exists } = setup();
  const loansBefore = rt.rows("Loans").length, settlementsBefore = rt.rows("Settlements").length;
  assert.throws(() => toLoan(), /keep those repayments or cancel/i);
  assert.equal(exists(e.id), true);
  assert.equal(exists(repaymentEntryId), true);
  assert.equal(rt.rows("Loans").length, loansBefore);
  assert.equal(rt.rows("Settlements").length, settlementsBefore);
});

test("keep: the expense becomes a new loan; Ana's 25 stays as a 'paid earlier, no loan' credit and its money entry stays", () => {
  const { rt, ana, bo, e, toLoan, repaymentEntryId, exists } = setup();
  const out = toLoan({ repayments: "keep" });
  assert.equal(exists(e.id), false);
  assert.ok(out.loan && out.loan.friend_id === bo.id && Number(out.loan.amount) === 100);
  const credit = rt.rows("Loans").find((l) => l.friend_id === ana.id && l.direction === "i_owe_them");
  assert.ok(credit && Number(credit.amount) === 25);
  assert.equal(rt.rows("Loans").some((l) => l.entry_id === e.id), false, "no debt is left on the deleted expense");
  assert.equal(exists(repaymentEntryId), true, "the money that arrived stays on record");
});

test("cancel: the repayment and its money entry go too", () => {
  const { rt, ana, e, toLoan, repaymentEntryId, exists } = setup();
  toLoan({ repayments: "cancel" });
  assert.equal(exists(e.id), false);
  assert.equal(exists(repaymentEntryId), false);
  assert.equal(rt.rows("Loans").some((l) => l.friend_id === ana.id), false);
  const loanIds = new Set(rt.rows("Loans").map((l) => l.id));
  assert.equal(rt.rows("Settlements").some((s) => !loanIds.has(s.loan_id)), false);
});

test("it can become a repayment instead of a loan, with the same choice", () => {
  const { rt, data, ana, bo, pm, e, exists } = setup();
  rt.api("addLoan", { friend_id: bo.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const income = data.cats.find((c) => c.type === "income");
  assert.throws(() => rt.api("convertEntryToRepayment", { entry_id: e.id, friend_id: bo.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id }), /keep those repayments or cancel/i);
  rt.api("convertEntryToRepayment", { entry_id: e.id, friend_id: bo.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id, repayments: "keep" });
  assert.equal(exists(e.id), false);
  assert.ok(rt.rows("Settlements").some((s) => Number(s.amount) === 60));
});

for (const choice of ["keep", "cancel"]) {
  test(`a failure after releasing the repayments (${choice}) puts everything back exactly`, () => {
    const { rt, ana, bo, pm, e, repaymentEntryId, exists } = setup();
    const snapshot = () => JSON.stringify({
      loans: rt.rows("Loans").map((l) => [l.id, l.amount, l.status]).sort(),
      settlements: rt.rows("Settlements").map((s) => [s.id, s.loan_id, s.amount]).sort(),
      repayment: (rt.rows("Entries").find((x) => x.id === repaymentEntryId) || {}).amount
    });
    const before = snapshot();
    // Bo owes nothing, so the repayment (Telegram-style require_owed) fails AFTER the old entry and debts were released.
    assert.throws(() => rt.api("convertEntryToRepayment", { entry_id: e.id, friend_id: bo.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm, require_owed: true, overpay_pending_ok: true, repayments: choice }), /nothing for this to repay|Nothing was changed/i);
    assert.equal(exists(e.id), true, "the original entry is back");
    assert.equal(snapshot(), before, "loans, repayments and the repayment's money entry are exactly as before");
    assert.equal(rt.rows("Loans").find((l) => l.entry_id === e.id).friend_id, ana.id);
  });
}
