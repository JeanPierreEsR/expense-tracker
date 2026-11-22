// Needs review (owner, 2026-11-19): tags on a waiting item (its card's "Tags" button, Edit mode's "Tag (n)") and, in the full form,
// Repeat and a future date that turns the item into a Programmed item. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function pending(rt, data, over) {
  const cat = data.cats.find((c) => c.type === "expense");
  const e = { id: "rf-" + Math.random().toString(36).slice(2, 8), type: "expense", date: today(), amount: 42.5, currency: "PEN", category_id: cat.id, description: "Corner shop", paid_by: "me", payment_method_id: data.pms[0].id, status: "pending", source: "email", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
const futureDate = () => { const d = new Date(today() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 10); return d.toISOString().slice(0, 10); };

test("the backend says it can tag waiting items and turn one into a Programmed item", () => {
  const { rt } = freshApp();
  const caps = rt.api("getMeta", {}).capabilities;
  assert.equal(caps.reviewTags, true);
  assert.equal(caps.programPending, true);
});

test("a waiting item carries its tags, and confirming it keeps them", () => {
  const { rt, data } = freshApp();
  const e = pending(rt, data);
  const tag = rt.api("addTag", { name: "Work trip" });
  assert.deepEqual(rt.api("listPendingEntries", {}).find((x) => x.id === e.id).tagIds, []);
  rt.api("saveEntryTags", { entryId: e.id, tagIds: [tag.id] });
  assert.deepEqual(rt.api("listPendingEntries", {}).find((x) => x.id === e.id).tagIds, [tag.id]);
  rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { category_id: e.category_id } });   // the card's own Confirm sends no tags
  assert.equal(rt.rows("Entries").find((x) => x.id === e.id).status, "confirmed");
  assert.deepEqual(rt.api("getEntryTags", { entryId: e.id }), [tag.id]);
});

test("Edit mode's Tag (n) tags several waiting items at once", () => {
  const { rt, data } = freshApp();
  const a = pending(rt, data), b = pending(rt, data, { description: "Bakery" });
  const tag = rt.api("addTag", { name: "Shared flat" });
  const out = rt.api("setEntriesTag", { ids: [a.id, b.id], tag_id: tag.id, mode: "add" });
  assert.equal(out.changed.length, 2);
  const list = rt.api("listPendingEntries", {});
  assert.deepEqual(list.find((x) => x.id === a.id).tagIds, [tag.id]);
  assert.deepEqual(list.find((x) => x.id === b.id).tagIds, [tag.id]);
});

test("confirming in the full form with Repeat makes a Programmed item, with the entry as its first payment", () => {
  const { rt, data } = freshApp();
  const e = pending(rt, data, { description: "Gym membership" });
  const out = rt.api("saveEntryAll", { kind: "confirm", id: e.id, fields: { category_id: e.category_id }, repeat: { frequency: "monthly" } });
  const items = rt.rows("Recurring Expenses").filter((r) => r.description === "Gym membership");
  assert.equal(items.length, 1);
  assert.equal(items[0].frequency, "monthly");
  assert.equal(out.repeat.id, items[0].id);
  const saved = rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(saved.status, "confirmed");
  assert.equal(saved.recurring_expense_id, items[0].id);
});

test("a future date: the waiting item becomes a one-time Programmed item and leaves Needs review", () => {
  const { rt, data } = freshApp();
  const e = pending(rt, data, { description: "Concert tickets", source: "whatsapp" });
  const date = futureDate();
  rt.api("addRecurringExpense", { category_id: e.category_id, description: e.description, amount: 42.5, currency: "PEN", frequency: "once", date, active: true, pending_entry_id: e.id });
  const items = rt.rows("Recurring Expenses").filter((r) => r.description === "Concert tickets");
  assert.equal(items.length, 1);
  assert.equal(items[0].frequency, "once");
  assert.equal(String(items[0].date), date);
  assert.equal(rt.rows("Entries").some((x) => x.id === e.id), false, "the waiting entry is gone, as with Discard");
  assert.equal(rt.api("listPendingEntries", {}).some((x) => x.id === e.id), false);
});

test("an item that is no longer waiting is refused, and nothing is written", () => {
  const { rt, data } = freshApp();
  const e = pending(rt, data, { status: "confirmed", description: "Already handled" });
  assert.throws(() => rt.api("addRecurringExpense", { category_id: e.category_id, description: e.description, amount: 10, currency: "PEN", frequency: "once", date: futureDate(), active: true, pending_entry_id: e.id }),
    /no longer waiting|ya no está esperando/);
  assert.equal(rt.rows("Recurring Expenses").filter((r) => r.description === "Already handled").length, 0);
  assert.equal(rt.rows("Entries").find((x) => x.id === e.id).status, "confirmed");
});
