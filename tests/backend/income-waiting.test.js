// Income not received yet (2026-11-09): it counts on its date, the person owes it, and only the repayment moves an account. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
function setup() {
  const { rt } = freshApp({ entries: 10 });
  post(rt, "getMeta");
  const person = post(rt, "addPayor", { name: "Client Test" }).data;
  rt.run(`appendRowObject('Payment Methods', { id: 'w-pm', nickname: 'Wallet test', type: 'wallet', bank_id: '', last_4: '' });`);
  post(rt, "setPaymentMethodOpeningBalance", { id: "w-pm", balances: [{ currency: "PEN", amount: 500, date: "2026-09-01" }] });
  return { rt, person, pm: { id: "w-pm" } };
}
const waiting = (rt, person, extra = {}) => post(rt, "createEntry", Object.assign({ type: "income", date: "2026-10-05", amount: 100, currency: "PEN", category_id: "", description: "Design job", paid_by: person.id, payment_method_id: "ignored", income_waiting: true }, extra));
const loanOf = (rt, id) => rt.rows("Loans").find((l) => l.entry_id === id);
const entryOf = (rt, id) => rt.rows("Entries").find((e) => e.id === id);
const repay = (rt, person, pm, amount, extra = {}) => post(rt, "recordRepayment", Object.assign({ friend_id: person.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-10-20", payment_method_id: pm.id }, extra));
const balance = (rt, pm) => post(rt, "listPaymentMethodBalances", {}).data.find((r) => r.id === pm.id).balances[0].amount;

test("saved as confirmed income on its date, with no account, and the person owes it", () => {
  const { rt, person, pm } = setup();
  const before = balance(rt, pm);
  const e = waiting(rt, person, { due_date: "2026-11-01" }).data;
  const row = entryOf(rt, e.id);
  assert.equal(row.status, "confirmed");
  assert.equal(row.type, "income");
  assert.equal(row.payment_method_id, "");
  assert.equal(row.income_waiting, "1");
  const loan = loanOf(rt, e.id);
  assert.equal(loan.direction, "they_owe_me");
  assert.equal(Number(loan.amount), 100);
  assert.equal(loan.due_date, "2026-11-01");
  assert.equal(balance(rt, pm), before);
});

test("needs a person; refused for a company", () => {
  const { rt } = setup();
  assert.equal(post(rt, "createEntry", { type: "income", date: "2026-10-05", amount: 10, currency: "PEN", category_id: "", paid_by: "", income_waiting: true }).ok, false);
  assert.equal(rt.rows("Entries").filter((e) => e.income_waiting === "1").length, 0);
});

test("a general repayment covers it: the balance rises then, income is not counted twice, a part leaves the rest owed", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  const before = balance(rt, pm);
  const incomes = () => rt.rows("Entries").filter((x) => x.type === "income" && x.paid_by === person.id).length;
  repay(rt, person, pm, 40);
  assert.equal(balance(rt, pm), before + 40);
  assert.equal(entryOf(rt, e.id).income_waiting, "1");
  assert.equal(post(rt, "listExpectedRecurringItems").data.waitingIncome[0].remaining, 60);
  repay(rt, person, pm, 60);
  assert.equal(balance(rt, pm), before + 100);
  assert.equal(entryOf(rt, e.id).income_waiting, "paid");
  assert.equal(incomes(), 1);
  assert.equal(entryOf(rt, e.id).date, "2026-10-05");
  assert.deepEqual(post(rt, "listExpectedRecurringItems").data.waitingIncome, []);
});

test("the extra of a repayment does not change who paid income most recently", () => {
  const { rt, person, pm } = setup();
  waiting(rt, person);
  repay(rt, person, pm, 100, { date: "2026-11-05" });
  assert.equal(post(rt, "getMeta").data.payors.find((p) => p.id === person.id).last_income, "2026-10-05");
});

test("editing follows the debt; what is already paid is protected", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { amount: 150 } });
  assert.equal(Number(loanOf(rt, e.id).amount), 150);
  repay(rt, person, pm, 50);
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { amount: 20 } }).ok, false);
  assert.equal(Number(entryOf(rt, e.id).amount), 150);
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: false } }).ok, false);
});

test("an ordinary income can start waiting and a waiting one can stop", () => {
  const { rt, person } = setup();
  const e = post(rt, "createEntry", { type: "income", date: "2026-10-05", amount: 30, currency: "PEN", category_id: "", paid_by: person.id, payment_method_id: "x" }).data;
  assert.equal(loanOf(rt, e.id), undefined);
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: true } });
  assert.equal(entryOf(rt, e.id).income_waiting, "1");
  assert.equal(entryOf(rt, e.id).payment_method_id, "");
  assert.equal(Number(loanOf(rt, e.id).amount), 30);
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: false, payment_method_id: "x" } });
  assert.equal(loanOf(rt, e.id), undefined);
  assert.equal(entryOf(rt, e.id).income_waiting, "");
});

test("forgiving lowers the income instead of booking an expense; all of it removes the income", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  const expenses = () => rt.rows("Entries").filter((x) => x.type === "expense").length;
  const before = expenses();
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30 });
  assert.equal(Number(entryOf(rt, e.id).amount), 70);
  assert.equal(Number(loanOf(rt, e.id).amount), 70);
  assert.equal(expenses(), before);
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id });
  assert.equal(entryOf(rt, e.id), undefined);
  assert.equal(loanOf(rt, e.id), undefined);
  assert.equal(expenses(), before);
});

test("a repeat of a partial forgiving from the phone's queue is not taken twice", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  const id = "11111111-1111-4111-8111-111111111111";
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30, client_id: id });
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30, client_id: id });
  assert.equal(Number(entryOf(rt, e.id).amount), 70);
});

test("money waiting in Needs review with the same amount asks; yes records a repayment, not a second income", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "mail-1", type: "income", date: "2026-10-21", amount: 100, currency: "PEN", category_id: "", description: "Transfer received", payment_method_id: pm.id, paid_by: "", status: "pending", source: "email" })}); bumpVersion_('ENTRIES_VERSION');`);
  const item = post(rt, "listPendingEntries").data.find((x) => x.id === "mail-1");
  assert.equal(item.waiting_match.loan_id, loanOf(rt, e.id).id);
  const before = balance(rt, pm);
  const out = post(rt, "convertEntryToRepayment", { entry_id: "mail-1", friend_id: person.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-21", payment_method_id: pm.id, description: "Transfer received", require_owed: true, overpay_pending_ok: true, allocations: [{ loan_id: loanOf(rt, e.id).id, amount: 100 }] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(entryOf(rt, e.id).income_waiting, "paid");
  assert.equal(rt.rows("Entries").filter((x) => x.type === "income" && x.paid_by === person.id).length, 1);
  assert.equal(balance(rt, pm), before + 100);
});

test("a different amount does not ask", () => {
  const { rt, person, pm } = setup();
  waiting(rt, person);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "mail-2", type: "income", date: "2026-10-21", amount: 99, currency: "PEN", category_id: "", description: "Other", payment_method_id: pm.id, paid_by: "", status: "pending", source: "email" })}); bumpVersion_('ENTRIES_VERSION');`);
  assert.equal(post(rt, "listPendingEntries").data.find((x) => x.id === "mail-2").waiting_match, undefined);
});

test("its type cannot be changed while linked to the debt", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { type: "expense" } }).ok, false);
});
