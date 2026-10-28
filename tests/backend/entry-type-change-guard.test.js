// A plain edit must not change the type of an entry other records hang on (entryTypeChangeBlock_, step 0 of the
// entry-type conversions plan). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Guard Friend " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const cat = (type) => data.cats.find((c) => c.type === type);
  const changeType = (id, type) => rt.api("updateEntry", { id, fields: { type } });
  return { rt, data, f, pm, cat, changeType };
}

test("a repayment's money movement cannot change type, and nothing changes", () => {
  const { rt, f, pm, changeType } = setup();
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const movement = rt.rows("Settlements").find((s) => s.transfer_entry_id).transfer_entry_id;
  assert.throws(() => changeType(movement, "expense"), /money movement of a repayment/i);
  assert.equal(rt.rows("Entries").find((e) => e.id === movement).type, "transfer");
});

test("a loan's money movement cannot change type through a plain edit", () => {
  const { rt, f, pm, changeType } = setup();
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  assert.throws(() => changeType(loan.transfer_entry_id, "investment"), /money movement of a loan/i);
  assert.equal(rt.rows("Entries").find((e) => e.id === loan.transfer_entry_id).type, "transfer");
});

test("the entry a forgiveness booked cannot change type", () => {
  const { rt, data, f, pm, cat, changeType } = setup();
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const res = rt.api("forgiveLoan", { id: loan.id, convert: true, category_id: cat("expense").id, date: today() });
  assert.throws(() => changeType(res.entry.id, "income"), /forgiven/i);
  assert.equal(rt.rows("Entries").find((e) => e.id === res.entry.id).type, "expense");
});

test("one side of a currency exchange only changes into the type that fits its direction", () => {
  const { rt, changeType } = setup();
  const pen = rt.api("addPaymentMethod", { nickname: "Guard PEN", type: "debit" });
  const usd = rt.api("addPaymentMethod", { nickname: "Guard USD", type: "debit" });
  const res = rt.api("recordCurrencyExchange", { date: today(), out: { payment_method_id: pen.id, amount: 370, currency: "PEN" }, in: { payment_method_id: usd.id, amount: 100, currency: "USD" } });
  assert.throws(() => changeType(res.out.id, "income"), /money-out side of a currency exchange/i);
  assert.throws(() => changeType(res.in.id, "expense"), /money-in side of a currency exchange/i);
  assert.equal(rt.rows("Entries").find((e) => e.id === res.out.id).type, "transfer");
});

test("ordinary entries still change type freely, and the same type is never a change", () => {
  const { rt, pm, cat, changeType } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: cat("expense").id, description: "Plain", payment_method_id: pm, paid_by: "me" });
  assert.equal(changeType(e.id, "income").type, "income");
  assert.equal(changeType(e.id, "income").type, "income");
  const loan = rt.api("addLoan", { friend_id: rt.api("addFriend", { name: "Same Type Friend" }).id, direction: "they_owe_me", amount: 10, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  assert.equal(rt.api("updateEntry", { id: loan.transfer_entry_id, fields: { type: "transfer", description: "Renamed" } }).description, "Renamed");
});

test("a WAITING exchange leg may still be turned into something else (it is not decided yet)", () => {
  const { rt, pm, cat, changeType } = setup();
  const e = { id: "w-" + Math.random().toString(36).slice(2, 8), type: "transfer", date: today(), amount: 10, currency: "PEN", category_id: "", description: "Maybe exchange", paid_by: "me", payment_method_id: pm, status: "pending", source: "email", exchange: "1" };
  rt.run(`ensureEntriesExchangeColumn_(); appendRowObject('Entries', ${JSON.stringify(e)});`);
  assert.equal(changeType(e.id, "expense").type, "expense");
});

test("checkEntryTypeChange tells the screen the reason (or nothing)", () => {
  const { rt, f, pm, cat } = setup();
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  assert.match(rt.api("checkEntryTypeChange", { id: loan.transfer_entry_id, type: "investment" }).blocked, /loan/i);
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat("expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  assert.equal(rt.api("checkEntryTypeChange", { id: e.id, type: "income" }).blocked, "");
});

// ---- A shared expense with repaid debts turned into another type (step 1 finding) ----

function sharedAndRepaid(rt, data, pm, f, cat) {
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat("expense").id, description: "Shared dinner", payment_method_id: pm, paid_by: "me" });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: f.id, amount: 40 }] });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 25, currency: "PEN", date: today(), payment_method_id: pm });
  return e;
}

test("a shared expense with repayments cannot change type until its repayments are settled", () => {
  const { rt, data, f, pm, cat, changeType } = setup();
  const e = sharedAndRepaid(rt, data, pm, f, cat);
  assert.throws(() => changeType(e.id, "income"), /keep those repayments or cancel/i);
  assert.equal(rt.rows("Entries").find((x) => x.id === e.id).type, "expense");
  const check = rt.api("checkEntryTypeChange", { id: e.id, type: "income" });
  assert.equal(check.needsRelease, true);
  assert.equal(check.repaid[0].total, 25);
  assert.equal(rt.api("checkEntryTypeChange", { id: e.id, type: "expense" }).needsRelease, false);
});

test("keep: the debt goes, the 25 stays as a 'paid earlier, no loan' credit, then the type can change", () => {
  const { rt, data, f, pm, cat, changeType } = setup();
  const e = sharedAndRepaid(rt, data, pm, f, cat);
  assert.throws(() => rt.api("releaseEntryRepaidLoans", { id: e.id, type: "income" }), /keep those repayments or cancel/i);
  rt.api("releaseEntryRepaidLoans", { id: e.id, type: "income", repayments: "keep" });
  assert.equal(rt.rows("Loans").some((l) => l.entry_id === e.id), false, "no debt is left on the expense");
  const credit = rt.rows("Loans").find((l) => l.friend_id === f.id && l.direction === "i_owe_them");
  assert.ok(credit && Number(credit.amount) === 25);
  assert.equal(changeType(e.id, "income").type, "income");
});

test("cancel: the repayment rows go too, then the type can change", () => {
  const { rt, data, f, pm, cat, changeType } = setup();
  const e = sharedAndRepaid(rt, data, pm, f, cat);
  rt.api("releaseEntryRepaidLoans", { id: e.id, type: "transfer", repayments: "cancel" });
  assert.equal(rt.rows("Loans").some((l) => l.friend_id === f.id), false);
  const loanIds = new Set(rt.rows("Loans").map((l) => l.id));
  assert.equal(rt.rows("Settlements").some((s) => !loanIds.has(s.loan_id)), false, "no repayment is left pointing at a deleted debt");
  assert.equal(changeType(e.id, "transfer").type, "transfer");
});

test("a shared expense nobody has repaid needs no decision", () => {
  const { rt, f, pm, cat, changeType } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 60, currency: "PEN", category_id: cat("expense").id, description: "Unrepaid", payment_method_id: pm, paid_by: "me" });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: f.id, amount: 20 }] });
  assert.equal(rt.api("checkEntryTypeChange", { id: e.id, type: "income" }).needsRelease, false);
  changeType(e.id, "income");
  rt.api("saveEntrySplits", { entryId: e.id, splits: [] });   // what the phone sends right after
  assert.equal(rt.rows("Loans").some((l) => l.entry_id === e.id), false);
});
