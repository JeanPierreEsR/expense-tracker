// Overview's Loans card: loans and repayments with friends and banks as flows per person and currency. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
const loansOf = (rt, extra = {}) => rt.api("getPeriodSummary", { ...range, ...extra }).loans;

test("a loan given and a repayment received show as lent and repaid-to-you, per person, without touching the totals", () => {
  const { rt } = freshApp({ entries: 5 });
  const before = rt.api("getPeriodSummary", range).totals;
  assert.equal(before.loans, 0, "no loan movement: the Loans block is zero");
  const ana = rt.api("addFriend", { name: "Ana" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-10-05" });
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-06" });

  const loans = loansOf(rt);
  const row = loans.people.find((p) => p.name === "Ana");
  assert.deepEqual(row.lines, [{ currency: "PEN", borrowed: 0, lent: 200, paidBack: 0, receivedBack: 50, net: -150 }]);
  assert.deepEqual(loans.totals.find((l) => l.currency === "PEN").lent, 200);
  // loans are transfers: income, expenses and investments stay exactly as they were; the net moves by the loans' net (-200 + 50)
  const after = rt.api("getPeriodSummary", range).totals;
  assert.equal(after.income, before.income);
  assert.equal(after.expense, before.expense);
  assert.equal(after.investment, before.investment);
  assert.equal(after.loans, -150);
  assert.equal(Math.round((after.net - before.net) * 100) / 100, -150, "What's left includes the loans' net");
});

test("money borrowed and repaid by the owner reads the other way, in its own currency", () => {
  const { rt } = freshApp({ entries: 5 });
  const bea = rt.api("addFriend", { name: "Bea" });
  rt.api("addLoan", { friend_id: bea.id, direction: "i_owe_them", amount: 500, currency: "USD", date: "2026-10-02" });
  rt.api("recordRepayment", { friend_id: bea.id, direction: "i_owe_them", amount: 120, currency: "USD", date: "2026-10-20" });
  const row = loansOf(rt).people.find((p) => p.name === "Bea");
  assert.deepEqual(row.lines, [{ currency: "USD", borrowed: 500, lent: 0, paidBack: 120, receivedBack: 0, net: 380 }]);
});

test("only the period's own movements count, and a person with none in it does not appear", () => {
  const { rt } = freshApp({ entries: 5 });
  const cy = rt.api("addFriend", { name: "Cy" });
  rt.api("addLoan", { friend_id: cy.id, direction: "they_owe_me", amount: 80, currency: "PEN", date: "2026-09-10" });
  assert.ok(!loansOf(rt).people.some((p) => p.name === "Cy"), "September's loan is not in October");
  rt.api("recordRepayment", { friend_id: cy.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-10-12" });
  const row = loansOf(rt).people.find((p) => p.name === "Cy");
  assert.deepEqual(row.lines.map((l) => [l.lent, l.receivedBack, l.net]), [[0, 30, 30]], "only October's repayment");
});

test("a bank loan counts as borrowed, and each installment's principal as repaid by you", () => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const res = rt.api("saveBankLoan", {
    friend_name: "Test Bank", amount: 300, currency: "PEN", date: "2026-10-01", payment_method_id: pm.id, description: "Personal loan",
    installments: [
      { due_date: "2026-10-20", principal: 100, interest: 10, fees: 2 },
      { due_date: "2026-11-20", principal: 100, interest: 7, fees: 2 },
      { due_date: "2026-12-20", principal: 100, interest: 4, fees: 2 }
    ]
  });
  rt.api("recordInstallment", { id: res.installments[0].id, date: "2026-10-20", payment_method_id: pm.id, category_id: cat });
  const row = loansOf(rt).people.find((p) => p.name === "Test Bank");
  assert.deepEqual(row.lines, [{ currency: "PEN", borrowed: 300, lent: 0, paidBack: 100, receivedBack: 0, net: 200 }]);
});

test("nothing for a copy with no loans: the card has nothing to show", () => {
  const { rt } = freshApp({ entries: 5 });
  const loans = loansOf(rt, { startDate: "2020-01-01", endDate: "2020-01-31" });
  assert.deepEqual(loans, { people: [], totals: [] });
});

test("What's left is exactly income + loans - expenses - investments, loans in another currency converted by the rate table", () => {
  const { rt } = freshApp({ entries: 5 });
  const dee = rt.api("addFriend", { name: "Dee" });
  rt.api("addLoan", { friend_id: dee.id, direction: "i_owe_them", amount: 100, currency: "USD", date: "2026-10-03" });
  const rate = rt.run(`getRateForEntryCurrency_('USD', '2026-10-03')`);
  const t = rt.api("getPeriodSummary", range).totals;
  assert.ok(rate > 1, "the seed has a USD rate for the month");
  assert.ok(Math.abs(t.loans - 100 * rate) < 0.01, "100 USD borrowed counts at the month's rate");
  assert.ok(Math.abs(t.net - (t.income - t.expense - t.investment + t.loans)) < 0.001, "the four blocks add up");
});
