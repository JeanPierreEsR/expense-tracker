// Home → Edit, stage 3 (owner's plan, 2026-11-03): a bulk delete keeps a 30-day safety copy; Undo and More → Recently deleted bring entries back. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const expense = (description, amount = 20) => rt.api("createEntry", { type: "expense", date: today(), amount, currency: "PEN", category_id: cat.id, description, paid_by: "me", payment_method_id: pm });
  const plain = expense("Restore plain", 25);
  const plain2 = expense("Restore plain 2", 30);
  const shared = expense("Restore shared", 60);
  const ana = rt.api("addFriend", { name: "Restore Ana" });
  rt.api("saveEntrySplits", { entryId: shared.id, splits: [{ friend_id: ana.id, amount: 30 }] });
  const tag = rt.api("addTag", { name: "Restore tag" });
  rt.api("saveEntryTags", { entryId: plain.id, tagIds: [tag.id] });
  return { rt, plain, plain2, shared, ana, tag, cat };
}
const entry = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("the backend says it can restore deleted entries", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.entriesRestore, true);
});

test("a bulk delete writes a safety copy, grouped by batch, with everything that goes with the entry", () => {
  const { rt, plain, plain2, shared } = setup();
  const res = rt.api("deleteEntries", { ids: [plain.id, plain2.id, shared.id] });
  assert.ok(res.batch_id);
  const copies = rt.rows("Deleted Entries");
  assert.equal(copies.length, 3);
  assert.ok(copies.every((c) => c.batch_id === res.batch_id));
  const sharedCopy = JSON.parse(copies.find((c) => c.entry_id === shared.id).payload);
  assert.equal(sharedCopy.splits.length, 1);
  assert.equal(sharedCopy.loans.length, 1, "the debt that came from the entry is in the copy");
  assert.equal(JSON.parse(copies.find((c) => c.entry_id === plain.id).payload).tags.length, 1);
  const listed = rt.api("listDeletedEntries", {});
  assert.equal(listed.days, 30);
  assert.equal(listed.batches.length, 1);
  assert.deepEqual(listed.batches[0].entries.map((e) => e.description).sort(), ["Restore plain", "Restore plain 2", "Restore shared"]);
  assert.equal(listed.batches[0].entries.find((e) => e.description === "Restore plain").amount, 25);
});

test("restoring a whole batch brings back the entries as they were: fields, split, debt and tags; the copy and the deletion log are cleared", () => {
  const { rt, plain, plain2, shared, tag } = setup();
  const before = { ...entry(rt, plain.id) };
  const res = rt.api("deleteEntries", { ids: [plain.id, plain2.id, shared.id] });
  assert.equal(entry(rt, plain.id), undefined);
  const out = rt.api("restoreDeletedEntries", { batch_id: res.batch_id });
  assert.deepEqual(out.restored.sort(), [plain.id, plain2.id, shared.id].sort());
  assert.deepEqual(out.lostDebt, []);
  const back = entry(rt, plain.id);
  ["amount", "description", "category_id", "date", "currency", "payment_method_id", "status", "type"].forEach((k) => assert.equal(String(back[k]), String(before[k]), k));
  assert.ok(String(back.updated_at) > String(before.updated_at || ""), "stamped again so every phone picks it up");
  assert.equal(rt.rows("Entry Splits").filter((s) => s.entry_id === shared.id).length, 1);
  assert.equal(rt.rows("Loans").filter((l) => l.origin === "entry" && l.entry_id === shared.id).length, 1, "the debt is back");
  assert.ok(rt.rows("Entry Tags").some((t) => t.entry_id === plain.id && t.tag_id === tag.id));
  assert.equal(rt.rows("Deleted Entries").length, 0);
  assert.ok(!rt.rows("Entry Deletions").some((d) => [plain.id, plain2.id, shared.id].includes(String(d.entry_id))), "otherwise a phone syncing later would drop them again");
  assert.deepEqual(rt.api("restoreDeletedEntries", { batch_id: res.batch_id }), { restored: [], lostDebt: [], skipped: [] }, "a second Undo does nothing");
});

test("other phones: after a restore the entry is a CHANGED row in the next sync, not a removed one", () => {
  const { rt, plain } = setup();
  const first = rt.api("syncEntrySearchIndex", {});
  const res = rt.api("deleteEntries", { ids: [plain.id] });
  const afterDelete = rt.api("syncEntrySearchIndex", { since: first.syncedAt, structureVersion: first.structureVersion, entriesVersion: first.entriesVersion });
  assert.ok(afterDelete.removedIds.includes(plain.id));
  rt.api("restoreDeletedEntries", { batch_id: res.batch_id });
  const afterRestore = rt.api("syncEntrySearchIndex", { since: first.syncedAt, structureVersion: first.structureVersion, entriesVersion: afterDelete.entriesVersion });
  assert.ok(!afterRestore.removedIds.includes(plain.id), "no longer reported as deleted");
  assert.ok(afterRestore.changed.some((r) => r.id === plain.id), "reported as changed, so the phone shows it again");
});

test("single entries can be restored from a batch; a friend deleted in the meantime means the debt is not restored, and it says so", () => {
  const { rt, plain, plain2, shared, ana } = setup();
  const res = rt.api("deleteEntries", { ids: [plain.id, plain2.id, shared.id] });
  const one = rt.api("restoreDeletedEntries", { batch_id: res.batch_id, ids: [plain2.id] });
  assert.deepEqual(one.restored, [plain2.id]);
  assert.ok(entry(rt, plain2.id) && !entry(rt, plain.id), "only the chosen one is back");
  assert.equal(rt.rows("Deleted Entries").length, 2, "the other two stay in the safety copy");
  rt.rows("Loans").filter((l) => l.friend_id === ana.id).forEach(() => {});
  rt.run(`deleteRowsWhere_('Friends', function (r) { return r.id === ${JSON.stringify(ana.id)}; });`);
  const two = rt.api("restoreDeletedEntries", { ids: [shared.id] });
  assert.deepEqual(two.restored, [shared.id]);
  assert.deepEqual(two.lostDebt, [shared.id]);
  assert.equal(rt.rows("Entry Splits").filter((s) => s.entry_id === shared.id).length, 0, "no split for a friend that no longer exists");
});

test("'delete for good' removes the copy; copies older than 30 days are purged", () => {
  const { rt, plain, plain2 } = setup();
  const res = rt.api("deleteEntries", { ids: [plain.id, plain2.id] });
  assert.deepEqual(rt.api("forgetDeletedEntries", { batch_id: res.batch_id, ids: [plain.id] }), { forgotten: 1 });
  assert.deepEqual(rt.api("restoreDeletedEntries", { ids: [plain.id] }).restored, [], "gone for good");
  rt.run(`appendRowObject('Deleted Entries', { batch_id: 'old-batch', deleted_at: '2020-01-01T00:00:00.000Z', entry_id: 'old-1', summary: '{}', payload: '{}' });`);
  const listed = rt.api("listDeletedEntries", {});
  assert.ok(!listed.batches.some((b) => b.batch_id === "old-batch"), "purged");
  assert.ok(listed.batches.some((b) => b.batch_id === res.batch_id));
});

test("the screens: a Recently deleted card in More, an Undo on the toast, restore and delete-for-good, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  for (const id of ["more-deleted-btn", "screen-deleted-entries", "deleted-back-btn", "deleted-list"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /"deleted-entries"/, "registered as a More sub-screen (tab memory)");
  assert.match(app, /restoreDeletedBatch_\(\{ batch_id: result\.batch_id \}\)/, "the Undo on the toast");
  assert.match(app, /callApi\("restoreDeletedEntries", payload\)/);
  assert.match(app, /callApi\("forgetDeletedEntries"/);
  for (const key of ["more.deleted", "deleted.title", "deleted.hint", "deleted.empty", "deleted.restoreAll", "deleted.restoreOne", "deleted.forget", "deleted.confirmForget", "deleted.restoring", "deleted.restored",
    "deleted.lostDebt", "deleted.batchTitle", "entriesBulk.doneUndo", "entriesBulk.undoHint"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: .+, es: .+ \\}`), key);
  }
});
