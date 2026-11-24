// Rows typed by hand in the Sheet that do not add up (testers 2.68.2, Ingrid; owner's choice 2026-11-24: flag them, change
// nothing), and "Choose who this is" for loans typed for someone not in Friends. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ entries: 40 });
  const pm = run(rt, "getAllRows('Payment Methods')").find((p) => p.type === "debit").id;
  const f = rt.api("addFriend", { name: "Made-up Ana" });
  const loan = rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  return { rt, pm, f, loan };
}

test("a repayment typed larger than its loan, and one for a loan that does not exist, are flagged and change nothing", () => {
  const { rt, f, loan } = setup();
  rt.run(`appendRowObject('Settlements', { id: 'hand-s1', loan_id: ${JSON.stringify(loan.id)}, date: '2026-02-01', amount: 500 })`);
  rt.run(`appendRowObject('Settlements', { id: 'hand-s2', loan_id: 'no-such-loan', date: '2026-02-01', amount: 10 })`);
  const r = rt.api("listLoanBalances", { withUnreadable: true });
  assert.deepEqual(r.sheet_check.over, [{ friend_id: f.id, friend_name: "Made-up Ana", currency: "PEN", extra: 460 }]);
  assert.equal(r.sheet_check.orphan_repayments, 1);
  assert.equal(r.balances.some((b) => b.friend_id === f.id), false, "the person still reads as settled");
});

test("nothing to flag on a clean copy", () => {
  const { rt } = setup();
  const r = rt.api("listLoanBalances", { withUnreadable: true });
  assert.deepEqual(r.sheet_check.over, []);
  assert.equal(r.sheet_check.orphan_repayments, 0);
});

test("loans typed for someone not in Friends are marked unknown and can be given to a friend or a new one", () => {
  const { rt, f } = setup();
  rt.run(`appendRowObject('Loans', { id: 'ghost-l1', friend_id: 'ghost-friend', direction: 'i_owe_them', amount: 999, currency: 'PEN', date: '2026-01-05', status: 'open' })`);
  let row = rt.api("listLoanBalances", { withUnreadable: true }).balances.find((b) => b.friend_id === "ghost-friend");
  assert.equal(row.unknown, true);
  assert.equal(row.friend_name, "(unknown friend)");
  assert.equal(rt.api("listLoanBalances", { withUnreadable: true }).balances.find((b) => b.friend_id === f.id).unknown, false);
  const res = rt.api("assignUnknownFriend", { friend_id: "ghost-friend", to_friend_id: f.id });
  assert.equal(res.moved, 1);
  const bal = rt.api("listLoanBalances", { withUnreadable: true }).balances;
  assert.equal(bal.some((b) => b.friend_id === "ghost-friend"), false);
  assert.deepEqual(bal.find((b) => b.friend_id === f.id).balances.map((l) => l.net), [40 - 999]);
  assert.throws(() => rt.api("assignUnknownFriend", { friend_id: "ghost-friend", to_friend_id: f.id }), /already belong/);
});

test("a new friend made from the window takes the loans; an existing friend's id is refused", () => {
  const { rt, f } = setup();
  rt.run(`appendRowObject('Loans', { id: 'ghost-l2', friend_id: 'ghost-2', direction: 'they_owe_me', amount: 15, currency: 'PEN', date: '2026-01-06', status: 'open' })`);
  const res = rt.api("assignUnknownFriend", { friend_id: "ghost-2", new_name: "Made-up Luis" });
  assert.equal(res.friend.name, "Made-up Luis");
  const row = rt.api("listLoanBalances", { withUnreadable: true }).balances.find((b) => b.friend_id === res.friend.id);
  assert.equal(row.unknown, false);
  assert.equal(row.balances[0].net, 15);
  assert.throws(() => rt.api("assignUnknownFriend", { friend_id: f.id, to_friend_id: res.friend.id }), /already belong/);
});
