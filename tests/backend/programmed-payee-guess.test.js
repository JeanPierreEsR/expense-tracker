// Proposed Programmed-item guess (2026-11-20, mode 'payee'): an item matches only a payee it was paid to before, or, with no
// past payee, one sharing a word with its name. The live guess is unchanged until the backtest says so.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 0 });
  rt.run(`appendRowObject('Categories', { id: 'cat-sub', name: 'Subs', type: 'expense', icon: '', color: '#ccc', parent_id: '' });
    appendRowObject('Categories', { id: 'cat-food', name: 'Food', type: 'expense', icon: '', color: '#ccc', parent_id: '' });
    ensureEntriesMerchantColumn_();
    appendRowObject('Recurring Expenses', { id: 'r-tv', description: 'Streaming TV', category_id: 'cat-sub', amount: 24, currency: 'PEN', frequency: 'monthly', day: 10, active: 'true', start_date: '2026-01-01' });`);
  const add = (id, date, merchant, cat, extra) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date, amount: 24, currency: "PEN", category_id: cat, description: merchant, merchant, paid_by: "me", status: "confirmed", source: "email" }, extra || {}))})`);
  const guess = (merchant, date, mode) => rt.run(`(function () { var g = guessFromProgrammed_({ amount: 23.75, currency: 'PEN', merchant: ${JSON.stringify(merchant)} }, '${date}', buildGuessContext_(), ${mode ? "'" + mode + "'" : "undefined"}); return g ? g.categoryId : ''; })()`);
  return { rt, add, guess };
}

test("the live rule matches on amount and date alone; 'payee' needs a shared word while the item has no past payee", () => {
  const { guess } = setup();
  assert.equal(guess("Plin a Ana Lo", "2026-03-10"), "cat-sub", "old: any payee");
  assert.equal(guess("Plin a Ana Lo", "2026-03-10", "payee"), "", "new: unrelated payee, no guess");
  assert.equal(guess("STREAMING.COM", "2026-03-10", "payee"), "cat-sub", "new: the name matches");
});

test("once paid, the item matches its past payees only — a friend paid by Plin for a shared subscription included", () => {
  const { add, guess } = setup();
  add("e1", "2026-02-10", "Plin a Ana Lo", "cat-sub");
  assert.equal(guess("Plin a Ana Lo", "2026-03-10", "payee"), "cat-sub");
  assert.equal(guess("Plin a Luis Ru", "2026-03-10", "payee"), "");
  assert.equal(guess("STREAMING.COM", "2026-03-10", "payee"), "", "a known payee list wins over the name");
  assert.equal(guess("Plin a Ana Lo", "2026-02-09", "payee"), "", "a payment after the date is not known yet (and the name shares no word)");
});

test("backtest: counts right / wrong / none for both rules and lists what changed", () => {
  const { rt, add } = setup();
  add("a1", "2026-01-10", "STREAMING.COM", "cat-sub");
  add("a2", "2026-02-10", "STREAMING.COM", "cat-sub");
  add("b1", "2026-03-11", "Plin a Ana Lo", "cat-food");
  const r = rt.run("programmedGuessBacktest_({ days: 1095 })");
  assert.equal(r.expenses, 3);
  assert.deepEqual({ ...r.reached.old }, { right: 2, wrong: 1, none: 0 });
  assert.deepEqual({ ...r.reached["new"] }, { right: 2, wrong: 0, none: 1 });
  assert.equal(r.changed.length, 1);
  assert.equal(r.changed[0].old, "wrong");
  assert.equal(r.changed[0]["new"], "none");
});
