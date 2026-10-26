// Needs review: "Make it a transfer" (convertPendingToTransfer). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function pending(rt, over) {
  const e = { id: "cv-" + Math.random().toString(36).slice(2, 8), type: "expense", date: today(), amount: 100, currency: "PEN", category_id: "cat-x", description: "Move", paid_by: "me", payment_method_id: "pm-a", status: "pending", source: "email", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}

test("a pending expense becomes a transfer FROM its account, with no category", () => {
  const { rt } = freshApp({ entries: 5 });
  const e = pending(rt, {});
  const out = rt.api("convertPendingToTransfer", { id: e.id, description: "Own money", amount: 80 });
  assert.equal(out.type, "transfer");
  assert.equal(out.payment_method_id, "pm-a");
  assert.ok(!out.to_payment_method_id);
  assert.notEqual(out.category_id, "cat-x", "the expense's category is dropped");
  assert.equal(out.description, "Own money");
  assert.equal(Number(out.amount), 80);
  assert.equal(out.status, "pending", "still waits for the owner's Confirm");
});

test("a pending income becomes a transfer TO its account", () => {
  const { rt } = freshApp({ entries: 5 });
  const e = pending(rt, { type: "income" });
  const out = rt.api("convertPendingToTransfer", { id: e.id });
  assert.equal(out.type, "transfer");
  assert.equal(out.to_payment_method_id, "pm-a");
  assert.ok(!out.payment_method_id);
});

test("only a pending expense or income can be converted", () => {
  const { rt } = freshApp({ entries: 5 });
  const done = pending(rt, { status: "confirmed" });
  assert.throws(() => rt.api("convertPendingToTransfer", { id: done.id }));
  const tr = pending(rt, { type: "transfer" });
  assert.throws(() => rt.api("convertPendingToTransfer", { id: tr.id }));
  assert.throws(() => rt.api("convertPendingToTransfer", { id: "nope" }));
});
