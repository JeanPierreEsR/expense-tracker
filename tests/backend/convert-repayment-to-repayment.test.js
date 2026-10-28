// A repayment's money entry edited as a repayment and re-recorded (convertRepaymentToRepayment). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const tag = Math.random().toString(36).slice(2, 6);
  const ana = rt.api("addFriend", { name: "Rerec Ana " + tag });
  const bo = rt.api("addFriend", { name: "Rerec Bo " + tag });
  const pm = data.pms[3].id;
  const pm2 = data.pms[4].id;
  const income = data.cats.find((c) => c.type === "income");
  const loan = (f, amount) => rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const owed = (id) => {
    const l = rt.rows("Loans").find((x) => x.id === id);
    return Number(l.amount) - rt.rows("Settlements").filter((s) => s.loan_id === id).reduce((n, s) => n + Number(s.amount), 0);
  };
  const aLoan = loan(ana, 100);
  const bLoan = loan(bo, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
  const movementId = rt.rows("Settlements").find((s) => s.transfer_entry_id).transfer_entry_id;
  const rerecord = (extra = {}) => rt.api("convertRepaymentToRepayment", {
    entry_id: movementId, friend_id: bo.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: today(),
    payment_method_id: pm2, description: "Re-recorded", overpay_category_id: income.id, ...extra
  });
  const exists = (id) => rt.rows("Entries").some((e) => e.id === id);
  return { rt, ana, bo, pm, pm2, income, aLoan, bLoan, owed, movementId, rerecord, exists };
}

test("recorded against the wrong person: Ana's debt reopens and Bo's is paid instead", () => {
  const { rt, aLoan, bLoan, owed, movementId, rerecord, exists, pm2 } = setup();
  assert.equal(owed(aLoan.id), 60);
  rerecord();
  assert.equal(exists(movementId), false, "the old money entry is gone");
  assert.equal(owed(aLoan.id), 100, "Ana owes everything again");
  assert.equal(owed(bLoan.id), 60, "Bo's debt took the payment");
  const newMovement = rt.rows("Settlements").find((s) => s.loan_id === bLoan.id).transfer_entry_id;
  assert.equal(rt.rows("Entries").find((e) => e.id === newMovement).to_payment_method_id || rt.rows("Entries").find((e) => e.id === newMovement).payment_method_id, pm2);
});

test("same person, different amount", () => {
  const { aLoan, ana, owed, rerecord } = setup();
  rerecord({ friend_id: ana.id, amount: 70 });
  assert.equal(owed(aLoan.id), 30);
});

test("more than was owed: the extra waits in Needs review or is booked with the chosen category", () => {
  const { rt, ana, aLoan, owed, rerecord, income } = setup();
  const out = rerecord({ friend_id: ana.id, amount: 130 });
  assert.equal(owed(aLoan.id), 0);
  assert.equal(out.overpaid, 30);
  assert.equal(rt.rows("Entries").filter((e) => e.type === "income" && Number(e.amount) === 30 && e.category_id === income.id).length, 1);
});

test("an entry that is not a repayment's, or a missing extra category, is refused and nothing changes", () => {
  const { rt, aLoan, owed, movementId, rerecord, exists, data, pm } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: "x", description: "x", payment_method_id: pm, paid_by: "me" });
  assert.throws(() => rerecord({ entry_id: e.id }), /not a repayment/i);
  assert.throws(() => rerecord({ overpay_category_id: "" }), /category for any extra/i);
  assert.equal(exists(movementId), true);
  assert.equal(owed(aLoan.id), 60);
});

test("a failure while recording the new repayment puts the old one back exactly", () => {
  const { rt, aLoan, bLoan, owed, movementId, rerecord, exists } = setup();
  const snap = () => JSON.stringify({
    settlements: rt.rows("Settlements").map((s) => [s.id, s.loan_id, s.amount]).sort(),
    entries: rt.rows("Entries").length,
    old: (rt.rows("Entries").find((e) => e.id === movementId) || {}).amount
  });
  const before = snap();
  rt.run("globalThis.__origRec = recordRepayment; recordRepayment = function () { throw new Error('boom'); };");
  try {
    assert.throws(() => rerecord(), /Nothing was changed/i);
  } finally {
    rt.run("recordRepayment = globalThis.__origRec;");
  }
  assert.equal(exists(movementId), true);
  assert.equal(snap(), before);
  assert.equal(owed(aLoan.id), 60, "Ana's payment still counts");
  assert.equal(owed(bLoan.id), 100);
});
