// A new entry saved in the background carries its own id (client_id): sending it again never makes a second entry.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const ID = "11111111-2222-4333-8444-555555555555";

function expenseCategory(rt) {
  return rt.rows("Categories").find((c) => c.type === "expense").id;
}

test("createEntry keeps the phone's id and answers a repeat with the same entry", () => {
  const { rt } = freshApp({ entries: 20 });
  const payload = { type: "expense", date: "2026-10-26", amount: 10, currency: "PEN", category_id: expenseCategory(rt), description: "Client id", client_id: ID };
  const first = rt.api("createEntry", payload);
  assert.equal(first.id, ID);
  const again = rt.api("createEntry", payload);
  assert.equal(again.id, ID);
  assert.equal(rt.rows("Entries").filter((e) => e.id === ID).length, 1, "one row, not two");
});

test("createEntry without a usable client_id makes its own id as before", () => {
  const { rt } = freshApp({ entries: 20 });
  const base = { type: "expense", date: "2026-10-26", amount: 10, currency: "PEN", category_id: expenseCategory(rt) };
  const a = rt.api("createEntry", { ...base, client_id: "not-a-uuid" });
  const b = rt.api("createEntry", base);
  assert.notEqual(a.id, "not-a-uuid");
  assert.notEqual(a.id, b.id);
});

test("the backend says it can take a client id", () => {
  const { rt } = freshApp({ entries: 20 });
  assert.equal(rt.api("getMeta", {}).capabilities.clientEntryId, true);
});
