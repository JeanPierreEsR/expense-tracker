// Deleting a WHOLE repayment from its own screen (deleteRepayment): loans part, money movement and extra entry together.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup(repaid = 50) {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Del Friend " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const income = data.cats.find((c) => c.type === "income");
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: f.id, direction: "they_owe_me", amount: repaid, currency: "PEN", date: today(), payment_method_id: pm, overpay_category_id: income.id });
  const row = rt.rows("Settlements").find((s) => s.transfer_entry_id);
  const owed = () => {
    const l = rt.rows("Loans").find((x) => x.id === loan.id);
    return Number(l.amount) - rt.rows("Settlements").filter((s) => s.loan_id === loan.id).reduce((n, s) => n + Number(s.amount), 0);
  };
  const exists = (id) => rt.rows("Entries").some((e) => e.id === id);
  return { rt, f, pm, loan, row, owed, exists, movementId: row.transfer_entry_id, extraId: row.gap_entry_id };
}

test("deleting a repayment with an extra removes BOTH entries and reopens the debt", () => {
  const { rt, row, owed, exists, movementId, extraId } = setup(50);
  assert.ok(extraId);
  assert.equal(owed(), 0);
  rt.api("deleteRepayment", { id: row.id });
  assert.equal(exists(movementId), false);
  assert.equal(exists(extraId), false, "the extra goes with it");
  assert.equal(rt.rows("Settlements").some((s) => s.id === row.id), false);
  assert.equal(owed(), 30, "what it paid is owed again");
});

test("a repayment with no extra is deleted the same way", () => {
  const { rt, row, owed, exists, movementId } = setup(20);
  assert.equal(owed(), 10);
  rt.api("deleteRepayment", { id: row.id });
  assert.equal(exists(movementId), false);
  assert.equal(owed(), 30);
});

test("an automatic cancel-out line cannot be deleted this way, and something that is not a repayment is refused", () => {
  const { rt } = setup(20);
  assert.throws(() => rt.api("deleteRepayment", { id: "nope" }), /not a repayment/i);
});

test("a failure puts the whole repayment back (rows, money entry, extra) and says so", () => {
  const { rt, row, owed, exists, movementId, extraId } = setup(50);
  const before = JSON.stringify({ s: rt.rows("Settlements").map((x) => [x.id, x.amount]).sort(), n: rt.rows("Entries").length });
  rt.run(`globalThis.__origDel = deleteEntry_; deleteEntry_ = function (id) { if (id === ${JSON.stringify(extraId)}) throw new Error('boom'); return globalThis.__origDel(id); };`);
  try {
    assert.throws(() => rt.api("deleteRepayment", { id: row.id }), /Nothing was changed/i);
  } finally {
    rt.run("deleteEntry_ = globalThis.__origDel;");
  }
  assert.equal(exists(movementId), true);
  assert.equal(exists(extraId), true);
  assert.equal(JSON.stringify({ s: rt.rows("Settlements").map((x) => [x.id, x.amount]).sort(), n: rt.rows("Entries").length }), before);
  assert.equal(owed(), 0, "the repayment still counts");
});

test("getEntryRepaymentLinks gives the screen what it needs to open the repayment from either entry", () => {
  const { rt, f, movementId, extraId } = setup(50);
  const money = rt.api("getEntryRepaymentLinks", { id: movementId });
  assert.equal(money.repayment.friend_id, f.id);
  assert.equal(money.repayment.entry_id, movementId);
  const extra = rt.api("getEntryRepaymentLinks", { id: extraId });
  assert.equal(extra.repaymentExtra.friend_id, f.id);
  assert.equal(extra.repaymentExtra.transfer_entry_id, movementId);
});
