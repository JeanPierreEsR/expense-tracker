// A loan's money entry turned into an investment, a plain transfer or a REPAYMENT (step 4). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const tag = Math.random().toString(36).slice(2, 6);
  const ana = rt.api("addFriend", { name: "Step4 Ana " + tag });
  const bo = rt.api("addFriend", { name: "Step4 Bo " + tag });
  const pm = data.pms[3].id;
  const pm2 = data.pms[4].id;
  const broker = rt.api("addPaymentMethod", { nickname: "Step4 Broker " + tag, type: "investment" });
  const income = data.cats.find((c) => c.type === "income");
  const transferCat = data.cats.find((c) => c.type === "transfer");
  const lend = (f, amount) => rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const borrow = (f, amount) => rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const exists = (id) => rt.rows("Entries").some((e) => e.id === id);
  const loanExists = (id) => rt.rows("Loans").some((l) => l.id === id);
  return { rt, data, ana, bo, pm, pm2, broker, income, transferCat, lend, borrow, exists, loanExists };
}

// ---- → investment ----

test("a lent loan becomes an investment DEPOSIT (the money left); the loan is gone", () => {
  const { rt, pm, broker, lend, exists, loanExists, ana } = setup();
  const l = lend(ana, 100);
  const out = rt.api("convertLoanToEntry", { entry_id: l.transfer_entry_id, type: "investment", date: today(), amount: 100, currency: "PEN", description: "Really invested", payment_method_id: pm, to_payment_method_id: broker.id });
  assert.equal(out.entry.type, "investment");
  assert.equal(Number(out.entry.amount), 100);
  assert.equal(out.entry.to_payment_method_id, broker.id);
  assert.equal(exists(l.transfer_entry_id), false);
  assert.equal(loanExists(l.id), false);
});

test("a borrowed loan becomes an investment WITHDRAWAL (negative amount, the money arrived)", () => {
  const { rt, pm, broker, borrow, ana } = setup();
  const l = borrow(ana, 80);
  const out = rt.api("convertLoanToEntry", { entry_id: l.transfer_entry_id, type: "investment", date: today(), amount: -80, currency: "PEN", description: "Really a withdrawal", payment_method_id: pm, to_payment_method_id: broker.id });
  assert.equal(Number(out.entry.amount), -80);
});

test("the investment must match how the money moved, and needs a platform; a refusal changes nothing", () => {
  const { rt, pm, broker, lend, loanExists, exists, ana } = setup();
  const l = lend(ana, 100);
  const base = { entry_id: l.transfer_entry_id, type: "investment", date: today(), currency: "PEN", payment_method_id: pm, to_payment_method_id: broker.id };
  assert.throws(() => rt.api("convertLoanToEntry", { ...base, amount: -100 }), /only be a deposit/i);
  assert.throws(() => rt.api("convertLoanToEntry", { ...base, amount: 100, to_payment_method_id: "" }), /platform/i);
  assert.equal(loanExists(l.id), true);
  assert.equal(exists(l.transfer_entry_id), true);
});

// ---- → plain transfer ----

test("a loan becomes a PLAIN TRANSFER between the owner's own accounts (never was a loan)", () => {
  const { rt, pm, pm2, transferCat, lend, exists, loanExists, ana } = setup();
  const l = lend(ana, 70);
  const out = rt.api("convertLoanToEntry", { entry_id: l.transfer_entry_id, type: "transfer", date: today(), amount: 70, currency: "PEN", category_id: transferCat.id, description: "Between my accounts", payment_method_id: pm, to_payment_method_id: pm2 });
  assert.equal(out.entry.type, "transfer");
  assert.equal(out.entry.payment_method_id, pm);
  assert.equal(out.entry.to_payment_method_id, pm2);
  assert.equal(exists(l.transfer_entry_id), false, "the loan's own entry is replaced");
  assert.equal(loanExists(l.id), false);
  assert.equal(rt.api("getEntryRepaymentLinks", { id: out.entry.id }).loan, false, "the new transfer is not tied to any loan");
});

test("a transfer needs at least one account, and a refusal changes nothing", () => {
  const { rt, lend, loanExists, ana, transferCat } = setup();
  const l = lend(ana, 70);
  assert.throws(() => rt.api("convertLoanToEntry", { entry_id: l.transfer_entry_id, type: "transfer", date: today(), amount: 70, currency: "PEN", category_id: transferCat.id }), /account or card/i);
  assert.equal(loanExists(l.id), true);
});

// ---- → repayment ----

test("a lent loan (money left) becomes a repayment I PAID; the loan is gone and the other debt is paid", () => {
  const { rt, pm, ana, bo, income, lend, borrow, exists, loanExists } = setup();
  const debtToBo = borrow(bo, 60);
  const l = lend(ana, 60);
  const out = rt.api("convertLoanToRepayment", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "i_owe_them", amount: 60, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id });
  assert.equal(out.overpaid, 0);
  assert.equal(loanExists(l.id), false);
  assert.equal(exists(l.transfer_entry_id), false);
  assert.equal(rt.rows("Settlements").filter((s) => s.loan_id === debtToBo.id).reduce((n, s) => n + Number(s.amount), 0), 60, "what I owed Bo is paid");
});

test("a borrowed loan (money arrived) becomes a repayment I RECEIVED", () => {
  const { rt, pm, ana, bo, income, lend, borrow } = setup();
  const owedToMe = lend(bo, 50);
  const l = borrow(ana, 50);
  rt.api("convertLoanToRepayment", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id });
  assert.equal(rt.rows("Settlements").filter((s) => s.loan_id === owedToMe.id).reduce((n, s) => n + Number(s.amount), 0), 50);
});

test("the repayment's direction must match how the money moved; a refusal changes nothing", () => {
  const { rt, pm, ana, bo, income, lend, loanExists, exists } = setup();
  const l = lend(ana, 60);
  assert.throws(() => rt.api("convertLoanToRepayment", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id }), /one you paid/i);
  assert.throws(() => rt.api("convertLoanToRepayment", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "i_owe_them", amount: 60, currency: "PEN", date: today(), payment_method_id: pm }), /category for any extra/i);
  assert.equal(loanExists(l.id), true);
  assert.equal(exists(l.transfer_entry_id), true);
});

// ---- a loan that already has repayments, and failures ----

function repaidLoan() {
  const s = setup();
  const { rt, pm, ana, bo, lend, borrow } = s;
  const debtToBo = borrow(bo, 40);
  const l = lend(ana, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm });
  const repaymentEntry = rt.rows("Settlements").find((x) => x.loan_id === l.id).transfer_entry_id;
  const call = (extra = {}) => rt.api("convertLoanToRepayment", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "i_owe_them", amount: 40, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: s.income.id, ...extra });
  return { ...s, l, debtToBo, repaymentEntry, call };
}

test("a loan with real repayments needs keep / cancel; keep leaves a 'paid earlier' credit, cancel removes them", () => {
  const a = repaidLoan();
  assert.throws(() => a.call(), /keep them or cancel/i);
  assert.equal(a.loanExists(a.l.id), true, "nothing changed");
  a.call({ repayments: "keep" });
  assert.equal(a.loanExists(a.l.id), false);
  assert.ok(a.rt.rows("Loans").find((x) => x.friend_id === a.ana.id && x.direction === "i_owe_them" && Number(x.amount) === 30), "Ana's 30 stays as a credit");
  assert.equal(a.exists(a.repaymentEntry), true, "the money that arrived stays on record");

  const b = repaidLoan();
  b.call({ repayments: "cancel" });
  assert.equal(b.exists(b.repaymentEntry), false, "cancel removes the repayment's money entry too");
  assert.equal(b.rt.rows("Loans").some((x) => x.friend_id === b.ana.id), false);
});

for (const choice of ["keep", "cancel"]) {
  test(`a failure after the loan was removed (${choice}) puts the loan, its entry and its repayments back exactly`, () => {
    const a = repaidLoan();
    const snap = () => JSON.stringify({
      loans: a.rt.rows("Loans").map((x) => [x.id, x.amount, x.status]).sort(),
      settlements: a.rt.rows("Settlements").map((x) => [x.id, x.loan_id, x.amount]).sort(),
      entries: a.rt.rows("Entries").length,
      movement: (a.rt.rows("Entries").find((e) => e.id === a.l.transfer_entry_id) || {}).amount,
      repayment: (a.rt.rows("Entries").find((e) => e.id === a.repaymentEntry) || {}).amount
    });
    const before = snap();
    a.rt.run("globalThis.__origRec3 = recordRepayment; recordRepayment = function () { throw new Error('boom'); };");
    try {
      assert.throws(() => a.call({ repayments: choice }), /Nothing was changed/i);
    } finally {
      a.rt.run("recordRepayment = globalThis.__origRec3;");
    }
    assert.equal(snap(), before);
  });
}
