// The Loans tab's "All loans and repayments" (listLoanMovements, 2026-11-11). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const allMoves = (rt, extra = {}) => {
  let items = [], offset = 0, page;
  do { page = rt.api("listLoanMovements", { ...extra, offset, limit: 3 }); items = items.concat(page.items); offset += 3; } while (page.more);
  return items;
};

test("every loan and repayment ever, newest first, with forgiving and canceled-out debts shown once and unsigned", () => {
  const { rt } = freshApp({ entries: 5 });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const ana = rt.api("addFriend", { name: "Ana" });
  const lent = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2025-03-01" });
  rt.api("addLoan", { friend_id: ana.id, direction: "i_owe_them", amount: 30, currency: "PEN", date: "2025-03-02" });
  // 30 cancels out against what I owed her (one line, from her side) and the 50 is real money back: she still owes 20
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2025-03-05" });
  rt.api("forgiveLoan", { id: (lent.loan || lent).id, amount: 10, category_id: cat, date: "2025-03-09" });
  const rows = allMoves(rt).filter((m) => m.friend_name === "Ana");
  assert.deepEqual(rows.map((m) => [m.date, m.kind, m.signed, m.amount]), [
    ["2025-03-09", "forgiven", 0, 10],
    ["2025-03-05", "canceledOut", 0, 30],
    ["2025-03-05", "receivedBack", 50, 50],
    ["2025-03-02", "borrowed", 30, 30],
    ["2025-03-01", "lent", -100, 100]
  ]);
});

test("the money lines are exactly the ones Overview's Loans block counts for the same days", () => {
  const { rt } = freshApp({ entries: 300 });
  const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const inRange = (m) => m.date >= range.startDate && m.date <= range.endDate && m.signed !== 0;
  const tab = allMoves(rt).filter(inRange).reduce((s, m) => s + m.signed, 0);
  let flows = [], offset = 0, page;
  do { page = rt.api("listPeriodFlows", { ...range, filter: "loans", offset, limit: 100 }); flows = flows.concat(page.items); offset += 100; } while (page.more);
  const ov = flows.reduce((s, x) => s + x.loan.signed, 0);
  assert.ok(Math.abs(tab - ov) < 0.01, `Loans tab ${tab} = Overview ${ov}`);
});
