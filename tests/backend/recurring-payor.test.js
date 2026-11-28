// "Received from" on a programmed income (owner, 2026-11-28; specs/recurring.md § Payer of a programmed income): saved only for an
// income item, shown by name; its payer's income counts as the payment even in another category, someone else's income never does,
// and "Mark as paid…" lists the payer's incomes first. Made-up names and amounts.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-rp-sal', name: 'Salary test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-rp-oth', name: 'Other income test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-rp-exp', name: 'Gym test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const ana = rt.api("addPayor", { name: "Ana Prueba" });
  const leo = rt.api("addPayor", { name: "Leo Prueba" });
  return { rt, data, ana, leo };
}
const day = () => Number(today().slice(8, 10));
const item = (rt, fields) => rt.api("addRecurringExpense", Object.assign({ category_id: "cat-rp-sal", description: "Retainer test", amount: 1234, currency: "PEN", frequency: "monthly", day: day() }, fields));
const listed = (rt, id) => rt.api("listRecurringExpenses", {}).find((r) => r.id === id) || (rt.api("listRecurringExpenses", {}).items || []).find((r) => r.id === id);
const income = (rt, data, payer, cat) => rt.api("createEntry", { type: "income", date: today(), amount: 1234, currency: "PEN", category_id: cat, description: "Transfer in", paid_by: payer, payment_method_id: data.pms[3].id });
const stillExpected = (rt, id) => JSON.stringify(rt.api("listExpectedRecurringItems", {})).includes(id);

test("the payer is kept on an income item only, and shown by name", () => {
  const { rt, ana } = setup();
  const inc = item(rt, { payor_id: ana.id });
  const row = listed(rt, inc.id);
  assert.equal(row.payor_id, ana.id);
  assert.equal(row.payor_name, "Ana Prueba");
  const exp = item(rt, { category_id: "cat-rp-exp", payor_id: ana.id });
  assert.equal(listed(rt, exp.id).payor_id, "", "an expense item has no payer");
  rt.api("updateRecurringExpense", { id: inc.id, category_id: "cat-rp-exp" });
  assert.equal(listed(rt, inc.id).payor_id, "", "moved to an expense category, the payer goes");
  assert.equal(listed(rt, item(rt, { payor_id: "nobody" }).id).payor_id, "", "an unknown person is not saved");
});

test("the payer's income pays it even in another category; someone else's never does", () => {
  const { rt, data, ana, leo } = setup();
  const it = item(rt, { payor_id: ana.id });
  assert.ok(stillExpected(rt, it.id));
  income(rt, data, leo.id, "cat-rp-sal");
  assert.ok(stillExpected(rt, it.id), "same category and amount, but from Leo: not its payment");
  income(rt, data, ana.id, "cat-rp-oth");
  assert.ok(!stillExpected(rt, it.id), "from Ana, filed under another category: paid");
});

test("an item with no payer matches as before (category, amount, date)", () => {
  const { rt, data, leo } = setup();
  const it = item(rt, {});
  income(rt, data, leo.id, "cat-rp-oth");
  assert.ok(stillExpected(rt, it.id), "another category does not count");
  income(rt, data, leo.id, "cat-rp-sal");
  assert.ok(!stillExpected(rt, it.id));
});

test("Mark as paid lists the payer's income first", () => {
  const { rt, data, ana, leo } = setup();
  const it = item(rt, { payor_id: ana.id });
  const fromLeo = income(rt, data, leo.id, "cat-rp-sal");
  const fromAna = rt.api("createEntry", { type: "income", date: today(), amount: 900, currency: "PEN", category_id: "cat-rp-oth", description: "Other", paid_by: ana.id, payment_method_id: data.pms[3].id });
  const list = rt.api("listEntriesForRecurringMonth", { id: it.id, month: today().slice(0, 7) });
  const ids = list.map((e) => e.id);
  assert.ok(ids.indexOf(fromAna.id) < ids.indexOf(fromLeo.id));
  assert.ok(list.every((e) => e.from_payor === undefined), "the ranking flag is not sent");
});
