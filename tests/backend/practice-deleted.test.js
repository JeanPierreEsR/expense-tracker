// First-use practice "Recently deleted": createPracticeDeleted makes two confirmed expenses that go through the REAL bulk delete / restore /
// delete-for-good calls, and removePracticeDeleted leaves nothing behind (no entry, no safety copy) while never touching a real entry or
// someone else's deleted batch. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ small: true });
  return { rt, data };
}
const mine = (rt) => rt.rows("Entries").filter((e) => String(e.external_id || "").startsWith("practice-deleted-"));
const copies = (rt) => rt.api("listDeletedEntries", {}).batches;

test("capability: a backend that can run the Recently deleted practice says so", () => {
  const caps = setup().rt.api("getMeta").capabilities;
  assert.equal(caps.practiceDeleted, true);
  assert.equal(caps.entriesRestore, true);
  assert.equal(caps.entriesBulk, true);
});

test("createPracticeDeleted makes two confirmed expenses with a category and no account (English or Spanish name)", () => {
  const { rt } = setup();
  const en = rt.api("createPracticeDeleted", { lang: "en" });
  assert.equal(en.ids.length, 2);
  assert.equal(en.name, "Practice snack");
  const es = rt.api("createPracticeDeleted", { lang: "es" });
  assert.equal(es.name, "Lonche de práctica");
  const rows = mine(rt);
  assert.equal(rows.length, 4);
  for (const e of rows) {
    assert.equal(e.type, "expense");
    assert.equal(e.status, "confirmed");
    assert.equal(e.date, today());
    assert.ok(String(e.category_id || ""), "a category, so the lists read like real entries");
    assert.equal(String(e.payment_method_id || ""), "");
    assert.equal(String(e.merchant || ""), "");
  }
});

test("the practice entries go through the real delete, restore one and delete-for-good the other", () => {
  const { rt } = setup();
  const { ids } = rt.api("createPracticeDeleted", { lang: "en" });
  const del = rt.api("deleteEntries", { ids });
  assert.deepEqual(del.deleted.slice().sort(), ids.slice().sort());
  assert.equal(mine(rt).length, 0);
  const batch = copies(rt).find((b) => b.entries.some((e) => ids.includes(e.entry_id)));
  assert.equal(batch.entries.length, 2);
  const back = rt.api("restoreDeletedEntries", { batch_id: del.batch_id, ids: [ids[0]] });
  assert.deepEqual(back.restored, [ids[0]]);
  assert.equal(mine(rt).length, 1);
  const left = copies(rt).find((b) => b.batch_id === del.batch_id);
  assert.deepEqual(left.entries.map((e) => e.entry_id), [ids[1]]);
  rt.api("forgetDeletedEntries", { batch_id: del.batch_id });
  assert.equal(copies(rt).length, 0);
});

test("removePracticeDeleted after the full walkthrough: the restored entry goes, nothing stays in Recently deleted", () => {
  const { rt } = setup();
  const before = rt.rows("Entries").length;
  const { ids } = rt.api("createPracticeDeleted", { lang: "en" });
  const del = rt.api("deleteEntries", { ids });
  rt.api("restoreDeletedEntries", { batch_id: del.batch_id, ids: [ids[0]] });
  rt.api("forgetDeletedEntries", { batch_id: del.batch_id });
  const out = rt.api("removePracticeDeleted", {});
  assert.equal(out.entries, 1);
  assert.equal(mine(rt).length, 0);
  assert.equal(rt.rows("Entries").length, before);
  assert.equal(copies(rt).length, 0);
});

test("removePracticeDeleted after an Exit midway: entries still on the books and a practice batch both disappear", () => {
  const { rt } = setup();
  const a = rt.api("createPracticeDeleted", { lang: "en" });
  rt.api("deleteEntries", { ids: a.ids });                       // deleted, never restored: the batch is still in Recently deleted
  const b = rt.api("createPracticeDeleted", { lang: "es" });      // a second, untouched pair
  const out = rt.api("removePracticeDeleted", {});
  assert.equal(out.entries, 2);
  assert.equal(out.copies, 2);
  assert.equal(mine(rt).length, 0);
  assert.equal(copies(rt).length, 0);
  assert.ok(b.ids.length === 2);
});

test("removePracticeDeleted never touches a real entry (same words) or a real deleted batch", () => {
  const { rt, data } = setup();
  const cat = data.cats.find((c) => c.type === "expense");
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "real-snack", type: "expense", date: today(), created_at: today() + "T09:00:00", amount: 7, currency: "PEN", status: "confirmed", source: "manual", description: "Practice snack", paid_by: "me", category_id: cat.id })})`);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "real-lunch", type: "expense", date: today(), created_at: today() + "T09:00:00", amount: 20, currency: "PEN", status: "confirmed", source: "manual", description: "Real lunch", paid_by: "me", category_id: cat.id })})`);
  const realDel = rt.api("deleteEntries", { ids: ["real-lunch"] });
  const { ids } = rt.api("createPracticeDeleted", { lang: "en" });
  rt.api("deleteEntries", { ids });
  rt.api("removePracticeDeleted", {});
  assert.ok(rt.rows("Entries").some((e) => e.id === "real-snack"), "a real entry named like the practice stays");
  const left = copies(rt);
  assert.equal(left.length, 1);
  assert.equal(left[0].batch_id, realDel.batch_id);
  assert.deepEqual(left[0].entries.map((e) => e.entry_id), ["real-lunch"]);
});

test("the practice entries never set off a budget alert", () => {
  const { rt } = setup();
  rt.api("createPracticeDeleted", { lang: "en" });
  assert.equal(rt.run("isPracticeEntry_({description: 'Practice snack'})"), true);
  assert.equal(rt.run("isPracticeEntry_({description: 'Merienda de práctica'})"), true, "the old Spanish name is still recognised");
  assert.equal(rt.run("isPracticeEntry_({description: 'Lonche de práctica'})"), true);
});
