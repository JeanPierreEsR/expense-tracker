// A debt from BEFORE the person started using the app ("opening" loan): only the debt is recorded, no money entry, no account,
// no automatic due date; the later repayment is the only thing that moves money. Both directions. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Opening Pal " + Math.random().toString(36).slice(2, 6) });
  const pm = data.pms[3].id;
  const entries = () => rt.rows("Entries").length;
  const owedBy = (loanId) => {
    const l = rt.rows("Loans").find((x) => x.id === loanId);
    return Number(l.amount) - rt.rows("Settlements").filter((s) => s.loan_id === loanId).reduce((n, s) => n + Number(s.amount), 0);
  };
  return { rt, f, pm, entries, owedBy };
}

for (const direction of ["i_owe_them", "they_owe_me"]) {
  test(`an opening debt (${direction}) makes no money entry, takes no account and has no due date`, () => {
    const { rt, f, pm, entries } = setup();
    const before = entries();
    const loan = rt.api("addLoan", { friend_id: f.id, direction, amount: 120, currency: "PEN", date: "2026-09-10", payment_method_id: pm, opening: true });
    assert.equal(entries(), before, "nothing was added to Home / the Entries tab");
    const row = rt.rows("Loans").find((l) => l.id === loan.id);
    assert.equal(row.transfer_entry_id, "");
    assert.equal(row.payment_method_id, "", "an account passed along is ignored: no money moved");
    assert.equal(row.due_date, "", "no automatic due date: it would be overdue from day one");
    assert.equal(String(row.opening), "1");
    assert.equal(row.origin, "cash");
    assert.equal(row.status, "outstanding");
  });

  test(`the repayment of an opening debt (${direction}) works, moves money once, and settles it`, () => {
    const { rt, f, pm, entries, owedBy } = setup();
    const loan = rt.api("addLoan", { friend_id: f.id, direction, amount: 120, currency: "PEN", date: "2026-09-10", opening: true });
    const before = entries();
    rt.api("recordRepayment", { friend_id: f.id, direction, amount: 120, currency: "PEN", date: today(), payment_method_id: pm });
    assert.equal(entries(), before + 1, "only the repayment's own money movement");
    assert.equal(owedBy(loan.id), 0);
    const loans = rt.api("getFriendLoanDetail", { friendId: f.id }).filter((l) => l.id === loan.id);
    assert.equal(loans[0].status, "repaid");
    const moved = rt.rows("Entries").slice(before)[0];
    assert.equal(moved.type, "transfer");
    assert.equal(moved.payment_method_id, pm);
  });

  test(`a partial repayment of an opening debt (${direction}) leaves the rest owed`, () => {
    const { rt, f, pm, owedBy } = setup();
    const loan = rt.api("addLoan", { friend_id: f.id, direction, amount: 100, currency: "PEN", date: "2026-09-10", opening: true });
    rt.api("recordRepayment", { friend_id: f.id, direction, amount: 40, currency: "PEN", date: today(), payment_method_id: pm });
    assert.equal(owedBy(loan.id), 60);
    const bal = rt.api("listLoanBalances", {}).find((b) => b.friend_id === f.id);
    const net = bal.balances.find((x) => x.currency === "PEN").net;
    assert.equal(net, direction === "they_owe_me" ? 60 : -60);
  });
}

test("an opening debt does not change any account balance; its repayment does, on the day it was made", () => {
  const { rt, f, pm } = setup();
  rt.api("setPaymentMethodOpeningBalance", { id: pm, balances: [{ currency: "PEN", amount: 1000, date: "2026-01-01" }] });
  const bal = () => rt.api("listPaymentMethodBalances", {}).find((b) => b.id === pm).balances.find((b) => b.currency === "PEN");
  const start = bal().amount;
  rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 80, currency: "PEN", date: "2026-09-10", payment_method_id: pm, opening: true });
  assert.equal(bal().amount, start, "the debt alone moves nothing");
  rt.api("recordRepayment", { friend_id: f.id, direction: "i_owe_them", amount: 80, currency: "PEN", date: today(), payment_method_id: pm });
  assert.equal(Math.round((bal().amount - start) * 100) / 100, -80, "paying it back takes the money out");
});

test("an opening debt can be edited (still no account / money entry) and deleted without touching any entry", () => {
  const { rt, f, pm, entries } = setup();
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 50, currency: "PEN", date: "2026-09-10", opening: true });
  const before = entries();
  rt.api("updateLoan", { id: loan.id, friend_id: f.id, direction: "i_owe_them", amount: 70, currency: "PEN", date: "2026-09-01", payment_method_id: pm, description: "rent share" });
  let row = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.equal(Number(row.amount), 70);
  assert.equal(row.payment_method_id, "", "an opening debt never takes an account, even when edited");
  assert.equal(String(row.opening), "1", "the marker survives an edit");
  assert.equal(entries(), before);
  rt.api("deleteLoan", { id: loan.id });
  assert.equal(rt.rows("Loans").some((l) => l.id === loan.id), false);
  assert.equal(entries(), before, "deleting it removes no entry (it had none)");
});

test("a normal loan still makes its money entry and gets the automatic due date", () => {
  const { rt, f, pm, entries } = setup();
  const before = entries();
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-10-01", payment_method_id: pm });
  assert.equal(entries(), before + 1);
  const row = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.ok(row.transfer_entry_id);
  assert.ok(row.due_date, "default due date kept");
  assert.notEqual(String(row.opening || ""), "1");
});

test("a repeat of the same opening save (same client_id) makes one debt", () => {
  const { rt, f } = setup();
  const id = "11111111-2222-3333-4444-555555555555";
  rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 10, currency: "PEN", date: "2026-09-10", opening: true, client_id: id });
  rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 10, currency: "PEN", date: "2026-09-10", opening: true, client_id: id });
  assert.equal(rt.rows("Loans").filter((l) => l.id === id).length, 1);
});

test("capability: a backend that understands opening debts says so (older ones lack it, so the app hides the switch)", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta").capabilities.openingLoan, true);
});
