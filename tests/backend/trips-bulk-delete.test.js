// More → Trips & events → Edit (owner's request 2026-11-03): several trips / events deleted in one call. Like deleteTrip, expenses and estimates are
// only unlinked, never deleted. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Lodging test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const mk = (name, kind = "trip") => rt.api("addTrip", { name, kind, start_date: "2026-12-10", end_date: "2026-12-15" });
  const a = mk("Cusco"), b = mk("Birthday", "event"), c = mk("Lima weekend");
  const entry = (id, tripId) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: "2026-12-11", amount: 40, currency: "PEN", category_id: "cat-a", description: id, paid_by: "me", status: "confirmed", source: "manual", trip_id: tripId })});`);
  entry("tb-1", a.id); entry("tb-2", a.id); entry("tb-3", b.id); entry("tb-4", c.id);
  const est = rt.api("addRecurringExpense", { category_id: "cat-a", description: "Friend's hotel", amount: 400, currency: "PEN", frequency: "once", date: "2026-12-11", trip_id: a.id });
  const estKeep = rt.api("addRecurringExpense", { category_id: "cat-a", description: "Other hotel", amount: 300, currency: "PEN", frequency: "once", date: "2026-12-12", trip_id: c.id });
  rt.run(`appendRowObject('Budget Alert Log', ${JSON.stringify({ id: "tl-a", budget_id: a.id, period: "trip", threshold: 75 })});`);
  rt.run(`appendRowObject('Budget Alert Log', ${JSON.stringify({ id: "tl-c", budget_id: c.id, period: "trip", threshold: 75 })});`);
  return { rt, a, b, c, est, estKeep };
}
const tripOf = (rt, id) => rt.rows("Entries").find((e) => e.id === id).trip_id;

test("the backend says it can delete trips in bulk", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.tripsBulkDelete, true);
});

test("deleteTrips removes the chosen trips; their expenses and estimates stay, unlinked; the others are untouched", () => {
  const { rt, a, b, c, est, estKeep } = setup();
  const entriesBefore = rt.rows("Entries").length;
  const out = rt.api("deleteTrips", { ids: [a.id, b.id, a.id, "gone-1"] });
  assert.deepEqual(out.deleted.map((d) => d.name).sort(), ["Birthday", "Cusco"], "a repeated id counts once");
  assert.deepEqual(out.missing, ["gone-1"]);
  assert.deepEqual(rt.rows("Trips").map((t) => t.id), [c.id]);
  assert.equal(rt.rows("Entries").length, entriesBefore, "no expense is deleted");
  ["tb-1", "tb-2", "tb-3"].forEach((id) => assert.equal(tripOf(rt, id), "", id + " is unlinked"));
  assert.equal(tripOf(rt, "tb-4"), c.id, "an expense of a trip not chosen keeps its link");
  const recs = rt.rows("Recurring Expenses");
  assert.equal(recs.find((r) => r.id === est.id).trip_id, "", "the estimate stays, unlinked");
  assert.equal(recs.find((r) => r.id === estKeep.id).trip_id, c.id);
  assert.deepEqual(rt.rows("Budget Alert Log").filter((r) => r.period === "trip").map((r) => r.budget_id), [c.id], "only the deleted trips' alert history goes");
});

test("an empty list does nothing", () => {
  const { rt } = setup();
  const n = rt.rows("Trips").length;
  assert.deepEqual(rt.api("deleteTrips", { ids: [] }), { deleted: [], missing: [], groupsKept: [] });
  assert.deepEqual(rt.api("deleteTrips", {}), { deleted: [], missing: [], groupsKept: [] });
  assert.equal(rt.rows("Trips").length, n);
});

test("the screen: pencil beside +, fixed bar with Done, one question with the expense count, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="trips-edit-btn"/);
  assert.match(html, /id="trips-editbar"/);
  assert.match(html, /id="trips-done-btn"/);
  assert.match(app, /callApi\("deleteTrips", \{ ids \}\)/);
  assert.match(app, /busy: "common\.deletingToast"/);
  assert.match(app, /name !== "trips" && tripsEditing_/, "leaving the screen ends Edit mode");
  for (const key of ["trips.confirmDeleteMany", "trips.resultDeleted", "trips.resultMissing"]) {
    assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}": \\{ en: (".+"|\\{.+\\}), es: (".+"|\\{.+\\}) \\}`), key);
  }
  assert.match(strings, /"trips\.confirmDeleteMany":[^\n]*Their expenses \(\{entries\}\) are not deleted/);
});
