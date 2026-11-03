// More → Categories → Edit (owner's request 2026-11-03): several categories at once. Everything in use moves into ONE chosen category per type, or the
// ones in use are hidden instead; unused ones are simply deleted. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const mk = (rt, name, type = "expense") => { const r = post(rt, "saveCategory", { type, name, icon: "🐶" }); assert.ok(r.data && r.data.id, JSON.stringify(r)); return r.data.id; };
const entry = (rt, id, cat) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: "2026-01-05", amount: 10, currency: "PEN", category_id: cat, description: id, paid_by: "me", status: "confirmed", source: "manual" })});`);
const catOf = (rt, id) => rt.rows("Entries").find((e) => e.id === id).category_id;

function setup() {
  const { rt } = freshApp({ entries: 10 });
  const ids = { a: mk(rt, "Demo A"), b: mk(rt, "Demo B"), c: mk(rt, "Demo C unused"), target: mk(rt, "Demo Target"), income: mk(rt, "Demo Income", "income"), incomeTarget: mk(rt, "Demo Income Target", "income") };
  entry(rt, "cb-1", ids.a); entry(rt, "cb-2", ids.a); entry(rt, "cb-3", ids.b); entry(rt, "cb-4", ids.target);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "cb-5", type: "income", date: "2026-01-06", amount: 90, currency: "PEN", category_id: ids.income, description: "pay", paid_by: "me", status: "confirmed", source: "manual" })});`);
  const rec = post(rt, "addRecurringExpense", { category_id: ids.a, description: "Demo gym", amount: 80, currency: "PEN", frequency: "monthly", day: 5 }).data;
  const budgetA = post(rt, "addBudget", { category_id: ids.a, amount: 100, currency: "PEN", period_type: "monthly" }).data;
  const budgetAB = post(rt, "addBudget", { category_id: `${ids.a},${ids.b}`, amount: 200, currency: "PEN", period_type: "yearly" }).data;
  post(rt, "addCategoryKeyword", { keyword: "demokw", category_name: "Demo A" });
  rt.run(`appendRowObject('Projection Overrides', ${JSON.stringify({ id: "po-1", category_id: ids.a, period_key: "2026-10", amount: 70 })});`);
  const other = rt.rows("Categories").find((c) => c.key === "other" && c.type === "expense");
  return { rt, ids, rec, budgetA, budgetAB, other };
}

test("the backend says it can delete categories in bulk", () => {
  assert.equal(post(freshApp({ entries: 5 }).rt, "getMeta").data.capabilities.categoriesBulkDelete, true);
});

test("previewCategoryDelete says what each category is used by, and flags the protected and missing ones", () => {
  const { rt, ids, other } = setup();
  const items = post(rt, "previewCategoryDelete", { ids: [ids.a, ids.b, ids.c, other.id, "gone-1"] }).data.items;
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(by[ids.a].entries, 2);
  assert.ok(by[ids.a].used >= 5, "entries + programmed item + two budgets + override + ...: " + by[ids.a].used);
  assert.equal(by[ids.b].entries, 1);
  assert.equal(by[ids.c].used, 0);
  assert.equal(by[other.id].protected, true);
  assert.equal(by["gone-1"].missing, true);
});

test("everything in use moves into the ONE chosen category: entries, programmed items, budgets (combined ones deduplicated); keywords and overrides go; unused ones are deleted", () => {
  const { rt, ids, rec, budgetA, budgetAB } = setup();
  const entriesBefore = rt.rows("Entries").length;
  const res = post(rt, "deleteCategories", { ids: [ids.a, ids.b, ids.c], reassign: { expense: ids.target } });
  assert.equal(res.ok, true, JSON.stringify(res));
  const d = res.data;
  assert.deepEqual(d.deleted.map((x) => x.name).sort(), ["Demo A", "Demo B", "Demo C unused"]);
  assert.equal(d.movedEntries, 3);
  assert.equal(d.deleted.find((x) => x.id === ids.a).to, "Demo Target");
  assert.equal(d.deleted.find((x) => x.id === ids.c).moved, 0);
  assert.equal(rt.rows("Entries").length, entriesBefore, "no entry is deleted");
  ["cb-1", "cb-2", "cb-3", "cb-4"].forEach((id) => assert.equal(catOf(rt, id), ids.target, id));
  assert.equal(rt.rows("Recurring Expenses").find((r) => r.id === rec.id).category_id, ids.target);
  assert.equal(rt.rows("Budgets").find((b) => b.id === budgetA.id).category_id, ids.target);
  assert.equal(rt.rows("Budgets").find((b) => b.id === budgetAB.id).category_id, ids.target, "A,B became ONE category, not 'target,target'");
  assert.ok(!rt.rows("Categories").some((c) => [ids.a, ids.b, ids.c].includes(c.id)));
  assert.ok(!rt.rows("Category Keywords").some((k) => k.keyword === "demokw"), "its learned keyword goes with it");
  assert.ok(!rt.rows("Projection Overrides").some((o) => o.id === "po-1"), "a number typed for a deleted category has nowhere to move to");
});

test("each type needs its own target; a wrong-type target, one that is itself being deleted, or none leaves the category in use untouched", () => {
  const { rt, ids } = setup();
  const res = post(rt, "deleteCategories", { ids: [ids.a, ids.b, ids.income, ids.c], reassign: { expense: ids.a, income: ids.target } }).data;
  const reasons = Object.fromEntries(res.kept.map((k) => [k.id, k.reason]));
  assert.equal(reasons[ids.a], "noTarget", "the target is itself in the batch");
  assert.equal(reasons[ids.b], "noTarget");
  assert.equal(reasons[ids.income], "noTarget", "an expense category can't receive income entries");
  assert.deepEqual(res.deleted.map((x) => x.id), [ids.c], "only the unused one is deleted");
  assert.equal(catOf(rt, "cb-1"), ids.a, "nothing moved");
  const both = post(rt, "deleteCategories", { ids: [ids.b, ids.income], reassign: { expense: ids.target, income: ids.incomeTarget } }).data;
  assert.equal(both.deleted.length, 2);
  assert.equal(catOf(rt, "cb-5"), ids.incomeTarget);
  assert.equal(catOf(rt, "cb-3"), ids.target);
});

test("hideUsed hides the ones in use (nothing moves), deletes the unused, and skips what is already hidden", () => {
  const { rt, ids } = setup();
  post(rt, "setCategoryHidden", { id: ids.b, hidden: true });
  const res = post(rt, "deleteCategories", { ids: [ids.a, ids.b, ids.c], hideUsed: true }).data;
  assert.deepEqual(res.hidden.map((x) => x.id), [ids.a]);
  assert.deepEqual(res.kept.map((k) => [k.id, k.reason]), [[ids.b, "hiddenAlready"]]);
  assert.deepEqual(res.deleted.map((x) => x.id), [ids.c]);
  assert.equal(rt.rows("Categories").find((c) => c.id === ids.a).hidden, "yes");
  assert.equal(catOf(rt, "cb-1"), ids.a, "the entries keep their category");
  assert.equal(res.movedEntries, 0);
});

test("the built-in Other and unknown ids are never touched; an empty list does nothing", () => {
  const { rt, other } = setup();
  const res = post(rt, "deleteCategories", { ids: [other.id, "gone-1"], reassign: {} }).data;
  assert.deepEqual(Object.fromEntries(res.kept.map((k) => [k.id, k.reason])), { [other.id]: "protected", "gone-1": "missing" });
  assert.ok(rt.rows("Categories").some((c) => c.id === other.id));
  assert.deepEqual(post(rt, "deleteCategories", { ids: [] }).data, { deleted: [], hidden: [], kept: [], movedEntries: 0 });
});

test("the screen: pencil beside +, Other has no checkbox, the usage is asked first, one target per type, the merge alert, hide instead, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="categories-edit-btn"/);
  assert.match(html, /id="categories-editbar"/);
  assert.match(html, /id="categories-done-btn"/);
  assert.match(html, /id="cat-bulk-backdrop"/);
  assert.match(app, /callApi\("previewCategoryDelete", \{ ids \}\)/, "the usage is asked before anything is offered");
  assert.match(app, /callApi\("deleteCategories", \{ ids, reassign: opts\.reassign, hideUsed: !!opts\.hideUsed \}\)/);
  assert.match(app, /const isOther = isOtherCategory_\(c\)/, "the built-in Other has no checkbox");
  assert.match(app, /id="cat-bulk-target-\$\{b\.t\}"/, "one target picker per type");
  assert.match(app, /catBulk\.mergeAlert/, "the alert about several categories ending up in one");
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "categories" && categoriesEditing_/, "leaving the screen ends Edit mode");
  for (const key of ["catBulk.title", "catBulk.confirmMany", "catBulk.intro", "catBulk.introAll", "catBulk.moveLabel", "catBulk.moveCount", "catBulk.mergeAlert", "catBulk.noTarget",
    "catBulk.moveBtn", "catBulk.moveHint", "catBulk.moveRest", "catBulk.hideBtn", "catBulk.hideHint", "catBulk.hideRest", "catBulk.resultDeleted", "catBulk.resultMoved",
    "catBulk.resultHidden", "catBulk.resultNoTarget", "catBulk.resultHiddenAlready", "catBulk.resultKept", "catBulk.doneDeleted"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key);
  }
});
