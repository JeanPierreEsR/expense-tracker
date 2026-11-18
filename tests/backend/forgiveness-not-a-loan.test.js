// Forgiven money stops being a loan (owner, 2026-11-18): the loan's money out shrinks by what was forgiven, on the loan's own
// date, and the forgiveness keeps its expense (or income). Result counts the money once. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const OCT = { startDate: "2026-10-01", endDate: "2026-10-31" };
const DEC = { startDate: "2026-12-01", endDate: "2026-12-31" };
const both = { startDate: "2026-10-01", endDate: "2026-12-31" };

function setup(direction = "they_owe_me") {
  const { rt, data } = freshApp({ entries: 5 });
  const friend = rt.api("addFriend", { name: "Tito Test" });
  const loan = rt.api("addLoan", { friend_id: friend.id, direction, amount: 100, currency: "PEN", date: "2026-10-05" });
  const cat = data.cats.find((c) => c.type === (direction === "they_owe_me" ? "expense" : "income")).id;
  const sum = (r) => rt.api("getPeriodSummary", r).totals;
  return { rt, friend, loan, cat, sum };
}

test("lend 100, get 70 back, forgive 30: over both months Result moves by −30, not −60", () => {
  const { rt, friend, loan, cat, sum } = setup();
  const before = sum(both);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 70, currency: "PEN", date: "2026-10-20" });
  rt.api("forgiveLoan", { id: loan.id, category_id: cat, date: "2026-12-03" });
  const after = sum(both);
  // Before: lent 100 (−100). After: lent 70, got 70 back, expense 30 → −30 in all.
  assert.equal(before.loans, -100);
  assert.equal(after.loans, 0, "the loan part nets to zero");
  assert.equal(Math.round((after.expense - before.expense) * 100) / 100, 30, "the forgiveness is still an expense");
  assert.equal(Math.round((after.net - before.net) * 100) / 100, 70, "Result: from −100 to −30");
  // October: only the 70 that really was a loan (lent 70, got 70 back); December: the expense.
  const oct = rt.api("getPeriodSummary", OCT).loans.people.find((p) => p.name === "Tito Test").lines[0];
  assert.deepEqual([oct.lent, oct.receivedBack, oct.net], [70, 70, 0]);
  assert.equal(sum(DEC).loans, 0);
});

test("forgiving in two parts takes both off the original loan; deleting a part's expense brings it back", () => {
  const { rt, loan, cat, sum } = setup();
  rt.api("forgiveLoan", { id: loan.id, amount: 30, category_id: cat, date: "2026-12-03" });
  const part2 = rt.api("forgiveLoan", { id: loan.id, amount: 20, category_id: cat, date: "2026-12-04" });
  assert.equal(sum(OCT).loans, -50, "100 lent, 50 of it forgiven");
  rt.api("discardEntry", { id: part2.entry.id });
  assert.equal(sum(OCT).loans, -70, "the deleted part is owed again, so it is a loan again");
});

test("a debt the owner was forgiven: the money borrowed shrinks and the income stays", () => {
  const { rt, loan, cat, sum } = setup("i_owe_them");
  const before = sum(both);
  rt.api("forgiveLoan", { id: loan.id, category_id: cat, date: "2026-12-03" });
  const after = sum(both);
  assert.equal(sum(OCT).loans, 0, "nothing of the 100 is a loan any more");
  assert.equal(Math.round((after.income - before.income) * 100) / 100, 100);
  assert.equal(Math.round((after.net - before.net) * 100) / 100, 0, "borrowed +100 became income +100: still +100 overall");
});
