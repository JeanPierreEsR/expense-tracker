// "Is this your Salary for August?" (owner's plan, 2026-11-17, after the journeys run: Andrés's salary planned for the 3rd and typed on
// the 28th was counted twice in Projections). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const month = today().slice(0, 7);
function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-sal', name: 'PM salary', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Recurring Expenses', function () { return true; });`);
  rt.run(`appendRowObject('Recurring Expenses', { id: 'rec-sal', description: 'Salary', category_id: 'cat-sal', amount: 9800, currency: 'PEN', frequency: 'monthly', day_of_month: 3, active: 'true', start_date: '${month}-01' });`);
  return rt;
}
const save = (rt, f) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "income", date: `${month}-28`, amount: 9800, currency: "PEN", category_id: "cat-sal", description: "Pay Prueba", paid_by: "me" }, f) });

test("a salary typed on another day than planned is offered as that month's Salary", () => {
  const rt = setup();
  const out = save(rt, {});
  assert.deepEqual(out.plan_ask, { recurring_id: "rec-sal", description: "Salary", month });
});

test("nothing is asked when the amount is far off, the category differs, or the month is already paid", () => {
  let rt = setup();
  assert.equal(save(rt, { amount: 5000 }).plan_ask, undefined);
  rt = setup();
  rt.run(`appendRowObject('Categories', { id: 'cat-other', name: 'PM other', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  assert.equal(save(rt, { category_id: "cat-other" }).plan_ask, undefined);
  rt = setup();
  const first = save(rt, {});
  rt.api("linkEntryToRecurring", { entryId: first.id, recurringExpenseId: "rec-sal" });
  assert.equal(save(rt, { date: `${month}-27` }).plan_ask, undefined);
});

test("a waiting item carries the same suggestion, and confirming with it links the payment", () => {
  const rt = setup();
  rt.run(`appendRowObject('Entries', { id: 'pend-1', type: 'income', date: '${month}-28', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay Prueba', paid_by: 'me', status: 'pending', source: 'email' });`);
  const p = rt.api("listPendingEntries", {}).find((e) => e.id === "pend-1");
  assert.equal(p.plan_match.recurring_id, "rec-sal");
  rt.api("saveEntryAll", { kind: "confirm", id: "pend-1", fields: {}, link_recurring_id: "rec-sal" });
  const e = JSON.parse(rt.run(`JSON.stringify(getEntryById_('pend-1'))`));
  assert.equal(e.recurring_expense_id, "rec-sal");
  assert.equal(e.status, "confirmed");
});
