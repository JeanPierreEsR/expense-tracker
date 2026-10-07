// "Split a bill by items", step 2: the bill is stored with the entry so its
// items can be edited later (backend/EntryBills.gs). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function expenseWithSplit(rt, data) {
  const friend = rt.api("addFriend", { name: "Bill Friend " + Math.random().toString(36).slice(2, 7) });
  const cat = data.cats.find((c) => c.type === "expense");
  const entry = rt.api("createEntry", {
    type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat.id,
    description: "Test dinner", paid_by: "me", payment_method_id: data.pms[3].id
  });
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 40 }] });
  return { entry, friend, cat };
}
const bill = (friendId) => ({
  v: 1, total: "100", people: [friendId],
  items: [{ id: 1, name: "Ceviche", price: "100", people: ["me", friendId], discount: false }],
  adjs: [], tip: { type: "percent", percent: "", amount: "", mode: "proportional" }
});

test("a bill that was never saved reads back as null (and works before the tab exists)", () => {
  const { rt, data } = freshApp();
  const { entry } = expenseWithSplit(rt, data);
  assert.deepEqual(rt.api("getEntryBill", { entryId: entry.id }), { bill: null });
});

test("saving a bill stores it and reads it back unchanged; saving again replaces it", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = expenseWithSplit(rt, data);
  rt.api("saveEntryBill", { entryId: entry.id, bill: bill(friend.id) });
  assert.deepEqual(rt.api("getEntryBill", { entryId: entry.id }).bill, bill(friend.id));

  const changed = bill(friend.id); changed.items[0].price = "120";
  rt.api("saveEntryBill", { entryId: entry.id, bill: changed });
  assert.equal(rt.rows("Entry Bills").filter((r) => r.entry_id === entry.id).length, 1, "one row per entry");
  assert.equal(rt.api("getEntryBill", { entryId: entry.id }).bill.items[0].price, "120");
});

test("saving null removes the bill", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = expenseWithSplit(rt, data);
  rt.api("saveEntryBill", { entryId: entry.id, bill: bill(friend.id) });
  rt.api("saveEntryBill", { entryId: entry.id, bill: null });
  assert.equal(rt.api("getEntryBill", { entryId: entry.id }).bill, null);
});

test("clearing the split also clears the bill behind it; keeping a split keeps it", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = expenseWithSplit(rt, data);
  rt.api("saveEntryBill", { entryId: entry.id, bill: bill(friend.id) });
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [{ friend_id: friend.id, amount: 45 }] });
  assert.ok(rt.api("getEntryBill", { entryId: entry.id }).bill, "still split -> bill kept");
  rt.api("saveEntrySplits", { entryId: entry.id, splits: [] });
  assert.equal(rt.api("getEntryBill", { entryId: entry.id }).bill, null);
});

test("deleting the entry deletes its bill", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = expenseWithSplit(rt, data);
  rt.api("saveEntryBill", { entryId: entry.id, bill: bill(friend.id) });
  rt.api("discardEntry", { id: entry.id });
  assert.equal(rt.rows("Entry Bills").filter((r) => r.entry_id === entry.id).length, 0);
});

test("only an expense can have a bill; junk and oversized bills are refused", () => {
  const { rt, data } = freshApp();
  const { entry, friend } = expenseWithSplit(rt, data);
  const tcat = data.cats.find((c) => c.type === "transfer") || data.cats[0];
  const transfer = rt.api("createEntry", { type: "transfer", date: today(), amount: 5, currency: "PEN", category_id: tcat.id, description: "t", paid_by: "me", payment_method_id: data.pms[3].id });
  assert.throws(() => rt.api("saveEntryBill", { entryId: transfer.id, bill: bill(friend.id) }), /Only an expense/);
  assert.throws(() => rt.api("saveEntryBill", { entryId: entry.id, bill: { nope: true } }), /not in a format/);
  const huge = bill(friend.id); huge.items[0].name = "x".repeat(50000);
  assert.throws(() => rt.api("saveEntryBill", { entryId: entry.id, bill: huge }), /too large/);
  assert.throws(() => rt.api("saveEntryBill", { entryId: "nope", bill: bill(friend.id) }), /Entry not found/);
});
