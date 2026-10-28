// "This loan was really an expense / income" (convertLoanToEntry). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Conv Friend " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const cat = (type) => data.cats.find((c) => c.type === type);
  const loan = (direction, amount) => rt.api("addLoan", { friend_id: f.id, direction, amount, currency: "PEN", date: "2026-01-01", payment_method_id: pm, description: "Test loan" });
  const form = (loanRow, type, extra = {}) => ({
    entry_id: loanRow.transfer_entry_id, type, date: "2026-01-01", amount: Number(loanRow.amount), currency: "PEN",
    category_id: cat(type).id, description: "Really spending", payment_method_id: pm,
    paid_by: type === "income" ? data.payors[0].id : "me", ...extra
  });
  const settled = (id) => rt.rows("Settlements").filter((s) => s.loan_id === id).reduce((n, s) => n + Number(s.amount), 0);
  const entryExists = (id) => rt.rows("Entries").some((e) => e.id === id);
  return { rt, data, f, pm, loan, form, settled, entryExists, cat };
}

test("a lent loan with no repayments becomes an expense; the loan and its transfer are gone", () => {
  const { rt, loan, form, entryExists } = setup();
  const l = loan("they_owe_me", 100);
  assert.ok(l.transfer_entry_id);
  const out = rt.api("convertLoanToEntry", form(l, "expense"));
  assert.equal(out.entry.type, "expense");
  assert.equal(out.entry.status, "confirmed");
  assert.equal(Number(out.entry.amount), 100);
  assert.equal(entryExists(l.transfer_entry_id), false);
  assert.equal(rt.rows("Loans").some((x) => x.id === l.id), false);
});

test("a borrowed loan becomes an income", () => {
  const { rt, loan, form } = setup();
  const l = loan("i_owe_them", 60);
  const out = rt.api("convertLoanToEntry", form(l, "income"));
  assert.equal(out.entry.type, "income");
  assert.equal(rt.rows("Loans").some((x) => x.id === l.id), false);
});

test("the direction must match: lent -> expense only, borrowed -> income only", () => {
  const { rt, loan, form } = setup();
  const lent = loan("they_owe_me", 50);
  assert.throws(() => rt.api("convertLoanToEntry", form(lent, "income")), /lent/i);
  const borrowed = loan("i_owe_them", 50);
  assert.throws(() => rt.api("convertLoanToEntry", form(borrowed, "expense")), /borrowed/i);
  assert.ok(rt.rows("Loans").some((x) => x.id === lent.id) && rt.rows("Loans").some((x) => x.id === borrowed.id));
});

test("a loan with repayments is refused until keep / cancel is chosen, and nothing is written", () => {
  const { rt, data, f, pm, loan, form } = setup();
  const l = loan("they_owe_me", 100);
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const entriesBefore = rt.rows("Entries").length;
  assert.throws(() => rt.api("convertLoanToEntry", form(l, "expense")), /keep them or cancel/i);
  assert.equal(rt.rows("Entries").length, entriesBefore);
  assert.ok(rt.rows("Loans").some((x) => x.id === l.id));
});

test("keep: the friend's payment stays as a 'paid earlier, no loan' credit and its money entry remains", () => {
  const { rt, f, pm, loan, form, entryExists } = setup();
  const l = loan("they_owe_me", 100);
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const repaymentEntry = rt.rows("Settlements").find((s) => s.loan_id === l.id).transfer_entry_id;
  const out = rt.api("convertLoanToEntry", form(l, "expense", { repayments: "keep" }));
  assert.equal(out.kept_repayments, true);
  assert.equal(rt.rows("Loans").some((x) => x.id === l.id), false);
  const credit = rt.rows("Loans").find((x) => x.friend_id === f.id && x.direction === "i_owe_them");
  assert.ok(credit && Number(credit.amount) === 40, "the 40 that arrived is kept as money the friend paid earlier");
  assert.equal(entryExists(repaymentEntry), true, "the repayment's own money entry stays");
});

test("cancel: the repayment rows and their money entry go too", () => {
  const { rt, f, pm, loan, form, entryExists } = setup();
  const l = loan("they_owe_me", 100);
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const repaymentEntry = rt.rows("Settlements").find((s) => s.loan_id === l.id).transfer_entry_id;
  rt.api("convertLoanToEntry", form(l, "expense", { repayments: "cancel" }));
  assert.equal(rt.rows("Settlements").some((s) => s.loan_id === l.id), false);
  assert.equal(rt.rows("Loans").some((x) => x.friend_id === f.id && x.direction === "i_owe_them"), false, "no credit is left");
  assert.equal(entryExists(repaymentEntry), false);
});

test("an entry that is not a loan's money movement is refused", () => {
  const { rt, data, pm, cat } = setup();
  const e = rt.api("createEntry", { type: "transfer", date: today(), amount: 10, currency: "PEN", category_id: "", description: "Own", payment_method_id: pm, to_payment_method_id: data.pms[2].id, paid_by: "me" });
  assert.throws(() => rt.api("convertLoanToEntry", { entry_id: e.id, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: cat("expense").id }), /not a loan/i);
});

test("getEntryRepaymentLinks tells the screen the loan's repayments", () => {
  const { rt, f, pm, loan } = setup();
  const l = loan("they_owe_me", 100);
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const links = rt.api("getEntryRepaymentLinks", { id: l.transfer_entry_id });
  assert.equal(links.loan, true);
  assert.equal(links.loanInfo.hasRepayments, true);
  assert.equal(links.loanInfo.paid, 40);
});
