// Overpayment: money left over after a debt is fully repaid must never be lost.
// It is recorded in the same request as the repayment — confirmed when a
// category is given, otherwise as a PENDING entry in the review queue
// (persona finding L3, 2026-10-05: closing the second screen lost it).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Over Friend " + Math.random().toString(36).slice(2, 6) });
  const loan = (direction, amount, currency = "PEN") =>
    rt.api("addLoan", { friend_id: f.id, direction, amount, currency, date: "2026-01-01", payment_method_id: data.pms[3].id });
  const repay = (direction, amount, extra = {}) =>
    rt.api("recordRepayment", { friend_id: f.id, direction, amount, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, ...extra });
  const overEntries = () => rt.rows("Entries").filter((e) => /^Overpayment/.test(e.description) && e.description.includes(f.name));
  const cat = (type) => data.cats.find((c) => c.type === type);
  return { rt, data, f, loan, repay, overEntries, cat };
}

test("a friend overpays me: the extra becomes a PENDING income entry (not lost)", () => {
  const { rt, data, f, loan, repay, overEntries } = setup();
  loan("they_owe_me", 100);
  const res = repay("they_owe_me", 130);

  assert.equal(res.overpaid, 30);
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].type, "income");
  assert.equal(e[0].status, "pending");
  assert.equal(Number(e[0].amount), 30);
  assert.equal(e[0].category_id, "");
  assert.equal(e[0].payment_method_id, data.pms[3].id);
  assert.equal(res.overpayment_entry.id, e[0].id);
  assert.ok(rt.api("listPendingEntries").some((x) => x.id === e[0].id), "shows in the review queue");
});

test("I overpay a friend: the extra becomes a PENDING expense paid by me", () => {
  const { loan, repay, overEntries } = setup();
  loan("i_owe_them", 100);
  repay("i_owe_them", 120);
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].type, "expense");
  assert.equal(e[0].status, "pending");
  assert.equal(e[0].paid_by, "me");
  assert.equal(Number(e[0].amount), 20);
});

test("with a category given up front, the extra is a confirmed entry right away (one entry only)", () => {
  const { loan, repay, overEntries, cat } = setup();
  loan("they_owe_me", 100);
  const res = repay("they_owe_me", 130, { overpay_category_id: cat("income").id });
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].status, "confirmed");
  assert.equal(e[0].category_id, cat("income").id);
  assert.equal(res.overpayment_entry.id, e[0].id);
});

test("no overpayment, no extra entry", () => {
  const { loan, repay, overEntries } = setup();
  loan("they_owe_me", 100);
  const res = repay("they_owe_me", 100);
  assert.equal(res.overpaid, 0);
  assert.equal(overEntries().length, 0);
});

test("paying when nothing is owed at all records the whole amount as the extra", () => {
  const { rt, repay, overEntries } = setup();
  const res = repay("they_owe_me", 50);
  assert.equal(res.overpaid, 50);
  assert.equal(overEntries().length, 1);
  assert.equal(Number(overEntries()[0].amount), 50);
});

test("the app's old second step (recordOverpaymentIncome) completes the pending entry instead of adding a second one", () => {
  const { rt, f, loan, repay, overEntries, cat } = setup();
  loan("they_owe_me", 100);
  const res = repay("they_owe_me", 130);
  rt.api("recordOverpaymentIncome", { friend_id: f.id, amount: 30, currency: "PEN", date: today(), payment_method_id: res.overpayment_entry.payment_method_id, category_id: cat("income").id });

  const e = overEntries();
  assert.equal(e.length, 1, "still exactly one overpayment entry");
  assert.equal(e[0].status, "confirmed");
  assert.equal(e[0].category_id, cat("income").id);
});

test("the same for an expense overpayment", () => {
  const { rt, f, loan, repay, overEntries, cat } = setup();
  loan("i_owe_them", 100);
  repay("i_owe_them", 120);
  rt.api("recordOverpaymentExpense", { friend_id: f.id, amount: 20, currency: "PEN", date: today(), payment_method_id: "", category_id: cat("expense").id });
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].status, "confirmed");
});

test("overpaying in USD creates a USD extra and leaves the PEN loan alone", () => {
  const { rt, f, loan, overEntries } = setup();
  const pen = loan("they_owe_me", 100, "PEN");
  loan("they_owe_me", 20, "USD");
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "USD", date: today(), payment_method_id: "" });
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].currency, "USD");
  assert.equal(Number(e[0].amount), 30);
  const settled = rt.rows("Settlements").filter((s) => s.loan_id === pen.id).length;
  assert.equal(settled, 0);
});

test("a confirmed overpayment counts in income; a pending one does not yet", () => {
  const { rt, loan, repay, cat } = setup();
  loan("they_owe_me", 100);
  const before = rt.api("getPeriodSummary", {}).totals.income;
  const res = repay("they_owe_me", 150);
  assert.equal(rt.api("getPeriodSummary", {}).totals.income, before, "pending: not counted");
  rt.api("updateEntry", { id: res.overpayment_entry.id, fields: { category_id: cat("income").id } });
  rt.api("confirmEntry", { id: res.overpayment_entry.id });
  assert.equal(Math.round((rt.api("getPeriodSummary", {}).totals.income - before) * 100) / 100, 50);
});

test("Telegram 'repayment <friend>' with extra: the extra is saved, and the reply says where", () => {
  const { rt, data, f, loan, overEntries } = setup();
  loan("i_owe_them", 40);
  const pending = data.entries.find((e) => e.status === "pending" && e.currency === "PEN");
  rt.api("updateEntry", { id: pending.id, fields: { amount: 100 } });
  const out = JSON.parse(rt.run(`JSON.stringify(applyTerminalReviewAction_(${JSON.stringify(pending.id)}, 'repayment ${f.name}', ${JSON.stringify(f.name)}))`));
  assert.match(out.message, /review queue/i);
  assert.equal(overEntries().length, 1);
  assert.equal(Number(overEntries()[0].amount), 60);
});

test("converting a review-queue entry into a repayment books the extra once, confirmed", () => {
  const { rt, data, f, loan, overEntries, cat } = setup();
  loan("i_owe_them", 40);
  const pending = data.entries.find((e) => e.status === "pending" && e.currency === "PEN");
  const res = rt.api("convertEntryToRepayment", {
    entry_id: pending.id, friend_id: f.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: today(),
    payment_method_id: data.pms[3].id, overpay_category_id: cat("expense").id
  });
  assert.equal(res.overpaid, 60);
  const e = overEntries();
  assert.equal(e.length, 1);
  assert.equal(e[0].status, "confirmed");
  assert.equal(Number(e[0].amount), 60);
});

// ---- Pending INCOME → repayment / loan (e.g. a "Te Yapearon" photo from a friend) ----

function pendingIncome(rt, data, amount = 75) {
  const e = rt.api("createEntry", {
    type: "income", date: today(), amount, currency: "PEN", category_id: "", description: "Yape de Ana Lo*",
    payment_method_id: data.pms[3].id, paid_by: ""
  });
  rt.run(`updateEntryFields(${JSON.stringify(e.id)}, { status: 'pending' })`);
  return e;
}
const telegramAction = (rt, id, text, friendName) =>
  JSON.parse(rt.run(`JSON.stringify(applyTerminalReviewAction_(${JSON.stringify(id)}, ${JSON.stringify(text)}, ${JSON.stringify(friendName)}))`));
const entryExists = (rt, id) => rt.rows("Entries").some((e) => e.id === id);

test("Telegram 'repayment <friend>' on a pending INCOME: the friend pays down what they owed me", () => {
  const { rt, data, f, loan } = setup();
  const l = loan("they_owe_me", 100);
  const inc = pendingIncome(rt, data, 75);
  const out = telegramAction(rt, inc.id, "repayment " + f.name, f.name);
  assert.match(out.message, /repayment from/i);
  assert.equal(out.removed, true);
  assert.equal(entryExists(rt, inc.id), false, "the pending income is gone");
  const settled = rt.rows("Settlements").filter((s) => s.loan_id === l.id).reduce((a, s) => a + Number(s.amount), 0);
  assert.equal(settled, 75);
  assert.ok(rt.rows("Entries").some((e) => e.type === "transfer" && Number(e.amount) === 75), "the money movement is a transfer entry");
});

test("Telegram repayment on a pending INCOME with nothing owed: refused, entry left untouched", () => {
  const { rt, data, f } = setup();
  const inc = pendingIncome(rt, data, 75);
  const before = rt.rows("Entries").length;
  const settlementsBefore = rt.rows("Settlements").length;
  const out = telegramAction(rt, inc.id, "repayment " + f.name, f.name);
  assert.match(out.message, /nothing for this to repay/i);
  assert.match(out.message, /unchanged/i);
  assert.notEqual(out.removed, true);
  assert.equal(entryExists(rt, inc.id), true);
  assert.equal(rt.rows("Entries").length, before, "no overpayment entry or anything else was created");
  assert.equal(rt.rows("Settlements").length, settlementsBefore);
});

test("Telegram repayment on a pending INCOME larger than the debt: extra goes to the review queue", () => {
  const { rt, data, f, loan, overEntries } = setup();
  loan("they_owe_me", 50);
  const inc = pendingIncome(rt, data, 75);
  const out = telegramAction(rt, inc.id, "repayment " + f.name, f.name);
  assert.match(out.message, /more than they owed you/i);
  assert.equal(overEntries().length, 1);
  assert.equal(overEntries()[0].type, "income");
  assert.equal(Number(overEntries()[0].amount), 25);
});

test("Telegram 'loan <friend>' on a pending INCOME: the friend lent it to me (I owe them)", () => {
  const { rt, data, f } = setup();
  const inc = pendingIncome(rt, data, 75);
  const out = telegramAction(rt, inc.id, "loan " + f.name, f.name);
  assert.match(out.message, /you now owe/i);
  assert.equal(entryExists(rt, inc.id), false);
  const made = rt.rows("Loans").filter((l) => l.friend_id === f.id);
  assert.equal(made.length, 1);
  assert.equal(made[0].direction, "i_owe_them");
  assert.equal(Number(made[0].amount), 75);
});

test("pending expense repayment/loan directions are unchanged", () => {
  const { rt, data, f, loan } = setup();
  loan("i_owe_them", 40);
  const pending = data.entries.find((e) => e.status === "pending" && e.type === "expense" && e.currency === "PEN");
  rt.api("updateEntry", { id: pending.id, fields: { amount: 30 } });
  telegramAction(rt, pending.id, "repayment " + f.name, f.name);
  const mine = new Set(rt.rows("Loans").filter((l) => l.friend_id === f.id).map((l) => l.id));
  const settled = rt.rows("Settlements").filter((s) => mine.has(s.loan_id)).reduce((a, s) => a + Number(s.amount), 0);
  assert.equal(settled, 30);
  const p2 = data.entries.find((e) => e.status === "pending" && e.type === "expense" && e.currency === "PEN" && e.id !== pending.id);
  telegramAction(rt, p2.id, "loan " + f.name, f.name);
  assert.ok(rt.rows("Loans").some((l) => l.friend_id === f.id && l.direction === "they_owe_me"));
});

test("a transfer or investment still can't be turned into a repayment/loan from Telegram", () => {
  const { rt, data, f } = setup();
  const e = rt.api("createEntry", { type: "transfer", date: today(), amount: 10, currency: "PEN", category_id: "", payment_method_id: data.pms[3].id, paid_by: "me" });
  rt.run(`updateEntryFields(${JSON.stringify(e.id)}, { status: 'pending' })`);
  assert.match(telegramAction(rt, e.id, "repayment " + f.name, f.name).message, /internal transfer/i);
  assert.equal(entryExists(rt, e.id), true);
});

test("recordRepayment with require_owed and no debt writes nothing (the app's income path)", () => {
  const { rt, f, repay } = setup();
  const settlementsBefore = rt.rows("Settlements").length;
  assert.throws(() => repay("they_owe_me", 40, { require_owed: true }), /nothing for this to repay/i);
  assert.equal(rt.rows("Settlements").length, settlementsBefore);
  assert.equal(rt.rows("Entries").filter((e) => e.description.includes(f.name)).length, 0);
});
