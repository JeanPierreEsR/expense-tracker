// Home → Edit on many entries was slow (owner, 2026-11-12: changing the category of 32 entries took far too long). Each entry was
// looked up on its own (~4 trips to Google each). Now each tab is read once per action (as the bulk delete already did), so the number
// of reads no longer grows with the number of entries. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup(n) {
  const { rt, data } = freshApp({ entries: 200 });
  const pm = data.pms[3].id;
  const from = rt.api("saveCategory", { type: "expense", name: "Speed From", icon: "🐢" }).id;
  const to = rt.api("saveCategory", { type: "expense", name: "Speed To", icon: "🐇" }).id;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = "sp-" + i;
    ids.push(id);
    rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: today(), amount: 10 + i, currency: "PEN", category_id: from, description: id, paid_by: "me", status: "confirmed", source: "manual", payment_method_id: pm })});`);
  }
  return { rt, ids, from, to };
}

// Reads a bulk action makes for `n` entries.
function readsFor(n, call) {
  const s = setup(n);
  s.rt.resetStats();
  const res = call(s);
  return { reads: s.rt.stats.reads, res, s };
}

const actions = {
  setEntriesCategory: (s) => s.rt.api("setEntriesCategory", { ids: s.ids, categories: { expense: s.to } }),
  setEntriesTag: (s) => s.rt.api("setEntriesTag", { ids: s.ids, tag_id: s.rt.rows("Tags")[0].id, mode: "add" }),
  setEntriesTrip: (s) => s.rt.api("setEntriesTrip", { ids: s.ids, trip_id: "" }),
  previewEntriesDelete: (s) => s.rt.api("previewEntriesDelete", { ids: s.ids }),
  deleteEntries: (s) => s.rt.api("deleteEntries", { ids: s.ids })
};

for (const [name, call] of Object.entries(actions)) {
  test(`${name}: 40 entries take about as many reads as 4`, () => {
    const few = readsFor(4, call), many = readsFor(40, call);
    assert.ok(many.reads <= few.reads + 2, `${name}: ${few.reads} reads for 4 entries, ${many.reads} for 40`);
  });
}

test("the faster category change still changes every entry, and Undo still puts them all back", () => {
  const { res, s } = readsFor(32, actions.setEntriesCategory);
  assert.equal(res.changed.length, 32);
  assert.ok(s.ids.every((id) => s.rt.rows("Entries").find((e) => e.id === id).category_id === s.to));
  s.rt.api("undoSetEntriesCategory", { changes: res.changed, annualIds: res.annualIds });
  assert.ok(s.ids.every((id) => s.rt.rows("Entries").find((e) => e.id === id).category_id === s.from));
});

test("the faster bulk delete still deletes them all and keeps the safety copy", () => {
  const { res, s } = readsFor(32, actions.deleteEntries);
  assert.equal(res.deleted.length, 32);
  assert.ok(res.batch_id);
  assert.equal(s.rt.rows("Entries").filter((e) => s.ids.includes(e.id)).length, 0);
});

test("entries moved into Travel get their Annual tag in one write", () => {
  const s = setup(20);
  const travel = s.rt.rows("Categories").find((x) => x.type === "expense" && x.key === "travel");
  const res = s.rt.api("setEntriesCategory", { ids: s.ids, categories: { expense: travel.id } });
  assert.equal(res.annualIds.length, 20);
  const tagged = s.rt.rows("Entry Tags").filter((t) => s.ids.includes(t.entry_id) && t.tag_id === "system-annual");
  assert.equal(tagged.length, 20);
});
