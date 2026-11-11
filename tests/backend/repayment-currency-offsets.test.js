// A repayment's currency is changed by re-recording it, never by relabelling its entry; and an automatic cancel-out is ONE
// line in the repayment history (owner, 2026-11-10). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const setup = () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  const pm = data.pms[3].id;
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 300, currency: "USD", date: "2026-01-01", payment_method_id: pm, description: "Dollar loan" });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 300, currency: "PEN", date: "2026-01-02", payment_method_id: pm, description: "Soles loan" });
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 100, date: "2026-03-01", currency: "USD", payment_method_id: pm });
  const history = () => rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  const left = (desc) => history().loans.find((l) => l.description === desc).remaining;
  return { rt, data, friend, pm, history, left };
};

test("a plain edit cannot change a repayment's currency (it used to relabel the entry and leave the repayment on the old loan)", () => {
  const { rt, history, left } = setup();
  const tid = history().repayments[0].transfer_entry_id;
  assert.throws(() => rt.api("updateEntry", { id: tid, fields: { currency: "PEN" } }), /currency/);
  assert.equal(rt.rows("Entries").find((e) => e.id === tid).currency, "USD");
  assert.equal(left("Dollar loan"), 200);
  rt.api("updateEntry", { id: tid, fields: { currency: "USD", description: "same currency is fine" } });
});

test("re-recording a repayment in another currency moves it to that currency's loans", () => {
  const { rt, friend, pm, history, left } = setup();
  const tid = history().repayments[0].transfer_entry_id;
  rt.api("convertRepaymentToRepayment", { entry_id: tid, friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN",
    date: "2026-03-01", payment_method_id: pm, overpay_pending_ok: true });
  assert.equal(left("Dollar loan"), 300, "the dollar loan owes everything again");
  assert.equal(left("Soles loan"), 200);
  const lines = history().repayments.filter((r) => !r.is_offset);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].currency, "PEN");
  assert.equal(lines[0].date, "2026-03-01", "keeps its own date");
});

test("Telegram: a new currency on a repayment's entry is put back, with the reason", () => {
  const { rt, history } = setup();
  const tid = history().repayments[0].transfer_entry_id;
  const before = JSON.stringify(rt.rows("Entries").find((e) => e.id === tid));
  rt.run(`setEntryField_(${JSON.stringify(tid)}, 'currency', 'PEN')`);
  const msg = rt.run(`syncRepaymentAfterTelegramEdit_(${JSON.stringify(tid)}, ${before})`);
  assert.match(String(msg), /currency/);
  assert.equal(rt.rows("Entries").find((e) => e.id === tid).currency, "USD");
});

test("an automatic cancel-out is ONE history line for both loans, and undoing it frees both", () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Net Friend " + Math.random().toString(36).slice(2, 7) });
  const pm = data.pms[3].id;
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-01-01", payment_method_id: pm, description: "Internet bill" });
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: "2026-01-02", payment_method_id: pm, description: "Debt to them" });
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 10, date: "2026-03-01", currency: "PEN", payment_method_id: pm });
  const history = () => rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  const offsets = history().repayments.filter((r) => r.is_offset);
  assert.equal(offsets.length, 1, "two halves, one line");
  assert.equal(offsets[0].paired, true);
  assert.equal(offsets[0].amount, 30);
  assert.deepEqual([offsets[0].loan_description, offsets[0].offset_loan_description].sort(), ["Debt to them", "Internet bill"]);
  // the loans themselves still say how much was canceled out on each
  assert.equal(history().loans.find((l) => l.description === "Debt to them").offset, 30);
  rt.api("undoCancelOut", { id: offsets[0].id });
  assert.equal(history().repayments.filter((r) => r.is_offset).length, 0);
  assert.equal(history().loans.find((l) => l.description === "Debt to them").remaining, 30);
});
