// A bank loan's installments still to pay show in Projections, split in their two legs (owner, 2026-11-04): interest + fees are a
// programmed EXPENSE in their category; the principal is a LOAN payment on its own line, never an expense. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

// Due dates well after today, so every installment is still to pay in the months looked at.
const setup = () => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const res = rt.api("saveBankLoan", {
    friend_name: "Test Bank", amount: 300, currency: "PEN", date: "2027-01-02", payment_method_id: pm.id, description: "Test car loan",
    installments: [
      { due_date: "2027-02-05", principal: 100, interest: 10, fees: 2 },
      { due_date: "2027-03-05", principal: 100, interest: 7, fees: 2 },
      { due_date: "2027-04-05", principal: 100, interest: 4, fees: 2 }
    ]
  });
  return { rt, pm, ...res };
};
const month = (rt, anchorDate) => rt.api("getProjections", { displayPeriodType: "month", anchorDate });
const catRow = (rt, anchorDate, id) => rt.api("listCategoryProjections", { displayPeriodType: "month", anchorDate }).categories.find((c) => c.category_id === id);

test("an unpaid installment: its interest + fees are programmed expenses, its principal is on the Loans line", () => {
  const { rt } = setup();
  const before = (() => { const { rt: plain } = freshApp({ entries: 5 }); return month(plain, "2027-03-15"); })();
  const p = month(rt, "2027-03-15");
  assert.ok(Math.abs(p.expensesProgrammed - before.expensesProgrammed - 9) < 0.01, "interest 7 + fees 2 are programmed");
  assert.ok(Math.abs(p.loansProgrammed - 100) < 0.01, "the principal is a loan payment");
  assert.ok(Math.abs(p.loans - (-100)) < 0.01, "money going out on the Loans line");
  assert.ok(Math.abs((before.net - p.net) - 109) < 0.01, "What's left drops by the whole installment, once");
});

test("the interest goes to the Interest category when the loan has no history, and the drill-down lists it", () => {
  const { rt } = setup();
  const interest = rt.run("bankInterestFallbackCategory_()");
  assert.ok(interest, "there is a fallback category");
  const row = catRow(rt, "2027-02-15", interest);
  assert.ok(row && row.programmedRemainingPen >= 12 - 0.01, "interest 10 + fees 2 programmed in Interest");
  const detail = rt.api("getCategoryProjectionDetail", { displayPeriodType: "month", anchorDate: "2027-02-15", categoryId: interest });
  const item = detail.programmedBreakdown.items.find((i) => i.installments);
  assert.ok(item, "the installment is traced back in the category's drill-down");
  assert.ok(Math.abs(item.amountPen - 12) < 0.01);
  assert.match(item.description, /Test car loan/);
});

test("a paid installment is no longer programmed; its interest follows the category chosen when paying", () => {
  const { rt, pm, installments } = setup();
  const cat = rt.rows("Categories").find((c) => c.type === "expense" && c.name === "Groceries").id;
  rt.api("recordInstallment", { id: installments[0].id, date: "2027-02-05", payment_method_id: pm.id, category_id: cat });
  const p = month(rt, "2027-02-15");
  assert.ok(Math.abs(p.loansProgrammed) < 0.01, "nothing left to pay in February");
  const march = catRow(rt, "2027-03-15", cat);
  assert.ok(march && march.programmedRemainingPen >= 9 - 0.01, "March's interest goes where February's was filed");
});

test("the interest already paid is kept out of the usual-spending series (no double count)", () => {
  const { rt, pm, installments } = setup();
  const cat = rt.run("bankInterestFallbackCategory_()");
  const res = rt.api("recordInstallment", { id: installments[0].id, date: "2027-02-05", payment_method_id: pm.id, category_id: cat });
  const ids = rt.run("JSON.stringify(Object.keys(bankInstallmentEntryIds_()))");
  assert.ok(JSON.parse(ids).includes(res.extra_entry_id));
});
