// More → Accounts, cards & platforms: delete an account nobody uses, refuse one that
// is in use (with a count), and hide / show an account instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const addEntry = (rt, id, extra) => rt.run(`appendRowObject('Entries', Object.assign({ id: ${JSON.stringify(id)}, type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', category_id: '', description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual' }, ${JSON.stringify(extra)}));`);

test("an unused account is deleted, together with its starting balance", () => {
  const { rt } = freshApp({ entries: 50 });
  const pm = post(rt, "savePaymentMethod", { nickname: "Throwaway", type: "transfer" }).data;
  post(rt, "setPaymentMethodOpeningBalance", { id: pm.id, balances: [{ currency: "PEN", amount: 5, date: "2026-01-01" }] });
  assert.ok(rt.rows("Account Opening Balances").some((r) => r.payment_method_id === pm.id), "the starting balance was saved");
  const before = rt.rows("Payment Methods").length;
  const res = post(rt, "deletePaymentMethod", { id: pm.id });
  assert.equal(res.data && res.data.deleted, true, JSON.stringify(res));
  assert.equal(rt.rows("Payment Methods").length, before - 1);
  assert.ok(!rt.rows("Payment Methods").some((p) => p.id === pm.id));
  assert.ok(!rt.rows("Account Opening Balances").some((r) => r.payment_method_id === pm.id));
  assert.ok(!post(rt, "getMeta").data.paymentMethods.some((p) => p.id === pm.id), "gone from getMeta at once");
});

test("an account used by an entry (either end) is refused with a count, in both languages", () => {
  const { rt } = freshApp({ entries: 50 });
  const a = post(rt, "savePaymentMethod", { nickname: "Used as from", type: "debit" }).data;
  const b = post(rt, "savePaymentMethod", { nickname: "Used as to", type: "debit" }).data;
  addEntry(rt, "e-del-1", { payment_method_id: a.id });
  addEntry(rt, "e-del-2", { type: "transfer", payment_method_id: a.id, to_payment_method_id: b.id });
  const en = JSON.stringify(post(rt, "deletePaymentMethod", { id: a.id }));
  assert.match(en, /2 entries use it/);
  assert.match(JSON.stringify(post(rt, "deletePaymentMethod", { id: b.id })), /1 entry uses it/);
  assert.match(JSON.stringify(post(rt, "deletePaymentMethod", { id: a.id }, "es")), /2 movimientos la usan/);
  assert.ok(rt.rows("Payment Methods").some((p) => p.id === a.id), "still there");
  assert.ok(rt.rows("Payment Methods").some((p) => p.id === b.id), "still there");
});

test("an account linked to Yape or Plin can't be deleted until unlinked", () => {
  const { rt } = freshApp({ entries: 50 });
  const pm = post(rt, "savePaymentMethod", { nickname: "Rail account", type: "debit" }).data;
  rt.run(`setSetting_('plin_pen', ${JSON.stringify(pm.id)});`);
  assert.match(JSON.stringify(post(rt, "deletePaymentMethod", { id: pm.id })), /Yape or Plin/);
  rt.run(`setSetting_('plin_pen', '');`);
  assert.equal(post(rt, "deletePaymentMethod", { id: pm.id }).data.deleted, true);
});

test("deleting a missing account says so", () => {
  const { rt } = freshApp({ entries: 50 });
  assert.match(JSON.stringify(post(rt, "deletePaymentMethod", { id: "nope" })), /not found/);
});

test("hide and show: the row and past entries stay, only the flag changes", () => {
  const { rt } = freshApp({ entries: 50 });
  const pm = post(rt, "savePaymentMethod", { nickname: "Old transfer", type: "transfer" }).data;
  addEntry(rt, "e-hide-1", { payment_method_id: pm.id });
  const hid = post(rt, "setPaymentMethodHidden", { id: pm.id, hidden: true });
  assert.equal(hid.data.hidden, "yes", JSON.stringify(hid));
  let row = post(rt, "getMeta").data.paymentMethods.find((p) => p.id === pm.id);
  assert.ok(row, "still in getMeta so past entries resolve its name");
  assert.equal(row.hidden, "yes");
  assert.equal(rt.rows("Entries").find((e) => e.id === "e-hide-1").payment_method_id, pm.id);
  post(rt, "setPaymentMethodHidden", { id: pm.id, hidden: false });
  row = post(rt, "getMeta").data.paymentMethods.find((p) => p.id === pm.id);
  assert.ok(!row.hidden, "shown again");
  assert.match(JSON.stringify(post(rt, "setPaymentMethodHidden", { id: "nope", hidden: true })), /not found/);
});
