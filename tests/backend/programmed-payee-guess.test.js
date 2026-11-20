// Proposed Programmed-item guess (2026-11-20, mode 'payee'): an item matches only a payee it was paid to before, or, with no
// past payee, one sharing a word with its name. Live since 2026-11-20 (the backtest on the owner's entries).
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
  assert.equal(guess("STREAMING.COM", "2026-03-10", "payee"), "cat-sub", "the item's own name always fits");
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

test("payees alike: a shared real word, or the same name without spaces; wallet and place words do not count", () => {
  const { rt } = setup();
  const alike = (a, b) => rt.run(`payeesAlike_(normalizeMerchant_(${JSON.stringify(a)}), normalizeMerchant_(${JSON.stringify(b)}))`);
  assert.equal(alike("RIMAC USD2 RECURRENCIA", "RIMAC REC VH USD"), true);
  assert.equal(alike("SMARTFIT", "Smart Fit"), true);
  assert.equal(alike("Plin a Ana Lo", "Plin a Luis Ru"), false);
  assert.equal(alike("DLC RAPPI PERU", "DLC TAMBO PERU"), false);
  assert.equal(alike("Plin a Ana Lo", "Streaming TV"), false);
});

test("the live guess for a new e-mail / Apple Pay / typed expense uses the payee rule", () => {
  const { rt } = setup();
  const live = (merchant) => rt.run(`guessCategoryForEmail_({ type: 'expense', amount: 23.75, currency: 'PEN', merchant: ${JSON.stringify(merchant)} }, '2026-03-10', buildGuessContext_()).categoryId`);
  assert.equal(live("Plin a Ana Lo"), "", "an unrelated payee near the item's amount and date is no longer guessed");
  assert.equal(live("STREAMING.COM"), "cat-sub");
});

test("paid check: a payment whose payee fits neither the item's name nor its usual payee is a suspect", () => {
  const { rt, add } = setup();
  add("p1", "2026-01-10", "STREAMING.COM", "cat-sub");
  add("p2", "2026-02-10", "Plin a Ana Lo", "cat-sub");
  add("p3", "2026-03-10", "PAGO ACME TV", "cat-sub");
  add("p4", "2026-04-10", "PAGO ACME", "cat-sub");
  const r = rt.run("programmedPaidCheck_({ days: 1095 })");
  assert.equal(r.payments, 4);
  assert.equal(r.alike, 3, "the item's name (p1), and ACME seen in two months (p3, p4)");
  assert.equal(r.suspect, 1);
  assert.equal(r.suspects[0].payee, "plin a ana lo");
  assert.equal(r.wouldDrop.length, 0, "no regular payee yet when the Plin was counted");
  add("p5", "2026-05-10", "Plin a Luis Ru", "cat-sub");
  const r2 = rt.run("programmedPaidCheck_({ days: 1095 })");
  assert.deepEqual(r2.wouldDrop.map((d) => d.payee), ["plin a luis ru"], "ACME is regular by then");
});
