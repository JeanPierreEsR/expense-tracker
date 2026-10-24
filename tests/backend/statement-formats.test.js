// Saved layouts of spreadsheet statements (backend/StatementFormats.gs) and the source app's categories on imported lines.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

test("a layout is remembered on the server, found again by its header words, and counted each time it is used", () => {
  const { rt } = freshApp({ entries: 10 });
  assert.deepEqual(rt.api("getStatementFormat", { signature: "date|wallet|amount" }), { found: false });
  rt.api("saveStatementFormat", { signature: "date|wallet|amount", label: "My app export", mapping: { date: 0, amount: 2, sign: "negative" }, accounts: {} });
  const got = rt.api("getStatementFormat", { signature: "date|wallet|amount" });
  assert.equal(got.found, true);
  assert.equal(got.label, "My app export");
  assert.deepEqual(got.mapping, { date: 0, amount: 2, sign: "negative" });
  assert.equal(got.uses, 1);
  // Saving again updates the same layout; an empty name keeps the old one.
  rt.api("saveStatementFormat", { signature: "date|wallet|amount", label: "", mapping: { date: 0, amount: 2, sign: "positive" }, accounts: {} });
  const again = rt.api("getStatementFormat", { signature: "date|wallet|amount" });
  assert.equal(again.uses, 2);
  assert.equal(again.label, "My app export");
  assert.equal(again.mapping.sign, "positive");
  assert.equal(run(rt, "getAllRows('Statement Formats').length"), 1);
});

test("which account each value of an account column goes to is remembered, and a deleted account is forgotten", () => {
  const { rt, data } = freshApp({ entries: 10 });
  const keep = data.pms[0].id, gone = data.pms[1].id;
  rt.api("saveStatementFormat", { signature: "s", label: "Multi", mapping: {}, accounts: { Wallet: keep, Savings: gone } });
  assert.deepEqual(rt.api("getStatementFormat", { signature: "s" }).accounts, { Wallet: keep, Savings: gone });
  rt.run(`deleteRowsWhere_('Payment Methods', function (r) { return r.id === ${JSON.stringify(gone)}; });`);
  assert.deepEqual(rt.api("getStatementFormat", { signature: "s" }).accounts, { Wallet: keep });
});

test("the person can make the app forget a layout", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.api("saveStatementFormat", { signature: "a", label: "A", mapping: {}, accounts: {} });
  rt.api("saveStatementFormat", { signature: "b", label: "B", mapping: {}, accounts: {} });
  assert.equal(rt.api("deleteStatementFormat", { signature: "a" }).deleted, 1);
  assert.equal(rt.api("getStatementFormat", { signature: "a" }).found, false);
  assert.equal(rt.api("getStatementFormat", { signature: "b" }).found, true);
  assert.equal(rt.api("deleteStatementFormat", { signature: "nothing" }).deleted, 0);
});

test("only a layout's shape is stored: an oversized one is refused", () => {
  const { rt } = freshApp({ entries: 10 });
  assert.throws(() => rt.api("saveStatementFormat", { signature: "x", label: "X", mapping: { junk: "y".repeat(7000) }, accounts: {} }));
  assert.throws(() => rt.api("saveStatementFormat", { signature: "", label: "X", mapping: {}, accounts: {} }));
});

// ---- the source app's category on imported lines ----

function importSetup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-app', nickname: 'App Wallet', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  for (const [id, name, type, hidden] of [["c-food", "Food & Drink", "expense", ""], ["c-tr", "Zoo trips", "expense", ""], ["c-old", "Old stuff", "expense", "yes"], ["c-sal", "Salário", "income", ""]]) {
    rt.run(`appendRowObject('Categories', { id: '${id}', name: '${name}', type: '${type}', icon: '', color: '#ccc', parent_id: '', hidden: '${hidden}' });`);
  }
  const lines = [
    { date: "2019-04-01", description: "Pinkberry", amount: -12.5, currency: "PEN", category: "food & drink" },
    { date: "2019-04-02", description: "Public transport", amount: -3, currency: "PEN", category: "ZOO TRIPS" },
    { date: "2019-04-03", description: "Mystery", amount: -9, currency: "PEN", category: "Gadgets" },
    { date: "2019-04-04", description: "Hidden one", amount: -4, currency: "PEN", category: "Old stuff" },
    { date: "2019-04-05", description: "No category", amount: -7, currency: "PEN" },
    { date: "2019-04-06", description: "Pay day", amount: 2000, currency: "PEN", category: "salario" },
    { date: "2019-04-07", description: "Wrong type", amount: 50, currency: "PEN", category: "Zoo trips" }   // an income line named like an expense category
  ];
  const stmt = { key: "ACCT-pm-app", kind: "csv", holder: "", verified: false, balances: {}, file_name: "app.csv", period: { start: "2019-04-01", end: "2019-04-07" }, lines };
  return { rt, stmt };
}
const made = (rt) => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");

test("a line's category is used when the app has one of that name (any case or accent, right type) when no mapping is given; otherwise it waits for Tidy my history", () => {
  const { rt, stmt } = importSetup();
  const p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  const dry = run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: true, filename: "app.csv", statements: [stmt], actions: p.actions })})`);
  assert.equal(made(rt).length, 0, "a dry run writes nothing");
  assert.equal(dry.categoriesFiled, 3, "Food & Drink, Zoo trips, Salário");
  assert.equal(dry.categoriesMissed, 3, "Gadgets, the hidden category, and the income line named like an expense category");
  assert.deepEqual([...dry.categoryMissedNames].sort(), ["Gadgets", "Old stuff", "Zoo trips"]);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "app.csv", statements: [stmt], actions: p.actions })})`);
  const byDesc = Object.fromEntries(made(rt).map((e) => [e.description, e.category_id]));
  assert.equal(byDesc["Pinkberry"], "c-food");
  assert.equal(byDesc["Public Transport"], "c-tr");
  assert.equal(byDesc["Mystery"], "");
  assert.equal(byDesc["Hidden One"], "");
  assert.equal(byDesc["No Category"], "");
  assert.equal(byDesc["Pay Day"], "c-sal");
  assert.equal(byDesc["Wrong Type"], "");
});

test("entries filed from a source app's categories feed the merchant history the category guess learns from", () => {
  const { rt, stmt } = importSetup();
  const p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "app.csv", statements: [stmt], actions: p.actions })})`);
  const ctx = run(rt, "buildGuessContext_().history");
  assert.ok(ctx["pinkberry"], "the merchant history has Pinkberry");
});
