// Undo of "Mark as paid… → pick an entry" (owner, 2026-11-28: the list loaded under the finger and a random entry became the Salary).
// Unlinking with what the link answered takes back the item's tags and trip it added. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const month = today().slice(0, 7);

test("unlinking with removeTagIds / clearTrip takes back what the link added, and only that", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-gym', name: 'LU gym', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Tags', { id: 'tag-a', name: 'LU tag a' }); appendRowObject('Tags', { id: 'tag-b', name: 'LU tag b' });`);
  const trip = rt.api("addTrip", { name: "LU trip", kind: "trip", start_date: `${month}-01`, end_date: `${month}-28` });
  rt.run(`appendRowObject('Recurring Expenses', { id: 'rec-gym', description: 'Gym', category_id: 'cat-gym', amount: 50, currency: 'PEN', frequency: 'monthly', day: 3, active: 'true', tag_ids: 'tag-a,tag-b', trip_id: '${trip.id}' });`);
  const e = rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date: `${month}-05`, amount: 12, currency: "PEN", category_id: "cat-gym", description: "Random LU", paid_by: "me", tag_ids: ["tag-a"] } });
  const out = rt.api("linkEntryToRecurring", { entryId: e.id, recurringExpenseId: "rec-gym" });
  assert.deepEqual(out.tagsAdded, ["tag-b"]);
  assert.equal(out.tripSet, true);
  rt.api("linkEntryToRecurring", { entryId: e.id, recurringExpenseId: "", removeTagIds: out.tagsAdded, clearTrip: out.tripSet });
  const row = JSON.parse(rt.run(`JSON.stringify(getEntryById_('${e.id}'))`));
  assert.equal(row.recurring_expense_id, "");
  assert.equal(row.trip_id, "");
  const tags = JSON.parse(rt.run(`JSON.stringify(getAllRows('Entry Tags').filter(function (t) { return t.entry_id === '${e.id}'; }).map(function (t) { return t.tag_id; }))`));
  assert.deepEqual(tags, ["tag-a"], "the tag the entry already had stays");
});
