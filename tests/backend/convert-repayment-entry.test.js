// "I recorded this as a repayment, but it was really an expense / income / a loan" (convertRepaymentToEntry /
// convertRepaymentToLoan). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Repay Friend " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const cat = (type) => data.cats.find((c) => c.type === type);
  const owed = (id) => {
    const loan = rt.rows("Loans").find((l) => l.id === id);
    const paid = rt.rows("Settlements").filter((s) => s.loan_id === id).reduce((n, s) => n + Number(s.amount), 0);
    return Number(loan.amount) - paid;
  };
  // Ana-style: they owe me 100, paid 40 back (money ARRIVED).
  const lent = () => {
    const l = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
    rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
    return l;
  };
  // I owe them 100, paid 40 (money LEFT).
  const borrowed = () => {
    const l = rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
    rt.api("recordRepayment", { friend_id: f.id, direction: "i_owe_them", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
    return l;
  };
  const movementId = () => rt.rows("Settlements").find((s) => s.transfer_entry_id).transfer_entry_id;
  const form = (type, extra = {}) => ({
    entry_id: movementId(), type, date: today(), amount: 40, currency: "PEN", category_id: cat(type).id,
    description: "Really not a repayment", payment_method_id: pm, paid_by: type === "income" ? data.payors[0].id : "me", ...extra
  });
  const exists = (id) => rt.rows("Entries").some((e) => e.id === id);
  return { rt, data, f, pm, cat, owed, lent, borrowed, movementId, form, exists };
}

test("money that arrived becomes an income; the repayment is cancelled and the debt is owed again", () => {
  const { rt, lent, owed, movementId, form, exists } = setup();
  const l = lent();
  assert.equal(owed(l.id), 60);
  const id = movementId();
  const out = rt.api("convertRepaymentToEntry", form("income"));
  assert.equal(out.entry.type, "income");
  assert.equal(exists(id), false, "the repayment's money entry is gone");
  assert.equal(rt.rows("Settlements").some((s) => s.loan_id === l.id), false);
  assert.equal(owed(l.id), 100, "what the repayment had paid is owed again");
});

test("money that left becomes an expense", () => {
  const { rt, borrowed, owed, form } = setup();
  const l = borrowed();
  const out = rt.api("convertRepaymentToEntry", form("expense"));
  assert.equal(out.entry.type, "expense");
  assert.equal(owed(l.id), 100);
});

test("the direction must match how the money moved, and a refusal changes nothing", () => {
  const { rt, lent, owed, movementId, form, exists } = setup();
  const l = lent();
  const id = movementId();
  assert.throws(() => rt.api("convertRepaymentToEntry", form("expense")), /arrived/i);
  assert.throws(() => rt.api("convertRepaymentToEntry", form("investment", { category_id: "" })), /expense, an income or a new loan/i);
  assert.equal(exists(id), true);
  assert.equal(owed(l.id), 60);
});

test("it can become a NEW LOAN the other way round (arrived -> they lent me this)", () => {
  const { rt, f, pm, lent, owed, movementId, exists } = setup();
  const l = lent();
  const id = movementId();
  const base = { entry_id: id, friend_id: f.id, amount: 40, currency: "PEN", date: today(), payment_method_id: pm, description: "They lent me this" };
  assert.throws(() => rt.api("convertRepaymentToLoan", { ...base, direction: "they_owe_me" }), /one you received/i);
  assert.equal(exists(id), true);
  const out = rt.api("convertRepaymentToLoan", { ...base, direction: "i_owe_them" });
  assert.equal(out.loan.direction, "i_owe_them");
  assert.equal(exists(id), false);
  assert.equal(owed(l.id), 100);
});

test("a repayment that paid two loans reopens both", () => {
  const { rt, f, pm, form, owed } = setup();
  const a = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const b = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-01-02", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm });
  assert.equal(owed(a.id) + owed(b.id), 20);
  rt.api("convertRepaymentToEntry", form("income", { amount: 60 }));
  assert.equal(owed(a.id), 30);
  assert.equal(owed(b.id), 50);
});

test("an entry that is not a repayment's money movement is refused", () => {
  const { rt, pm, cat } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat("expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  assert.throws(() => rt.api("convertRepaymentToEntry", { entry_id: e.id, type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat("expense").id }), /not a repayment/i);
});

test("a failure while removing the repayment takes the new entry back and puts the repayment back", () => {
  const { rt, lent, owed, movementId, form, exists } = setup();
  const l = lent();
  const id = movementId();
  const before = JSON.stringify({ settlements: rt.rows("Settlements").map((s) => [s.id, s.amount]).sort(), n: rt.rows("Entries").length });
  rt.run("globalThis.__origDiscard = discardEntryWithRepayments_; discardEntryWithRepayments_ = function (entryId) { deleteRowsWhere_('Settlements', function (s) { return s.transfer_entry_id === entryId; }); throw new Error('boom'); };");
  try {
    assert.throws(() => rt.api("convertRepaymentToEntry", form("income")), /Nothing was changed/i);
  } finally {
    rt.run("discardEntryWithRepayments_ = globalThis.__origDiscard;");
  }
  assert.equal(exists(id), true, "the repayment's money entry is still there");
  assert.equal(JSON.stringify({ settlements: rt.rows("Settlements").map((s) => [s.id, s.amount]).sort(), n: rt.rows("Entries").length }), before);
  assert.equal(owed(l.id), 60, "the repayment still counts");
});

test("every conversion that deletes and re-creates goes through callConversion_, so a failure is announced to the person", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../docs/app.js"), "utf8");
  for (const action of ["convertLoanToEntry", "convertRepaymentToEntry"]) {
    assert.match(app, new RegExp(`callConversion_\\("${action}"`), action + " is called through callConversion_");
    assert.doesNotMatch(app, new RegExp(`callApi\\("${action}"`), action + " is never called raw");
  }
  assert.match(app, /result = await callConversion_\(fromRepayment \? "convertRepaymentToLoan"/);
  assert.match(app, /async function callConversion_[\s\S]{0,200}alert\(err\.message\)/, "a failure is shown as a message, not only a red line");
});

// ---- A repayment with an EXTRA entry (the part beyond the debt): it is ONE total, so it all goes together ----

function withExtra() {
  const { rt, data, f, pm, cat } = setup();
  const income = cat("income");
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id });
  const row = rt.rows("Settlements").find((s) => s.transfer_entry_id);
  return { rt, data, f, pm, cat, movementId: row.transfer_entry_id, extraId: row.gap_entry_id };
}

test("getEntryRepaymentLinks tells the screen about the extra entry", () => {
  const { rt, movementId, extraId } = withExtra();
  assert.ok(extraId, "the repayment has an extra entry");
  const links = rt.api("getEntryRepaymentLinks", { id: movementId });
  assert.equal(links.repayment.total, 30);
  assert.equal(links.repayment.extra.id, extraId);
  assert.equal(links.repayment.extra.amount, 20);
});

test("converting to an income replaces the WHOLE repayment: the money entry and the extra both go", () => {
  const { rt, data, pm, cat, movementId, extraId } = withExtra();
  const out = rt.api("convertRepaymentToEntry", {
    entry_id: movementId, type: "income", date: today(), amount: 50, currency: "PEN", category_id: cat("income").id,
    description: "Really income", payment_method_id: pm, paid_by: data.payors[0].id
  });
  const ids = rt.rows("Entries").map((e) => e.id);
  assert.equal(ids.includes(movementId), false);
  assert.equal(ids.includes(extraId), false, "the extra does not stay behind as a second income");
  assert.equal(Number(out.entry.amount), 50);
});

test("converting to a loan also takes the extra with it", () => {
  const { rt, f, pm, movementId, extraId } = withExtra();
  rt.api("convertRepaymentToLoan", { entry_id: movementId, friend_id: f.id, direction: "i_owe_them", amount: 50, currency: "PEN", date: today(), payment_method_id: pm, description: "They lent me this" });
  assert.equal(rt.rows("Entries").some((e) => e.id === extraId), false);
  assert.equal(Number(rt.rows("Loans").find((l) => l.direction === "i_owe_them" && l.friend_id === f.id).amount), 50);
});

test("a failure puts the extra entry back too", () => {
  const { rt, data, pm, cat, movementId, extraId } = withExtra();
  rt.run("globalThis.__origDiscard2 = discardEntryWithRepayments_; discardEntryWithRepayments_ = function (id) { deleteRowsWhere_('Settlements', function (s) { return s.transfer_entry_id === id; }); deleteEntry_(id); throw new Error('boom'); };");
  try {
    assert.throws(() => rt.api("convertRepaymentToEntry", {
      entry_id: movementId, type: "income", date: today(), amount: 50, currency: "PEN", category_id: cat("income").id,
      description: "x", payment_method_id: pm, paid_by: data.payors[0].id
    }), /Nothing was changed/i);
  } finally {
    rt.run("discardEntryWithRepayments_ = globalThis.__origDiscard2;");
  }
  const ids = rt.rows("Entries").map((e) => e.id);
  assert.equal(ids.includes(movementId), true);
  assert.equal(ids.includes(extraId), true);
});
