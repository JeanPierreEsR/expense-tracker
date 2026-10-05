// Repayments are settled currency by currency: a USD repayment only ever touches
// that friend's USD loans (FIFO within USD), a PEN repayment only PEN loans.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Cur Friend " + Math.random().toString(36).slice(2, 6) });
  const mk = (amount, currency, date) => rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount, currency, date, payment_method_id: data.pms[3].id });
  return { rt, data, f, mk };
}
const remaining = (rt, loanId) => {
  const l = rt.rows("Loans").find((x) => x.id === loanId);
  const paid = rt.rows("Settlements").filter((s) => s.loan_id === loanId).reduce((a, s) => a + Number(s.amount), 0);
  return Number(l.amount) - paid;
};
const repay = (rt, data, f, amount, currency, direction = "they_owe_me") =>
  rt.api("recordRepayment", { friend_id: f.id, direction, amount, currency, date: today(), payment_method_id: data.pms[3].id });

test("a USD repayment only reduces USD loans, FIFO within USD", () => {
  const { rt, data, f, mk } = setup();
  const pen1 = mk(100, "PEN", "2026-01-01");
  const usd1 = mk(50, "USD", "2026-01-02");
  const usd2 = mk(50, "USD", "2026-02-01");

  repay(rt, data, f, 60, "USD");

  assert.equal(remaining(rt, pen1.id), 100, "PEN loan untouched");
  assert.equal(remaining(rt, usd1.id), 0, "oldest USD loan paid first");
  assert.equal(remaining(rt, usd2.id), 40, "next USD loan takes the rest");
});

test("PEN and USD repayments run independently of each other", () => {
  const { rt, data, f, mk } = setup();
  const pen1 = mk(100, "PEN", "2026-01-01");
  const usd1 = mk(100, "USD", "2026-01-01");

  repay(rt, data, f, 30, "PEN");
  repay(rt, data, f, 20, "USD");
  repay(rt, data, f, 10, "PEN");

  assert.equal(remaining(rt, pen1.id), 60);
  assert.equal(remaining(rt, usd1.id), 80);
});

test("opposite-direction loans only offset within the same currency", () => {
  const { rt, data, f, mk } = setup();
  const usdTheyOwe = mk(100, "USD", "2026-01-01");
  const penIOwe = rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 80, currency: "PEN", date: "2026-01-02", payment_method_id: data.pms[3].id });

  repay(rt, data, f, 100, "USD");

  assert.equal(remaining(rt, usdTheyOwe.id), 0);
  assert.equal(remaining(rt, penIOwe.id), 80, "my PEN debt is NOT netted against a USD repayment");
});

test("overpaying in USD never spills onto PEN loans", () => {
  const { rt, data, f, mk } = setup();
  const pen1 = mk(100, "PEN", "2026-01-01");
  const usd1 = mk(20, "USD", "2026-01-01");

  const res = repay(rt, data, f, 50, "USD");

  assert.equal(remaining(rt, usd1.id), 0);
  assert.equal(remaining(rt, pen1.id), 100, "PEN loan untouched by the USD overpayment");
  assert.ok(res, "the overpaid amount is reported back so it can be booked");
});
