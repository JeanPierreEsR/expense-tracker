// Accounts (owner, 2026-11-02): every copy has one built-in Cash account (any currency, never deleted / hidden / retyped), no new
// "transfer" accounts, and one Delete that deletes an unused account but HIDES one with history (like deleting a friend). Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const addEntry = (rt, id, extra) => rt.run(`appendRowObject('Entries', Object.assign({ id: ${JSON.stringify(id)}, type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', category_id: '', description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual' }, ${JSON.stringify(extra)}));`);
const cashId = (rt) => rt.run("cashAccountId_()");

test("a copy without any cash account gets one built-in Cash on open, once", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run("var s = getSheet('Payment Methods'); var h = getHeaders(s); var t = h.indexOf('type'); var v = s.getRange(2, 1, s.getLastRow() - 1, h.length).getValues(); for (var i = v.length - 1; i >= 0; i--) if (v[i][t] === 'cash') s.deleteRow(i + 2); setSetting_('cash_account_id', '');");
  assert.equal(rt.rows("Payment Methods").filter((p) => p.type === "cash").length, 0);
  post(rt, "getMeta", {}, "es");
  post(rt, "getMeta", {}, "es");
  const cash = rt.rows("Payment Methods").filter((p) => p.type === "cash");
  assert.equal(cash.length, 1, "exactly one, even after two opens");
  assert.equal(cash[0].nickname, "Efectivo");
  assert.equal(cashId(rt), cash[0].id);
  assert.equal(post(rt, "getMeta").data.settings.cash_account_id, cash[0].id, "the phone knows which one it is");
});

test("an existing cash account is adopted, never a second one", () => {
  const { rt } = freshApp({ entries: 20 });
  rt.run("setSetting_('cash_account_id', '');");
  const before = rt.rows("Payment Methods").filter((p) => p.type === "cash");
  post(rt, "getMeta");
  const after = rt.rows("Payment Methods").filter((p) => p.type === "cash");
  assert.equal(after.length, Math.max(1, before.length));
  if (before.length) assert.equal(cashId(rt), before[0].id);
});

test("the built-in Cash can be renamed but not deleted, hidden or retyped; it holds several currencies", () => {
  const { rt } = freshApp({ entries: 20 });
  post(rt, "getMeta");
  const id = cashId(rt);
  assert.match(JSON.stringify(post(rt, "removePaymentMethod", { id })), /built in/);
  assert.match(JSON.stringify(post(rt, "deletePaymentMethod", { id })), /built in/);
  assert.match(JSON.stringify(post(rt, "setPaymentMethodHidden", { id, hidden: true })), /built in/);
  assert.match(JSON.stringify(post(rt, "savePaymentMethod", { id, nickname: "Cash", type: "debit" })), /type stays Cash/);
  assert.equal(post(rt, "savePaymentMethod", { id, nickname: "Pocket money", type: "cash" }).ok, true);
  const res = post(rt, "setPaymentMethodOpeningBalance", { id, balances: [{ currency: "PEN", amount: 50, date: "2026-01-01" }, { currency: "USD", amount: 20, date: "2026-01-01" }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(rt.rows("Account Opening Balances").filter((r) => r.payment_method_id === id).length, 2);
});

test("a NEW account can't be a transfer; an existing one keeps that type", () => {
  const { rt } = freshApp({ entries: 20 });
  assert.equal(post(rt, "savePaymentMethod", { nickname: "Bank transfer", type: "transfer" }).ok, false);
  const id = "pm-old-transfer";
  rt.run(`appendRowObject('Payment Methods', { id: '${id}', nickname: 'Old transfer', type: 'transfer', bank_id: '', last_4: '' });`);
  assert.equal(post(rt, "savePaymentMethod", { id, nickname: "Old transfer 2", type: "transfer" }).ok, true);
});

test("one Delete: unused = deleted; with history = hidden (past entries keep it); Yape-linked = refused", () => {
  const { rt } = freshApp({ entries: 20 });
  const unused = post(rt, "savePaymentMethod", { nickname: "Unused card", type: "credit" }).data;
  const used = post(rt, "savePaymentMethod", { nickname: "Used card", type: "credit" }).data;
  const linked = post(rt, "savePaymentMethod", { nickname: "Linked acct", type: "debit" }).data;
  addEntry(rt, "e-rm-1", { payment_method_id: used.id });
  rt.run(`setSetting_('plin_pen', ${JSON.stringify(linked.id)});`);
  assert.equal(post(rt, "removePaymentMethod", { id: unused.id }).data.deleted, true);
  assert.ok(!rt.rows("Payment Methods").some((p) => p.id === unused.id));
  const r = post(rt, "removePaymentMethod", { id: used.id }).data;
  assert.equal(r.hidden, "yes");
  assert.equal(r.used, 1);
  assert.equal(rt.rows("Payment Methods").find((p) => p.id === used.id).hidden, "yes");
  assert.equal(rt.rows("Entries").find((e) => e.id === "e-rm-1").payment_method_id, used.id, "the entry keeps its account");
  assert.match(JSON.stringify(post(rt, "removePaymentMethod", { id: linked.id })), /Yape or Plin/);
  assert.equal(post(rt, "getMeta").data.capabilities.pmRemove, true);
});
