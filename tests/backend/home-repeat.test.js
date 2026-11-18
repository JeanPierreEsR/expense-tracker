// Home's "You recorded X again this month: make it repeat?" (owner's plan, 2026-11-17, after the journeys run). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const monthsAgo = (k) => { const [y, m] = today().split("-").map(Number); const d = new Date(y, m - 1 - k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-pay', name: 'Rep pay', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Recurring Expenses', function () { return true; });`);
  return rt;
}
let n = 0;
const entry = (rt, o) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "rp" + ++n, type: "income", date: today(), amount: 3000, currency: "PEN", category_id: "cat-pay", description: "Salary Prueba", paid_by: "me", status: "confirmed", source: "manual", ...o })});`);

test("a salary typed last month and this month, not planned, is suggested", () => {
  const rt = setup();
  entry(rt, { date: monthsAgo(1) + "-28", amount: 2950 });
  entry(rt, { amount: 3000 });
  const r = rt.api("getHomeGlance", {}).repeat;
  assert.equal(r.type, "income");
  assert.equal(r.category_id, "cat-pay");
  assert.equal(r.amount, 3000);
  assert.equal(r.description, "Salary Prueba");
});

test("no suggestion when the amounts differ by more than 20%, when one month is missing, or when it is already planned", () => {
  let rt = setup();
  entry(rt, { date: monthsAgo(1) + "-28", amount: 1000 });
  entry(rt, { amount: 3000 });
  assert.equal(rt.api("getHomeGlance", {}).repeat, null);
  rt = setup();
  entry(rt, { amount: 3000 });
  assert.equal(rt.api("getHomeGlance", {}).repeat, null);
  rt = setup();
  entry(rt, { date: monthsAgo(1) + "-28", amount: 3000 });
  entry(rt, { amount: 3000 });
  rt.run(`appendRowObject('Recurring Expenses', { id: 'rec-1', description: 'Salary', category_id: 'cat-pay', amount: 3000, currency: 'PEN', frequency: 'monthly', active: 'true' });`);
  assert.equal(rt.api("getHomeGlance", {}).repeat, null);
});
