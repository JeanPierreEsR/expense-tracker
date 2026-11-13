// Undo of a Needs review Confirm (owner, 2026-11-12): a plain confirmed entry goes back to waiting; a split one or one typed
// by hand cannot. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("unconfirmEntry sends a plain confirmed entry back to Needs review, and refuses a hand-typed one", () => {
  const { rt } = freshApp({ entries: 5 });
  rt.run(`appendRowObject('Entries', { id: 'u1', type: 'expense', date: '${today()}', amount: 12, currency: 'PEN', category_id: '', description: 'Bank cafe', paid_by: 'me', status: 'pending', source: 'email' });`);
  const cat = rt.api("getMeta", {}).categories.find((c) => c.type === "expense");
  rt.api("updateEntry", { id: "u1", fields: { category_id: cat.id } });
  rt.api("confirmEntry", { id: "u1" });
  assert.equal(rt.run(`getEntryById_('u1').status`), "confirmed");
  rt.api("unconfirmEntry", { id: "u1" });
  assert.equal(rt.run(`getEntryById_('u1').status`), "pending");
  rt.run(`appendRowObject('Entries', { id: 'u2', type: 'expense', date: '${today()}', amount: 5, currency: 'PEN', category_id: '${cat.id}', description: 'typed', paid_by: 'me', status: 'confirmed', source: 'manual' });`);
  assert.throws(() => rt.api("unconfirmEntry", { id: "u2" }));
  assert.equal(rt.api("getMeta", {}).capabilities.unconfirmEntry, true);
});
