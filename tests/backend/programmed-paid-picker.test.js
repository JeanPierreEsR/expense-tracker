// The Paid picker of a Programmed item: an entry that already paid another item is not offered. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("an entry that paid one item is offered for that item only", () => {
  const { rt, data } = freshApp({ small: true });
  const cat = data.cats.find((c) => c.type === "expense");
  const item = (description) => rt.api("addRecurringExpense", { category_id: cat.id, description, amount: 50, currency: "PEN", frequency: "monthly", day: 15 });
  const one = item("Demo gym");
  const two = item("Demo club");
  const made = rt.api("createEntry", { date: today(), type: "expense", amount: 50, currency: "PEN", category_id: cat.id, description: "Payment", paid_by: "me" });
  const id = made.id || made.entry.id;
  const month = today().slice(0, 7);
  const offered = (item_) => rt.api("listEntriesForRecurringMonth", { id: item_.id, month }).some((e) => e.id === id);

  assert.equal(offered(one), true);
  assert.equal(offered(two), true);
  rt.api("linkEntryToRecurring", { entryId: id, recurringExpenseId: one.id });
  assert.equal(offered(one), true, "still shown for its own item");
  assert.equal(offered(two), false, "not offered to another item");
});
