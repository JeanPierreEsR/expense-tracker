// "Repeat…" in the entry form (2026-11-05): saving an entry with a frequency also makes a Programmed item from it and links
// the entry as its first payment, in the same saveEntryAll call. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const uuid = () => "5678abcd-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");

function setup() {
  const { rt, data } = freshApp();
  const cat = data.cats.find((c) => c.type === "expense");
  const fields = { type: "expense", date: today(), amount: 79.99, currency: "USD", category_id: cat.id, description: "Ring app subscription", paid_by: "me", payment_method_id: data.pms[3].id };
  return { rt, data, cat, fields };
}
const itemsNamed = (rt, d) => rt.rows("Recurring Expenses").filter((r) => r.description === d);

test("a new entry with Repeat yearly makes a yearly item from its date, linked to the entry", () => {
  const { rt, cat, fields } = setup();
  const id = uuid();
  const out = rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id }), repeat: { frequency: "yearly" } });
  const items = itemsNamed(rt, fields.description);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.frequency, "yearly");
  assert.equal(it.category_id, cat.id);
  assert.equal(Number(it.amount), 79.99);
  assert.equal(it.currency, "USD");
  assert.equal(String(it.start_date), today());
  assert.equal(Number(it.day), Number(today().slice(8, 10)));
  assert.equal(Number(it.month), Number(today().slice(5, 7)));
  assert.equal(out.repeat.id, it.id);
  assert.equal(rt.rows("Entries").find((e) => e.id === id).recurring_expense_id, it.id);
});

test("sent twice (lost reply): one entry, one item", () => {
  const { rt, fields } = setup();
  const id = uuid();
  const payload = { kind: "create", fields: Object.assign({}, fields, { client_id: id }), repeat: { frequency: "monthly" } };
  rt.api("saveEntryAll", payload);
  rt.api("saveEntryAll", payload);
  assert.equal(rt.rows("Entries").filter((e) => e.id === id).length, 1);
  assert.equal(itemsNamed(rt, fields.description).length, 1);
});

test("an existing entry gets Repeat on edit; its split is carried to the item", () => {
  const { rt, fields } = setup();
  const friend = rt.api("addFriend", { name: "Repeat Pal " + Math.random().toString(36).slice(2, 7) });
  const id = uuid();
  rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id, currency: "PEN", amount: 90 }), splits: [{ friend_id: friend.id, amount: 30 }] });
  rt.api("saveEntryAll", { kind: "update", id, fields: { description: "Ring app subscription" }, repeat: { frequency: "custom", interval: "3", interval_unit: "months" } });
  const it = itemsNamed(rt, fields.description)[0];
  assert.equal(it.frequency, "custom");
  assert.equal(Number(it.interval), 3);
  assert.equal(it.interval_unit, "months");
  const rs = rt.rows("Recurring Expense Splits").filter((s) => s.recurring_expense_id === it.id).map((s) => [s.friend_id, Number(s.amount)]);
  assert.deepEqual(rs, [[friend.id, 30]]);
  assert.equal(rt.rows("Entries").find((e) => e.id === id).recurring_expense_id, it.id);
});

test("a bad frequency is refused before anything is saved", () => {
  const { rt, fields } = setup();
  const id = uuid();
  assert.throws(() => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id }), repeat: { frequency: "once" } }));
  assert.equal(rt.rows("Entries").filter((e) => e.id === id).length, 0);
  assert.equal(itemsNamed(rt, fields.description).length, 0);
});

test("an entry already linked to an item makes no second item", () => {
  const { rt, fields } = setup();
  const id = uuid();
  rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id }), repeat: { frequency: "yearly" } });
  rt.api("saveEntryAll", { kind: "update", id, fields: { amount: 80 }, repeat: { frequency: "monthly" } });
  assert.equal(itemsNamed(rt, fields.description).length, 1);
});

test("Past payments: linked and automatically matched entries of the item, newest first", () => {
  const { rt, cat } = setup();
  const item = rt.api("addRecurringExpense", { category_id: cat.id, description: "Ring app yearly", amount: 79.99, currency: "USD", frequency: "yearly", start_date: "2025-06-27", day: 27, month: 6 });
  const mk = (date, amount, desc) => rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date, amount, currency: "USD", category_id: cat.id, description: desc, paid_by: "me", client_id: uuid() } });
  const auto = mk("2026-06-28", 79.99, "ring renewal");      // one day after the due date: counted automatically
  const linked = mk("2025-07-15", 70, "ring first year");      // too far for the automatic rule: linked by hand
  rt.api("linkEntryToRecurring", { entryId: linked.id, recurringExpenseId: item.id });
  mk("2026-03-10", 79.99, "unrelated");                        // nowhere near a due date
  const res = rt.api("listRecurringPayments", { recurringExpenseId: item.id });
  assert.deepEqual(res.payments.map((p) => [p.id, p.linked]), [[auto.id, false], [linked.id, true]]);
});

test("the backend says it can do this", () => {
  const { rt } = setup();
  assert.equal(rt.run("getCapabilities_().entryRepeat"), true);
});
