// Merging an imported file's categories with the person's own (backend/StatementCategories.gs + applyStatementDecisions).
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const byName = (items, name) => items.find((i) => i.name === name);

function suggest(rt, names) {
  return rt.api("suggestCategoryMap", { names }).items;
}

test("a name matches an existing category in either language, ignoring case, accents and '&'", () => {
  const { rt } = freshApp({ entries: 5 });
  const items = suggest(rt, [
    { type: "expense", name: "transport" }, { type: "expense", name: "TRANSPORTE" }, { type: "expense", name: "Educación" },
    { type: "expense", name: "Family and Personal" }, { type: "income", name: "sueldo" }
  ]);
  assert.deepEqual(items.map((i) => [i.action, i.why]), [["match", "name"], ["match", "name"], ["match", "name"], ["match", "name"], ["match", "name"]]);
  assert.equal(items[0].categoryId, items[1].categoryId, "English and Spanish reach the same category");
  assert.equal(items[3].categoryName, "Family & Personal");
});

test("well-known equivalents of the app's own categories are matched through their key; the rest are created", () => {
  const { rt } = freshApp({ entries: 5 });
  const items = suggest(rt, [
    { type: "expense", name: "Food & Drink" }, { type: "expense", name: "Supermarket" }, { type: "expense", name: "Health" },
    { type: "expense", name: "Mobile phone" }, { type: "expense", name: "AELU" }, { type: "expense", name: "Pet care" },
    { type: "income", name: "Interest" }, { type: "income", name: "Pocket money" }
  ]);
  assert.equal(byName(items, "Food & Drink").categoryName, "Restaurants");
  assert.equal(byName(items, "Food & Drink").why, "equivalent");
  assert.equal(byName(items, "Supermarket").categoryName, "Groceries");
  assert.equal(byName(items, "Health").categoryName, "Healthcare");
  assert.equal(byName(items, "Mobile phone").why, "name");
  assert.equal(byName(items, "AELU").action, "create");
  assert.equal(byName(items, "Pet care").action, "create");
  assert.equal(byName(items, "Interest").categoryName, "Savings return");
  assert.equal(byName(items, "Pocket money").action, "create");
  assert.equal(suggest(rt, [{ type: "income", name: "Pet care" }])[0].action, "create", "an expense category is never used for income");
});

test("an equivalent still finds a built-in the person has renamed, because it goes through the key", () => {
  const { rt } = freshApp({ entries: 5 });
  const groceries = run(rt, "getAllRows('Categories').filter(function (c) { return c.key === 'groceries'; })[0]");
  rt.run(`saveCategory({ id: ${JSON.stringify(groceries.id)}, name: 'Mercadito', type: 'expense' });`);
  const item = suggest(rt, [{ type: "expense", name: "Supermarket" }])[0];
  assert.equal(item.categoryId, groceries.id);
  assert.equal(item.categoryName, "Mercadito");
});

test("'Savings' and 'Loan' are not recreated: the app retired them, so they wait for the person to decide", () => {
  const { rt } = freshApp({ entries: 5 });
  const items = suggest(rt, [{ type: "expense", name: "Savings" }, { type: "expense", name: "Loan" }, { type: "income", name: "Loan" }]);
  assert.deepEqual(items.map((i) => [i.action, i.why]), [["left", "retired"], ["left", "retired"], ["left", "retired"]]);
});

test("a name is listed once per type, and blank names are ignored", () => {
  const { rt } = freshApp({ entries: 5 });
  const items = suggest(rt, [{ type: "expense", name: "Gifts" }, { type: "expense", name: " gifts " }, { type: "income", name: "Gifts" }, { type: "expense", name: "  " }]);
  assert.deepEqual(items.map((i) => i.key), ["expense:gifts", "income:gifts"]);
});

// ---- creating them when the file is saved ----

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-app', nickname: 'App Wallet', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  const lines = [
    { date: "2019-04-01", description: "Pet food", amount: -12.5, currency: "PEN", category: "Pet care" },
    { date: "2019-04-02", description: "Vet", amount: -80, currency: "PEN", category: "pet CARE" },
    { date: "2019-04-03", description: "Lunch", amount: -9, currency: "PEN", category: "Food & Drink" },
    { date: "2019-04-04", description: "Move", amount: -50, currency: "PEN", category: "Savings" },
    { date: "2019-04-05", description: "Gift in", amount: 40, currency: "PEN", category: "Pocket money" },
    { date: "2019-04-06", description: "Plain", amount: -7, currency: "PEN" }
  ];
  const stmt = { key: "ACCT-pm-app", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "app.csv", period: { start: "2019-04-01", end: "2019-04-06" }, lines };
  const names = [{ type: "expense", name: "Pet care" }, { type: "expense", name: "Food & Drink" }, { type: "expense", name: "Savings" }, { type: "income", name: "Pocket money" }];
  const map = () => Object.fromEntries(suggest(rt, names).map((i) => [i.key, i.action === "match" ? i.categoryId : i.action === "create" ? "create" : ""]));
  const plan = () => run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  const apply = (dryRun, categoryMap) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "app.csv", statements: [stmt], actions: plan().actions, categoryMap })})`);
  const cats = () => run(rt, "getAllRows('Categories')");
  plan();   // the analysis itself adds the 'Refunds' category on a fresh account; count categories after that
  const made = () => run(rt, "getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; })");
  return { rt, apply, map, cats, made };
}

test("the file's unmatched categories are created on save with the file's names; a dry run creates nothing", () => {
  const { rt, apply, map, cats, made } = setup();
  const before = cats().length;
  const dry = apply(true, map());
  assert.equal(cats().length, before, "a dry run writes nothing");
  assert.deepEqual([...dry.categoriesCreatedNames].sort(), ["Pet care", "Pocket money"], "it says what it would create");
  const res = apply(false, map());
  assert.deepEqual([...res.categoriesCreatedNames].sort(), ["Pet care", "Pocket money"]);
  assert.equal(cats().length, before + 2);
  const pet = cats().find((c) => c.name === "Pet care"), gifts = cats().find((c) => c.name === "Pocket money" && c.type === "income");
  assert.equal(pet.type, "expense");
  assert.ok(pet && gifts);
  const rows = Object.fromEntries(made().map((e) => [e.description, e.category_id]));
  assert.equal(rows["Pet Food"], pet.id);
  assert.equal(rows["Vet"], pet.id, "the same name in another case is the same category");
  assert.equal(rows["Gift In"], gifts.id);
  assert.equal(rows["Lunch"], cats().find((c) => c.key === "restaurants").id, "'Food & Drink' went to Restaurants");
  assert.equal(rows["Move"], "", "'Savings' was left");
  assert.equal(rows["Plain"], "");
  assert.equal(res.categoriesMissed, 1);
});

test("a second file with the same names reuses what the first created instead of making copies", () => {
  const { rt, apply, map, cats } = setup();
  apply(false, map());
  const after = cats().length;
  rt.run(`deleteRowsWhere_('Entries', function (e) { return String(e.external_id).indexOf('stmt-') === 0; }); deleteRowsWhere_('Statement Lines', function () { return true; });`);
  apply(false, { "expense:pet care": "create", "income:pocket money": "create" });
  assert.equal(cats().length, after, "'create' finds the existing category of that name");
});

test("the person's own choices win: another category, or none; a category that no longer exists is created instead", () => {
  const { rt, apply, cats, made } = setup();
  const groceries = cats().find((c) => c.key === "groceries").id;
  apply(false, { "expense:pet care": groceries, "expense:food and drink": "", "income:pocket money": "gone-id" });
  const rows = Object.fromEntries(made().map((e) => [e.description, e.category_id]));
  assert.equal(rows["Pet Food"], groceries);
  assert.equal(rows["Lunch"], "", "left as chosen");
  const gifts = cats().find((c) => c.name === "Pocket money" && c.type === "income");
  assert.ok(gifts && rows["Gift In"] === gifts.id, "a stale id means nothing: the name is created");
});

test("a hidden category of the same name is used, not duplicated", () => {
  const { rt, apply, cats, made } = setup();
  rt.run(`appendRowObject('Categories', { id: 'c-hid', name: 'Pet care', type: 'expense', icon: '', color: '#ccc', parent_id: '', hidden: 'yes' });`);
  const before = cats().length;
  apply(false, { "expense:pet care": "create" });
  assert.equal(made().find((e) => e.description === "Pet Food").category_id, "c-hid");
  assert.equal(cats().filter((c) => c.name === "Pet care").length, 1);
  assert.equal(cats().length, before);
});

test("a long name is cut to the 40 characters a category may have", () => {
  const { rt, apply, cats } = setup();
  const long = "A very long category name that goes well past forty characters";
  const stmt = { key: "ACCT-pm-app", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "l.csv", period: { start: "2019-04-01", end: "2019-04-01" }, lines: [{ date: "2019-04-01", description: "x", amount: -1, currency: "PEN", category: long }] };
  const map = { ["expense:" + long.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()]: "create" };
  const p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "l", statements: [stmt], actions: p.actions, categoryMap: map })})`);
  assert.ok(cats().some((c) => c.name === long.slice(0, 40)));
});

test("Undo removes the categories the upload created, but keeps one the person has used since", () => {
  const { rt, apply, map, cats, made } = setup();
  const res = apply(false, map());
  const pet = cats().find((c) => c.name === "Pet care"), gifts = cats().find((c) => c.name === "Pocket money" && c.type === "income");
  // The person files an entry of their own under 'Gifts' afterwards.
  rt.run(`appendRowObject('Entries', { id: 'mine', type: 'income', date: '2019-05-01', amount: 5, currency: 'PEN', category_id: ${JSON.stringify(gifts.id)}, description: 'mine', paid_by: '', status: 'confirmed', source: 'manual', external_id: '' });`);
  const undo = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(made().length, 0);
  assert.ok(!cats().some((c) => c.id === pet.id), "'Pet care' was only used by this upload: gone");
  assert.ok(cats().some((c) => c.id === gifts.id), "'Pocket money' now holds the person's own entry: kept");
  assert.equal(undo.categoriesRemoved, 1);
  assert.equal(undo.categoriesKept, 1);
});

test("without a mapping the old behaviour holds: only same-name categories are used, nothing is created", () => {
  const { rt, apply, cats } = setup();
  const before = cats().length;
  const res = apply(false, undefined);
  assert.equal(cats().length, before);
  assert.equal(res.categoriesCreatedNames.length, 0);
});

// ---- remembered with the layout ----

test("the mapping is remembered with the layout; ids that no longer exist are dropped, 'create' and 'leave' stay", () => {
  const { rt } = freshApp({ entries: 5 });
  const cat = run(rt, "getAllRows('Categories').filter(function (c) { return c.key === 'groceries'; })[0]");
  const map = { "expense:supermarket": cat.id, "expense:pet care": "create", "expense:savings": "", "expense:old": "deleted-id" };
  rt.api("saveStatementFormat", { signature: "layout", label: "App", mapping: {}, accounts: {}, categories: map });
  assert.deepEqual(rt.api("getStatementFormat", { signature: "layout" }).categories, { "expense:supermarket": cat.id, "expense:pet care": "create", "expense:savings": "" });
});

test("a layout saved before the category mapping existed still works (its tab gets the new column)", () => {
  const { rt } = freshApp({ entries: 5 });
  rt.run(`(function () { var ss = SpreadsheetApp.getActiveSpreadsheet(); var sh = ss.insertSheet('Statement Formats'); sh.getRange(1, 1, 1, 8).setValues([['id', 'signature', 'label', 'mapping_json', 'accounts_json', 'uses', 'created_at', 'updated_at']]); sh.getRange(2, 1, 1, 8).setValues([['old', 'sig', 'Old', '{}', '{}', '1', 'x', 'x']]); })();`);
  const got = rt.api("getStatementFormat", { signature: "sig" });
  assert.equal(got.found, true);
  assert.deepEqual(got.categories, {});
  rt.api("saveStatementFormat", { signature: "sig", label: "", mapping: {}, accounts: {}, categories: { "expense:x": "create" } });
  assert.deepEqual(rt.api("getStatementFormat", { signature: "sig" }).categories, { "expense:x": "create" });
});
