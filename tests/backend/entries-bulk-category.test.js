// Home → Edit, stage 2 (owner's request 2026-11-03): change the category of several entries at once, with an Undo. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  const pm = data.pms[3].id;
  const cat = (name, type = "expense") => rt.api("saveCategory", { type, name, icon: "🐶" }).id;
  const c = { a: cat("Bulk A"), b: cat("Bulk B"), target: cat("Bulk Target"), income: cat("Bulk Income", "income"), incomeTarget: cat("Bulk Income Target", "income") };
  const travel = rt.rows("Categories").find((x) => x.type === "expense" && x.key === "travel");
  const add = (id, extra) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: c.a, description: id, paid_by: "me", status: "confirmed", source: "manual", payment_method_id: pm }, extra))});`);
  add("bc-a1", {}); add("bc-a2", {}); add("bc-b1", { category_id: c.b }); add("bc-blank", { category_id: "" }); add("bc-target", { category_id: c.target });
  add("bc-income", { type: "income", category_id: c.income });
  add("bc-transfer", { type: "transfer", category_id: "" });
  add("bc-invest", { type: "investment", category_id: "" });
  const catOf = (id) => rt.rows("Entries").find((e) => e.id === id).category_id;
  return { rt, c, travel, catOf };
}

test("the backend says it can change categories in bulk", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.entriesBulkCategory, true);
});

test("expenses move to the expense category chosen, income to the income one; transfers, investments, those already there and unknown ids are kept with the reason", () => {
  const { rt, c, catOf } = setup();
  const res = rt.api("setEntriesCategory", { ids: ["bc-a1", "bc-a2", "bc-b1", "bc-blank", "bc-target", "bc-income", "bc-transfer", "bc-invest", "gone-1", "bc-a1"], categories: { expense: c.target, income: c.incomeTarget } });
  assert.deepEqual(res.changed.map((x) => x.id).sort(), ["bc-a1", "bc-a2", "bc-b1", "bc-blank", "bc-income"], "a repeated id counts once");
  assert.deepEqual(res.changed.find((x) => x.id === "bc-b1"), { id: "bc-b1", from: c.b, to: c.target });
  assert.equal(res.changed.find((x) => x.id === "bc-blank").from, "", "an uncategorized entry can be categorized");
  const why = Object.fromEntries(res.kept.map((k) => [k.id, k.reason]));
  assert.deepEqual(why, { "bc-target": "same", "bc-transfer": "type", "bc-invest": "type", "gone-1": "missing" });
  ["bc-a1", "bc-a2", "bc-b1", "bc-blank"].forEach((id) => assert.equal(catOf(id), c.target, id));
  assert.equal(catOf("bc-income"), c.incomeTarget);
  assert.equal(catOf("bc-transfer"), "", "a transfer has no category of its own");
});

test("a type with no choice is left alone, and a category of the other type is refused; nothing else about the entry changes", () => {
  const { rt, c, catOf } = setup();
  const before = rt.rows("Entries").find((e) => e.id === "bc-a1");
  const onlyExpense = rt.api("setEntriesCategory", { ids: ["bc-a1", "bc-income"], categories: { expense: c.target } });
  assert.deepEqual(onlyExpense.changed.map((x) => x.id), ["bc-a1"]);
  assert.equal(onlyExpense.kept.find((k) => k.id === "bc-income").reason, "noTarget");
  const wrong = rt.api("setEntriesCategory", { ids: ["bc-a2", "bc-income"], categories: { expense: c.incomeTarget, income: c.target } });
  assert.deepEqual(wrong.changed, []);
  assert.deepEqual(wrong.kept.map((k) => k.reason).sort(), ["badCategory", "badCategory"]);
  assert.equal(catOf("bc-a2"), c.a, "refused: still where it was");
  const after = rt.rows("Entries").find((e) => e.id === "bc-a1");
  assert.equal(after.amount, before.amount); assert.equal(after.description, before.description); assert.equal(after.date, before.date);
});

test("moving entries INTO Travel makes them Annual too, and Undo puts the old categories back and removes exactly those tags", () => {
  const { rt, c, travel, catOf } = setup();
  assert.ok(travel, "the test data has a Travel category");
  const res = rt.api("setEntriesCategory", { ids: ["bc-a1", "bc-b1"], categories: { expense: travel.id } });
  assert.equal(res.annualIds.length, 2);
  assert.ok(rt.rows("Entry Tags").filter((t) => t.tag_id === "system-annual").length >= 2);
  const undo = rt.api("undoSetEntriesCategory", { changes: res.changed, annualIds: res.annualIds });
  assert.deepEqual(undo.reverted.sort(), ["bc-a1", "bc-b1"]);
  assert.equal(catOf("bc-a1"), c.a);
  assert.equal(catOf("bc-b1"), c.b, "each goes back to ITS OWN old category");
  assert.ok(!rt.rows("Entry Tags").some((t) => t.tag_id === "system-annual" && ["bc-a1", "bc-b1"].includes(t.entry_id)));
});

test("Undo never overwrites a later change: an entry moved again in the meantime stays where it is", () => {
  const { rt, c, catOf } = setup();
  const res = rt.api("setEntriesCategory", { ids: ["bc-a1", "bc-a2"], categories: { expense: c.target } });
  rt.api("setEntriesCategory", { ids: ["bc-a2"], categories: { expense: c.b } });
  const undo = rt.api("undoSetEntriesCategory", { changes: res.changed, annualIds: res.annualIds });
  assert.deepEqual(undo.reverted, ["bc-a1"]);
  assert.equal(catOf("bc-a2"), c.b);
});

test("the screen: a Change button in the bar (Category is one of its choices), one sheet with a picker per type, the merge alert, an Undo, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="entries-change-selected-btn"/);
  assert.match(app, /callApi\("setEntriesCategory", \{ ids: sendIds, categories \}\)/);
  assert.match(app, /callApi\("undoSetEntriesCategory"/);
  assert.match(app, /entriesBulk\.catMerge/, "the alert about several categories ending up in one");
  assert.match(app, /busy: "entriesBulk\.changing"/);
  for (const key of ["entriesBulk.categoryN", "entriesBulk.catTitle", "entriesBulk.catMove.expense", "entriesBulk.catMove.income", "entriesBulk.catPick", "entriesBulk.catMerge", "entriesBulk.catLeftOut", "entriesBulk.catNothing",
    "entriesBulk.catGo", "entriesBulk.changing", "entriesBulk.catDone", "entriesBulk.catUndone", "entriesBulk.why.type", "entriesBulk.why.badCategory"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: .+, es: .+ \\}`), key);
  }
});
