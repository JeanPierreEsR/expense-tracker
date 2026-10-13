// Spanish/English on the SERVER (step 5a of the language work): the language
// of each request, the Settings language row, translated category names (with
// the English name and a hidden key kept in the sheet), the one-off categories
// cleanup, and Telegram finding a category by either name. See specs/language.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const meta = (rt, lang) => post(rt, "getMeta", {}, lang).data;
const byName = (list, name, type) => list.find((c) => c.name === name && (!type || c.type === type));
const cats = (rt) => rt.rows("Categories");

test("the starter list: no Savings/Loan/AELU/Annual budget, Sports added, every row has its key", () => {
  const { rt } = freshApp({ entries: 50 });
  const list = cats(rt);
  ["Savings", "Loan", "AELU", "Annual budget"].forEach((n) => assert.ok(!byName(list, n), n + " must not be in the starter list"));
  const sports = byName(list, "Sports", "expense");
  assert.ok(sports && sports.key === "sports");
  assert.ok(byName(list, "Food & Drink").key === "food_drink", "keys come from the English name");
  assert.equal(byName(list, "Other", "income").key, "other");
});

test("getMeta speaks the request's language; the stored name never changes", () => {
  const { rt } = freshApp({ entries: 50 });
  meta(rt, "en");   // the first call may add the investment categories; compare after it
  const storedBefore = cats(rt).map((c) => c.name).sort();
  const es = meta(rt, "es").categories, en = meta(rt, "en").categories;
  assert.equal(es.find((c) => c.key === "groceries").name, "Supermercado");
  assert.equal(en.find((c) => c.key === "groceries").name, "Groceries");
  assert.equal(es.find((c) => c.key === "sports").name, "Deporte");
  assert.equal(es.find((c) => c.key === "other" && c.type === "expense").name, "Otros");
  assert.deepEqual(cats(rt).map((c) => c.name).sort(), storedBefore, "the sheet still holds the English names");
  assert.equal(meta(rt).categories.find((c) => c.key === "groceries").name, "Groceries", "no language sent and no setting = English");
});

test("a category the owner created or renamed shows as typed, in both languages", () => {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'mine-1', name: 'Mi cafetería', type: 'expense', icon: '☕', color: '#ccc', parent_id: '' });`);
  const groceries = byName(cats(rt), "Groceries", "expense");
  rt.run(`updateRowFields_('Categories', ${JSON.stringify(groceries.id)}, { name: 'Mercado del barrio' });`);
  const es = meta(rt, "es").categories;
  assert.equal(byName(es, "Mi cafetería").name, "Mi cafetería");
  assert.equal(es.find((c) => c.id === groceries.id).name, "Mercado del barrio", "renamed built-in is not translated");
});

test("the language of one request does not leak into the next", () => {
  const { rt } = freshApp({ entries: 50 });
  assert.equal(rt.run("(function () { REQUEST_LANG_ = null; return currentLang_(); })()"), "en");
  post(rt, "getMeta", {}, "es");
  assert.equal(rt.run("REQUEST_LANG_"), "es");
  post(rt, "getMeta", {});
  assert.equal(rt.run("REQUEST_LANG_"), null);
  assert.equal(meta(rt).categories.find((c) => c.key === "car").name, "Car");
});

test("setLanguage saves the language in Settings; work with no request (bot, scans) then uses it", () => {
  const { rt } = freshApp({ entries: 50 });
  assert.equal(post(rt, "setLanguage", { lang: "es" }).data.language, "es");
  assert.equal(rt.rows("Settings").find((r) => r.key === "language").value, "es");
  rt.run("REQUEST_LANG_ = null;");
  assert.equal(rt.run("currentLang_()"), "es");
  assert.equal(rt.run("categoryLabel_(getAllRows('Categories').find(function (c) { return c.key === 'car'; }))"), "Auto");
  assert.equal(post(rt, "setLanguage", { lang: "en" }).data.language, "en");
  assert.equal(rt.rows("Settings").filter((r) => r.key === "language").length, 1, "updated in place, not duplicated");
  assert.equal(post(rt, "setLanguage", { lang: "fr" }).ok, false, "unknown language refused");
});

test("search finds an entry by the English or the Spanish category name", () => {
  const { rt } = freshApp({ entries: 50 });
  const groceries = byName(cats(rt), "Groceries", "expense");
  rt.run(`createEntry({ type: 'expense', date: '2026-10-01', amount: 12.34, currency: 'PEN', category_id: ${JSON.stringify(groceries.id)}, description: 'zzz marker', paid_by: 'me', payment_method_id: '' });`);
  const found = (q, lang) => post(rt, "listEntries", { search: q, limit: 20 }, lang).data.filter((e) => e.description === "zzz marker").length;
  assert.equal(found("groceries", "es"), 1);
  assert.equal(found("supermercado", "en"), 1, "works whatever language the request is in");
});

test("Telegram edit: a category can be named in English or Spanish", () => {
  const { rt } = freshApp({ entries: 50 });
  const id = (name) => byName(cats(rt), name, "expense").id;
  assert.equal(rt.run("fuzzyFindCategory_('groceries', 'expense').id"), id("Groceries"));
  assert.equal(rt.run("fuzzyFindCategory_('supermercado', 'expense').id"), id("Groceries"));
  assert.equal(rt.run("fuzzyFindCategory_('comida', 'expense').id"), id("Food & Drink"));
  assert.equal(rt.run("fuzzyFindCategory_('deporte', 'expense').id"), id("Sports"));
});

// ---- the one-off cleanup of the owner's sheet --------------------------------
// The owner's sheet predates keys and still holds Savings/Loan, AELU, Annual budget.
function ownersOldSheet(rt) {
  rt.run(`
    var keyCol = getHeaders(getSheet('Categories')).indexOf('key') + 1;
    var sheet = getSheet('Categories');
    var n = sheet.getLastRow() - 1;
    if (n > 0) sheet.getRange(2, keyCol, n, 1).setValues(Array.from({ length: n }, function () { return ['']; }));   // no keys yet
    deleteRowsWhere_('Categories', function (c) { return c.name === 'Sports'; });   // the owner's sheet has no Sports yet
    ['Savings:expense', 'Loan:expense', 'Loan:income', 'AELU:expense', 'Annual budget:expense'].forEach(function (s, i) {
      var p = s.split(':');
      appendRowObject('Categories', { id: 'old-' + i, name: p[0], type: p[1], icon: '📦', color: '#ccc', parent_id: '' });
    });`);
  const other = (type) => byName(cats(rt), "Other", type).id;
  const groc = byName(cats(rt), "Groceries", "expense").id;
  const add = (cat, n) => rt.run(`for (var i = 0; i < ${n}; i++) appendRowObject('Entries', { id: Utilities.getUuid(), type: ${JSON.stringify(cat.type)}, date: '2026-09-0' + (i + 1), amount: 10 + i, currency: 'PEN', category_id: ${JSON.stringify(cat.id)}, description: 'old ' + i, paid_by: 'me', status: 'confirmed', source: 'manual' });`);
  add({ type: "expense", id: "old-0" }, 3);   // Savings
  add({ type: "expense", id: "old-1" }, 2);   // Loan (expense)
  add({ type: "income", id: "old-2" }, 4);    // Loan (income)
  rt.run(`appendRowObject('Budgets', { id: 'b-old', category_id: 'old-0,${groc}', amount: 100, currency: 'PEN', period_type: 'monthly', thresholds: '75,100', name: '' });
          appendRowObject('Budgets', { id: 'b-all', category_id: 'ALL', amount: 900, currency: 'PEN', period_type: 'monthly', thresholds: '75,100', name: '' });
          appendRowObject('Recurring Expenses', { id: 'r-old', category_id: 'old-1', description: 'old loan payment', amount: 50, currency: 'PEN', frequency: 'monthly', day: 5, active: true });
          appendRowObject('Projection Overrides', { id: 'o-old', category_id: 'old-0', period_key: '2026-10', amount: 70 });`);
  return { otherExpense: other("expense"), otherIncome: other("income"), groc };
}
const cell = (rt, sheet, id, col) => rt.rows(sheet).find((r) => r.id === id)[col];

test("cleanup preview counts what would move and changes nothing", () => {
  const { rt } = freshApp({ entries: 50 });
  ownersOldSheet(rt);
  const before = JSON.stringify(rt.rows("Categories")) + JSON.stringify(rt.rows("Entries").length);
  const r = rt.run("adminMigrateCategories({ dryRun: true })");
  assert.equal(r.dryRun, true);
  const sav = r.retired.find((x) => x.type === "expense" && x.name === "Savings");
  assert.deepEqual([sav.entries, sav.budgets, sav.overrides, sav.movedTo], [3, 1, 1, "Other"]);
  assert.equal(r.retired.find((x) => x.type === "expense" && x.name === "Loan").programmed, 1);
  assert.equal(r.retired.find((x) => x.type === "income" && x.name === "Loan").entries, 4);
  assert.ok(r.notBuiltIn.some((s) => s.includes("AELU")), "AELU is the owner's own: left as typed");
  assert.equal(JSON.stringify(rt.rows("Categories")) + JSON.stringify(rt.rows("Entries").length), before, "a preview writes nothing");
});

test("cleanup apply: moves usage to Other, deletes Savings/Loan, tags keys, adds Sports; running it again does nothing", () => {
  const { rt } = freshApp({ entries: 50 });
  const k = ownersOldSheet(rt);
  const r = rt.run("adminMigrateCategories({ dryRun: false })");
  const list = cats(rt);
  assert.ok(!byName(list, "Savings") && !byName(list, "Loan"), "retired categories are gone (expense and income)");
  assert.ok(byName(list, "AELU") && byName(list, "Annual budget"), "the owner's personal categories stay");
  assert.equal(byName(list, "AELU").key, "", "AELU has no key: shown as typed");
  assert.equal(byName(list, "Annual budget").key, "annual_budget");
  assert.equal(byName(list, "Groceries", "expense").key, "groceries");
  assert.equal(byName(list, "Sports", "expense").key, "sports");
  // usage moved to Other of the same type
  const entries = rt.rows("Entries");
  assert.equal(entries.filter((e) => e.description.startsWith("old ") && e.type === "expense").every((e) => e.category_id === k.otherExpense), true);
  assert.equal(entries.filter((e) => e.description.startsWith("old ") && e.type === "income").every((e) => e.category_id === k.otherIncome), true);
  assert.equal(cell(rt, "Budgets", "b-old", "category_id"), `${k.otherExpense},${k.groc}`, "a budget list keeps its other categories");
  assert.equal(cell(rt, "Budgets", "b-all", "category_id"), "ALL");
  assert.equal(cell(rt, "Recurring Expenses", "r-old", "category_id"), k.otherExpense);
  assert.equal(cell(rt, "Projection Overrides", "o-old", "category_id"), k.otherExpense);
  assert.ok(r.retired.length === 3 && r.added.includes("expense: Sports"));
  // idempotent
  const again = rt.run("adminMigrateCategories({ dryRun: false })");
  assert.deepEqual([again.retired.length, again.tagged.length, again.added.length], [0, 0, 0]);
  assert.equal(cats(rt).length, list.length);
  // and now the Spanish names work for the owner's sheet
  assert.equal(meta(rt, "es").categories.find((c) => c.id === byName(list, "Annual budget").id).name, "Presupuesto anual");
});

test("cleanup leaves a retired category alone (and says so) when there is no 'Other' to move into", () => {
  const { rt } = freshApp({ entries: 50 });
  ownersOldSheet(rt);
  rt.run("deleteRowsWhere_('Categories', function (c) { return c.type === 'income' && c.name === 'Other'; });");
  const r = rt.run("adminMigrateCategories({ dryRun: false })");
  assert.ok(byName(cats(rt), "Loan", "income"), "income Loan kept because there was nowhere to move its entries");
  assert.ok(r.notes.some((n) => n.includes("income")));
  assert.ok(!byName(cats(rt), "Loan", "expense"), "the expense ones were still retired");
});
