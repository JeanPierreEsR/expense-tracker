// Budgets → Edit (owner's request 2026-11-02): several budgets deleted in one call, with their alert history; entries are never touched.
// Made-up data only. The screen itself was checked in a real browser on the test app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");

function setup() {
  const { rt, data } = freshApp({ small: true });
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  const cats = data.cats.filter((c) => c.type === "expense");
  const mk = (i, period) => rt.api("addBudget", { category_id: cats[i].id, amount: 100 + i, currency: "PEN", period_type: period });
  const a = mk(0, "monthly"), b = mk(1, "monthly"), c = mk(2, "yearly");
  [a, b, c].forEach((x) => rt.run(`appendRowObject('Budget Alert Log', ${JSON.stringify({ id: "log-" + x.id, budget_id: x.id, period_key: "2026-11", threshold: 75, sent_at: "2026-11-02T10:00:00" })});`));
  return { rt, a, b, c };
}

test("the backend says it can delete budgets in bulk", () => {
  assert.equal(freshApp({ small: true }).rt.api("getMeta", {}).capabilities.budgetsBulkDelete, true);
});

test("deleteBudgets removes only the chosen budgets and their alert history, in one call", () => {
  const { rt, a, b, c } = setup();
  const entriesBefore = rt.rows("Entries").length;
  const out = rt.api("deleteBudgets", { ids: [a.id, c.id] });
  assert.deepEqual(out.deleted.sort(), [a.id, c.id].sort());
  assert.deepEqual(out.missing, []);
  assert.deepEqual(rt.rows("Budgets").map((r) => r.id), [b.id], "the budget not chosen stays");
  assert.deepEqual(rt.rows("Budget Alert Log").map((r) => r.budget_id), [b.id], "only the alert history of the deleted ones goes");
  assert.equal(rt.rows("Entries").length, entriesBefore, "entries are never touched");
});

test("an id that no longer exists is reported, repeats count once, and an empty list does nothing", () => {
  const { rt, a, b } = setup();
  const out = rt.api("deleteBudgets", { ids: [a.id, a.id, "gone-1"] });
  assert.deepEqual(out.deleted, [a.id]);
  assert.deepEqual(out.missing, ["gone-1"]);
  assert.equal(rt.rows("Budgets").length, 2);
  assert.deepEqual(rt.api("deleteBudgets", { ids: [] }), { deleted: [], missing: [] });
  assert.deepEqual(rt.api("deleteBudgets", {}), { deleted: [], missing: [] });
  assert.ok(rt.rows("Budgets").some((r) => r.id === b.id));
});

test("the screen has an Edit button, a fixed bar, one question per batch, a sticky status and names in the result, in both languages", () => {
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="budgets-edit-btn"/);
  assert.match(html, /id="budgets-editbar"/);
  assert.match(app, /callApi\("deleteBudgets", \{ ids \}\)/);
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "budgets" && budgetsEditing_/, "leaving the tab ends Edit mode");
  for (const key of ["budgets.confirmDeleteOne", "budgets.confirmDeleteMany", "budgets.resultDeleted", "budgets.resultMissing", "budgets.perMonth", "budgets.perYear"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: ".+", es: ".+" \\}`), key + " in both languages");
  }
  assert.match(strings, /"budgets\.confirmDeleteMany":[^\n]*your entries are not touched/);
});
