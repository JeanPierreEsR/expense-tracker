// Business pack, step 3A (specs/business.md § Step 3): expected payments with an invoice number, the income that settles
// them, and "choose which loans this pays" (FIFO stays the default). Made-up data on the fake Google layer.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup(opts = {}) {
  const { rt } = freshApp({ entries: 30 });
  rt.run(`appendRowObject('Categories', { id: 'cat-x', name: 'Materials test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-y', name: 'Fees test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  if (opts.on !== false) rt.api("setBusinessFeatures", { on: true });
  return rt;
}
const company = (rt, name = "Studio A") => rt.api("addCompany", { name });
const project = (rt, company_id, name) => rt.api("addProject", { company_id, name });
const base = { date: "2026-10-05", currency: "PEN", category_id: "cat-y", paid_by: "me" };
const today = "2026-10-15";
const expected = (rt, proj, over = {}) => rt.api("addExpectedPayment", { project_id: proj.id, amount: 2000, currency: "USD", due_date: "2026-11-15", invoice_no: "F001-0123", ...over });
const list = (rt, payload) => rt.api("listExpectedPayments", { today, ...payload });
const income = (rt, proj, amount, expected_payment_id, over = {}) =>
  rt.api("createEntry", { type: "income", ...base, currency: "USD", amount, description: "Payment", project_id: proj.id, expected_payment_id, ...over });

test("OFF: no expected-payments tab or entry column is created and every action refuses", () => {
  const rt = setup({ on: false });
  for (const action of ["listExpectedPayments", "addExpectedPayment", "updateExpectedPayment", "coverExpectedPayment", "deleteExpectedPayment"]) {
    assert.throws(() => rt.api(action, { id: "x", project_id: "p", amount: 1, due_date: "2026-11-01" }), /turned off/i, action);
  }
  assert.ok(!rt.run(`!!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Expected Payments')`));
  assert.deepEqual(rt.api("getMeta", {}).expectedPayments, []);
  const e = rt.api("createEntry", { type: "income", ...base, amount: 10, expected_payment_id: "ghost" });
  assert.ok(!e.expected_payment_id);
  assert.ok(!rt.run(`getHeaders(getSheet('Entries'))`).includes("expected_payment_id"));
});

test("an expected payment is a reminder: it is checked, listed with its invoice number, and counts as income nowhere", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  assert.throws(() => expected(rt, casa, { amount: 0 }), /valid amount/i);
  assert.throws(() => expected(rt, casa, { due_date: "" }), /due/i);
  assert.throws(() => expected(rt, casa, { due_date: "2026-02-31" }), /due/i);
  assert.throws(() => expected(rt, casa, { currency: "DOLLARS" }), /3-letter/i);
  assert.throws(() => expected(rt, { id: "ghost" }), /Project not found/i);
  const x = expected(rt, casa);
  assert.equal(x.state, "open");
  assert.equal(x.remaining, 2000);
  assert.equal(x.invoice_no, "F001-0123");
  assert.equal(x.project_name, "Casa Lima");
  assert.equal(x.company_name, "Studio A");
  const detail = rt.api("getProjectDetail", { id: casa.id, today });
  assert.equal(detail.expected.length, 1);
  assert.ok(detail.currencies.every((c) => c.income === 0), "an expected payment is never income");
  assert.equal(rt.api("getCompanyDetail", { id: co.id, today }).expected.length, 1);
  // due_date stays text, not a Sheets Date
  assert.equal(rt.rows("Expected Payments")[0].due_date, "2026-11-15");
});

test("income linked to it settles it, part by part; an overdue one says so", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id, "Casa Lima");
  const x = expected(rt, casa, { due_date: "2026-10-01" });
  assert.equal(list(rt, { project_id: casa.id }).items[0].overdue, true);
  income(rt, casa, 800, x.id);
  let row = list(rt, { project_id: casa.id }).items[0];
  assert.equal(row.paid, 800);
  assert.equal(row.remaining, 1200);
  assert.equal(row.state, "open");
  income(rt, casa, 1200, x.id);
  row = list(rt, { project_id: casa.id }).items[0];
  assert.equal(row.state, "settled");
  assert.equal(row.remaining, 0);
  assert.equal(row.overdue, false);
  assert.deepEqual(list(rt, { project_id: casa.id, open: true }).items, [], "a settled one is no longer expected");
});

test("the link is kept only for an income on the same project and in the same currency", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const x = expected(rt, casa);
  assert.ok(income(rt, casa, 100, x.id).expected_payment_id);
  assert.ok(!income(rt, torre, 100, x.id).expected_payment_id, "another project");
  assert.ok(!income(rt, casa, 100, x.id, { currency: "PEN" }).expected_payment_id, "another currency");
  const expense = rt.api("createEntry", { type: "expense", ...base, category_id: "cat-x", currency: "USD", amount: 5, project_id: casa.id, expected_payment_id: x.id });
  assert.ok(!expense.expected_payment_id, "an expense settles nothing");
  // editing: moving the income to another project, or turning it into an expense, drops the link
  const e = income(rt, casa, 300, x.id);
  rt.api("updateEntry", { id: e.id, fields: { project_id: torre.id, company_id: co.id, expected_payment_id: x.id } });
  assert.equal(rt.rows("Entries").find((r) => r.id === e.id).expected_payment_id, "");
  const e2 = income(rt, casa, 300, x.id);
  rt.api("updateEntry", { id: e2.id, fields: { type: "expense" } });
  assert.equal(rt.rows("Entries").find((r) => r.id === e2.id).expected_payment_id, "");
});

test("changing the income's currency stops it counting; a linked payment's project and currency are locked", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const x = expected(rt, casa);
  const e = income(rt, casa, 500, x.id);
  assert.equal(list(rt, { project_id: casa.id }).items[0].paid, 500);
  assert.throws(() => rt.api("updateExpectedPayment", { id: x.id, project_id: casa.id, amount: 2000, currency: "PEN", due_date: "2026-11-15" }), /can't change/i);
  assert.equal(rt.api("updateExpectedPayment", { id: x.id, project_id: casa.id, amount: 2500, currency: "USD", due_date: "2026-12-01", invoice_no: "F001-0124" }).remaining, 2000);
  rt.api("updateEntry", { id: e.id, fields: { currency: "PEN" } });
  assert.equal(list(rt, { project_id: casa.id }).items[0].paid, 0, "an income in another currency is not counted");
});

test("covering closes it by hand (and can be undone); deleting it keeps the income and drops the link", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id, "Casa Lima");
  const x = expected(rt, casa);
  rt.api("coverExpectedPayment", { id: x.id });
  assert.equal(list(rt, { project_id: casa.id }).items[0].state, "covered");
  assert.deepEqual(list(rt, { project_id: casa.id, open: true }).items, []);
  rt.api("coverExpectedPayment", { id: x.id, covered: false });
  assert.equal(list(rt, { project_id: casa.id }).items[0].state, "open");
  const e = income(rt, casa, 700, x.id);
  rt.api("deleteExpectedPayment", { id: x.id });
  assert.deepEqual(list(rt, { project_id: casa.id }).items, []);
  const kept = rt.rows("Entries").find((r) => r.id === e.id);
  assert.ok(kept && !kept.expected_payment_id, "the income stays, without the link");
  assert.throws(() => rt.api("deleteExpectedPayment", { id: x.id }), /not found/i);
});

test("deleting a project removes its expected payments and the links to them", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const x = expected(rt, casa);
  const e = income(rt, casa, 100, x.id);
  rt.api("deleteProject", { id: casa.id });
  assert.equal(rt.rows("Expected Payments").length, 0);
  assert.equal(rt.rows("Entries").find((r) => r.id === e.id).expected_payment_id, "");
});

test("the Home card: what is still open and due up to the end of this month, overdue first, totalled per currency", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const late = expected(rt, casa, { due_date: "2026-09-20", amount: 500, currency: "PEN", invoice_no: "F001-0001" });
  expected(rt, casa, { due_date: "2026-10-28", amount: 1000, currency: "USD" });
  expected(rt, torre, { due_date: "2026-10-30", amount: 300, currency: "USD" });
  expected(rt, torre, { due_date: "2026-11-02", amount: 9999, currency: "USD" });   // next month: not on this card
  const done = expected(rt, torre, { due_date: "2026-10-10", amount: 50, currency: "USD" });
  rt.api("coverExpectedPayment", { id: done.id });
  const home = rt.api("listExpectedPayments", { scope: "home", today });
  assert.deepEqual(home.items.map((i) => i.due_date), ["2026-09-20", "2026-10-28", "2026-10-30"], "oldest due first, so overdue ones lead");
  assert.equal(home.items[0].id, late.id);
  assert.deepEqual(home.totals, [{ currency: "PEN", remaining: 500 }, { currency: "USD", remaining: 1300 }]);
});

test("the backup and the phone's copy carry the new tab and the link", () => {
  const rt = setup();
  const casa = project(rt, company(rt).id, "Casa Lima");
  const x = expected(rt, casa);
  income(rt, casa, 100, x.id);
  assert.equal(rt.api("getMeta", {}).expectedPayments.length, 1);
  assert.ok(rt.run(`EXPORT_BACKUP_TABS_.indexOf('Expected Payments') !== -1`));
  assert.ok(rt.run(`STRUCTURE_SHEETS_['Expected Payments'] === true`));
});

// ---- "Choose which loans this pays" ----

function loansSetup() {
  const rt = setup();
  const ana = rt.api("addFriend", { name: "Ana Loan" });
  const l1 = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-08-01" });
  const l2 = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-09-01" });
  const l3 = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 300, currency: "PEN", date: "2026-10-01" });
  return { rt, ana, l1, l2, l3 };
}
const remainingOf = (rt, id) => {
  const loan = rt.rows("Loans").find((l) => l.id === id);
  const paid = rt.rows("Settlements").filter((s) => s.loan_id === id).reduce((n, s) => n + Number(s.amount), 0);
  return Number(loan.amount) - paid;
};
const repay = (rt, ana, amount, extra = {}) =>
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-10-10", ...extra });

test("without a choice, a repayment is FIFO exactly as before", () => {
  const { rt, ana, l1, l2, l3 } = loansSetup();
  repay(rt, ana, 150);
  assert.equal(remainingOf(rt, l1.id), 0);
  assert.equal(remainingOf(rt, l2.id), 150);
  assert.equal(remainingOf(rt, l3.id), 300);
});

test("a chosen loan gets exactly what was assigned; the rest of the payment continues FIFO over the others", () => {
  const { rt, ana, l1, l2, l3 } = loansSetup();
  repay(rt, ana, 250, { allocations: [{ loan_id: l3.id, amount: 200 }] });
  assert.equal(remainingOf(rt, l3.id), 100, "the chosen one got 200");
  assert.equal(remainingOf(rt, l1.id), 50, "the other 50 went FIFO: the oldest loan");
  assert.equal(remainingOf(rt, l2.id), 200, "the second loan was not touched");
  // one transfer entry for the real money, the full amount
  const transfers = rt.rows("Entries").filter((e) => e.type === "transfer" && e.date === "2026-10-10" && /Ana Loan/.test(e.description));
  assert.equal(transfers.length, 1);
  assert.equal(Number(transfers[0].amount), 250);
});

test("choosing loans is checked before anything is written", () => {
  const { rt, ana, l1, l2 } = loansSetup();
  const before = rt.rows("Settlements").length;
  assert.throws(() => repay(rt, ana, 100, { allocations: [{ loan_id: l1.id, amount: 150 }] }), /more than this loan still owes/i);
  assert.throws(() => repay(rt, ana, 100, { allocations: [{ loan_id: l1.id, amount: 60 }, { loan_id: l2.id, amount: 60 }] }), /more than the payment/i);
  assert.throws(() => repay(rt, ana, 100, { allocations: [{ loan_id: l1.id, amount: 10 }, { loan_id: l1.id, amount: 10 }] }), /once/i);
  assert.throws(() => repay(rt, ana, 100, { allocations: [{ loan_id: "ghost", amount: 10 }] }), /once/i);
  assert.throws(() => repay(rt, ana, 100, { allocations: [{ loan_id: l1.id, amount: 0 }] }), /once/i);
  assert.equal(rt.rows("Settlements").length, before, "nothing was written");
});

test("a chosen repayment does not net against the opposite debt behind the person's back", () => {
  const { rt, ana, l1, l2 } = loansSetup();
  const back = rt.api("addLoan", { friend_id: ana.id, direction: "i_owe_them", amount: 80, currency: "PEN", date: "2026-07-01" });
  repay(rt, ana, 100, { allocations: [{ loan_id: l2.id, amount: 100 }] });
  assert.equal(remainingOf(rt, l2.id), 100);
  assert.equal(remainingOf(rt, l1.id), 100, "FIFO's oldest loan was not touched");
  assert.equal(remainingOf(rt, back.id), 80, "no offsetting happened");
});

test("a choice combined with a project: only that project's loans can be chosen", () => {
  const rt = setup();
  const co = company(rt);
  const casa = project(rt, co.id, "Casa Lima");
  const torre = project(rt, co.id, "Torre Sur");
  const ana = rt.api("addFriend", { name: "Ana Client", role: "client" });
  const a = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-08-01", project_id: casa.id });
  const b = rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-08-02", project_id: torre.id });
  assert.throws(() => repay(rt, ana, 50, { project_id: casa.id, allocations: [{ loan_id: b.id, amount: 50 }] }), /once/i);
  repay(rt, ana, 50, { project_id: casa.id, allocations: [{ loan_id: a.id, amount: 50 }] });
  assert.equal(remainingOf(rt, a.id), 50);
  assert.equal(remainingOf(rt, b.id), 100);
});
