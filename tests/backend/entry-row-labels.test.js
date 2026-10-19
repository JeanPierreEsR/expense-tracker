// Entry rows show the entry's labels (Tags) after "who paid": the server sends
// each confirmed entry's tag ids, in the list AND in the phone's search copy.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("listEntries and the search index carry each entry's tag ids", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Tags', { id: 'tag-a', name: 'Trip', color: '#ccc' });`);
  rt.run(`appendRowObject('Tags', { id: 'tag-b', name: 'Work', color: '#ccc' });`);
  ["e-two", "e-none"].forEach((id) =>
    rt.run(`appendRowObject('Entries', { id: '${id}', type: 'expense', date: '${today()}', amount: 10, currency: 'PEN', description: '${id}', paid_by: 'me', status: 'confirmed', source: 'manual' });`));
  rt.api("saveEntryTags", { entryId: "e-two", tagIds: ["tag-a", "tag-b"] });

  const listed = rt.api("listEntries", { limit: 100 });
  assert.deepEqual(listed.find((e) => e.id === "e-two").tagIds, ["tag-a", "tag-b"]);
  assert.deepEqual(listed.find((e) => e.id === "e-none").tagIds, []);

  const index = rt.api("listEntrySearchIndex", {});
  assert.deepEqual(index.find((e) => e.id === "e-two").tagIds, ["tag-a", "tag-b"]);
  assert.deepEqual(index.find((e) => e.id === "e-none").tagIds, []);
});
