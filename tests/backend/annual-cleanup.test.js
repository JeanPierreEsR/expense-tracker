// The owner's one-time move out of the old "Annual budget" category (owner, 2026-11-14; AnnualCleanup.gs). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup({ friend } = {}) {
  const { rt } = freshApp({ small: true });
  if (friend) rt.run("PropertiesService.getScriptProperties().setProperty('FEATURES', 'x')");
  rt.run(`appendRowObject('Categories', { id: 'cat-ab', key: 'annual_budget', name: 'Annual budget', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-tix', name: 'Tickets test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-tv', name: 'Electronics test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  return rt;
}
function add(rt, description, amount, category = "cat-ab", status = "confirmed") {
  const id = "ac" + ++n;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: today(), amount, currency: "PEN", category_id: category, description, paid_by: "me", status, source: "manual" })});`);
  return id;
}
const tags = (rt, id) => JSON.parse(rt.run(`JSON.stringify(getAllRows('Entry Tags').filter(function (t) { return t.entry_id === '${id}'; }).map(function (t) { return t.tag_id; }))`));
const cat = (rt, id) => rt.run(`getEntryById_('${id}').category_id`);

test("every expense in the old category is listed, Needs review and blank descriptions included", () => {
  const rt = setup();
  add(rt, "LATAM Lima Cusco", 500); add(rt, "LATAM Lima Cusco", 450); add(rt, "Big TV", 1200); add(rt, "", 30); add(rt, "Hotel", 300, "cat-ab", "pending");
  add(rt, "LATAM Lima Cusco", 99, "cat-tix");   // already elsewhere: suggests Tickets for the group
  const r = rt.api("listAnnualCleanup", {});
  assert.equal(r.available, true);
  assert.equal(r.total, 5);
  assert.equal(r.groups.reduce((s, g) => s + g.count, 0), 5);
  const latam = r.groups.find((g) => g.label === "LATAM Lima Cusco");
  assert.equal(latam.count, 2);
  assert.equal(latam.suggestion && latam.suggestion.categoryId, "cat-tix");
  assert.ok(r.groups.some((g) => g.label === "(no description)"));
  assert.ok(r.groups.some((g) => g.samples.some((s) => s.pending)));
});

test("apply moves a group to its real category and tags it Annual; undo puts it back and removes only the tags it added", () => {
  const rt = setup();
  const a = add(rt, "Big TV", 1200);
  rt.run(`ensureAnnualTag_(); ensureAnnualOnEntry_('${a}');`);   // already tagged: undo must keep it
  const b = add(rt, "Big TV", 800);
  const key = rt.api("listAnnualCleanup", {}).groups[0].key;
  const res = rt.api("applyAnnualCleanup", { items: [{ key, categoryId: "cat-tv" }] });
  assert.equal(res.count, 2);
  assert.equal(res.left, 0);
  assert.deepEqual(res.annualIds, [b]);
  assert.equal(cat(rt, a), "cat-tv");
  assert.deepEqual(tags(rt, b), ["system-annual"]);
  rt.api("undoAnnualCleanup", res);
  assert.equal(cat(rt, a), "cat-ab");
  assert.equal(cat(rt, b), "cat-ab");
  assert.deepEqual(tags(rt, a), ["system-annual"]);
  assert.deepEqual(tags(rt, b), []);
  assert.throws(() => rt.api("applyAnnualCleanup", { items: [{ key, categoryId: "cat-ab" }] }), /not found|no longer exists/);
});

test("finish: only once empty; the yearly budget becomes 'Everything marked Annual' with the same amount and the old category is hidden", () => {
  const rt = setup();
  add(rt, "Big TV", 1200);
  const yearly = rt.api("addBudget", { category_id: "cat-ab", amount: 20000, currency: "PEN", period_type: "yearly", start: "always" });
  assert.throws(() => rt.api("finishAnnualCleanup", {}), /still in the old category/);
  const key = rt.api("listAnnualCleanup", {}).groups[0].key;
  rt.api("applyAnnualCleanup", { items: [{ key, categoryId: "cat-tv" }] });
  const before = rt.api("listAnnualCleanup", {});
  assert.deepEqual(before.groups, []);
  assert.equal(before.budgets.length, 1);
  const done = rt.api("finishAnnualCleanup", {});
  assert.deepEqual(done.converted, ["Annual budget"]);
  const b = rt.api("listBudgets", { displayPeriodType: "year", anchorDate: today().slice(0, 4) + "-01-01" }).budgets.find((x) => x.id === yearly.id);
  assert.equal(b.annual_kind, true);
  assert.equal(b.amount, 20000);
  assert.equal(b.progress.spent, 1200, "the moved, tagged expense still counts in it");
  assert.equal(rt.api("listAnnualCleanup", {}).available, false, "the card goes away");
});

test("a friend's copy never gets it", () => {
  const rt = setup({ friend: true });
  add(rt, "Big TV", 1200);
  assert.equal(rt.api("listAnnualCleanup", {}).available, false);
  assert.throws(() => rt.api("finishAnnualCleanup", {}), /already tidied/);
});

test("found by name when it has no key, sub-categories included; undo puts each expense back where it was", () => {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-ab2', key: '', name: 'Annual Budget', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-ab2-trips', key: '', name: 'Trips', type: 'expense', icon: '', color: '#ccc', parent_id: 'cat-ab2' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-food', name: 'Food test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const a = add(rt, "Flight", 900, "cat-ab2-trips");
  const b = add(rt, "Flight", 700, "cat-ab2");
  const r = rt.api("listAnnualCleanup", {});
  assert.equal(r.available, true);
  assert.equal(r.total, 2);
  assert.ok(r.categoryIds.includes("cat-ab2-trips"));
  const res = rt.api("applyAnnualCleanup", { items: [{ key: r.groups[0].key, categoryId: "cat-food" }] });
  assert.equal(res.count, 2);
  rt.api("undoAnnualCleanup", res);
  assert.equal(cat(rt, a), "cat-ab2-trips");
  assert.equal(cat(rt, b), "cat-ab2");
});
