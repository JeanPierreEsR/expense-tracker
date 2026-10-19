// Travel is Annual by default (2026-10-19).
//  - A sheet-menu migration tags every past CONFIRMED Travel expense Annual
//    (preview first, never double-tags, skips pending/other types/categories).
//  - New Travel expenses get Annual on the server when they arrive without the
//    form's tag list (email, photo, statements, API), and when an existing entry
//    is moved INTO Travel. A form that sends its own tag list (even empty) wins.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action: "getMeta", payload: {} }));   // creates the Annual tag
  // The starter data already has a Travel category (key 'travel'); use it under a
  // fixed id and clear its sample entries so only the ones below are counted.
  rt.run(`var tc = getAllRows('Categories').filter(function (c) { return c.key === 'travel'; })[0];
    deleteRowsWhere_('Entries', function (e) { return e.category_id === tc.id; });
    updateRowFields_('Categories', tc.id, { id: 'cat-travel' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-flights', name: 'Flights', type: 'expense', icon: '', color: '#ccc', parent_id: 'cat-travel' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-other-x', name: 'Misc test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  return rt;
}
function add(rt, id, over = {}) {
  const e = { id, type: "expense", date: today(), amount: 100, currency: "PEN", category_id: "cat-travel", description: id, paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const annualIds = (rt) => rt.rows("Entry Tags").filter((t) => t.tag_id === "system-annual").map((t) => t.entry_id).sort();

test("migration: preview changes nothing, apply tags confirmed Travel expenses only, and a second run adds nothing", () => {
  const rt = setup();
  add(rt, "t1");
  add(rt, "t2", { category_id: "cat-flights" });                  // sub-category of Travel
  add(rt, "t3");                                                  // already Annual
  rt.run(`appendRowObject('Entry Tags', { entry_id: 't3', tag_id: 'system-annual' });`);
  add(rt, "p1", { status: "pending" });                           // pending: left alone
  add(rt, "i1", { type: "income" });                              // not an expense
  add(rt, "o1", { category_id: "cat-other-x" });                  // other category
  const before = annualIds(rt).length;

  const preview = rt.run(`adminTagTravelAnnual({ dryRun: true })`);
  assert.equal(preview.tagged, 2);
  assert.equal(preview.alreadyAnnual, 1);
  assert.equal(annualIds(rt).length, before, "a preview writes nothing");

  const applied = rt.run(`adminTagTravelAnnual({ dryRun: false })`);
  assert.equal(applied.tagged, 2);
  assert.deepEqual(annualIds(rt).filter((id) => ["t1", "t2", "t3", "p1", "i1", "o1"].includes(id)), ["t1", "t2", "t3"]);

  const again = rt.run(`adminTagTravelAnnual({ dryRun: false })`);
  assert.equal(again.tagged, 0);
  assert.equal(rt.rows("Entry Tags").filter((t) => t.entry_id === "t3" && t.tag_id === "system-annual").length, 1, "never double-tagged");
});

test("a new Travel expense with no tag list gets Annual; the form's own list wins; other categories and income do not", () => {
  const rt = setup();
  const make = (extra) => rt.api("createEntry", { type: "expense", date: today(), amount: 50, currency: "PEN", category_id: "cat-travel", paid_by: "me", ...extra });
  const bare = make({});
  const unticked = make({ tag_ids: [] });
  const ticked = make({ tag_ids: ["system-annual"] });
  const other = make({ category_id: "cat-other-x" });
  const income = make({ type: "income" });
  assert.deepEqual(annualIds(rt).filter((id) => [bare.id, unticked.id, ticked.id, other.id, income.id].includes(id)).sort(), [bare.id, ticked.id].sort());
});

test("moving an entry into Travel tags it once; re-saving it does not bring back a removed tag", () => {
  const rt = setup();
  add(rt, "m1", { category_id: "cat-other-x" });
  rt.api("updateEntry", { id: "m1", fields: { category_id: "cat-travel" } });
  assert.deepEqual(annualIds(rt).filter((id) => id === "m1"), ["m1"]);
  rt.api("saveEntryTags", { entryId: "m1", tagIds: [] });                       // owner removes it
  rt.api("updateEntry", { id: "m1", fields: { category_id: "cat-travel", description: "again" } });
  assert.deepEqual(annualIds(rt).filter((id) => id === "m1"), [], "same category = no change = no re-tag");
});
