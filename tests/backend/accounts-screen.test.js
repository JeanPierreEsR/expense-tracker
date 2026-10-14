// More → Accounts & cards: add and edit a payment method (savePaymentMethod)
// and add a bank (addBank). Entries point at the account's id, so editing
// must never detach them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

test("adding an account saves name, type, bank and last 4", () => {
  const { rt } = freshApp({ entries: 50 });
  const bank = post(rt, "addBank", { name: "Test Bank" }).data;
  const res = post(rt, "savePaymentMethod", { nickname: " Test Visa ", type: "credit", bank_id: bank.id, last_4: "0123" });
  assert.equal(res.ok !== false && !res.error, true, JSON.stringify(res));
  const row = rt.rows("Payment Methods").find((p) => p.nickname === "Test Visa");
  assert.ok(row);
  assert.equal(row.type, "credit");
  assert.equal(row.bank_id, bank.id);
  assert.equal(String(row.last_4), "0123", "a leading zero must survive");
  assert.ok(post(rt, "getMeta").data.paymentMethods.some((p) => p.id === row.id), "shows up in getMeta straight away");
});

test("editing renames and changes bank/last 4 without touching entries", () => {
  const { rt } = freshApp({ entries: 50 });
  const pm = post(rt, "savePaymentMethod", { nickname: "Old name", type: "debit", last_4: "1111" }).data;
  rt.run(`appendRowObject('Entries', { id: 'e-acct-test', type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', category_id: '', description: 'x', paid_by: 'me', payment_method_id: ${JSON.stringify(pm.id)}, status: 'confirmed', source: 'manual' });`);
  const before = rt.rows("Payment Methods").length;
  post(rt, "savePaymentMethod", { id: pm.id, nickname: "New name", type: "credit", bank_id: "", last_4: "" });
  const rows = rt.rows("Payment Methods");
  assert.equal(rows.length, before, "edit must not add a row");
  const row = rows.find((p) => p.id === pm.id);
  assert.equal(row.nickname, "New name");
  assert.equal(row.type, "credit");
  assert.equal(String(row.last_4 || ""), "");
  assert.equal(rt.rows("Entries").find((e) => e.id === "e-acct-test").payment_method_id, pm.id);
});

test("bad input is refused, in the app's language", () => {
  const { rt } = freshApp({ entries: 50 });
  const a = post(rt, "savePaymentMethod", { nickname: "A one", type: "credit" }).data;
  const err = (payload, lang) => post(rt, "savePaymentMethod", payload, lang);
  assert.match(JSON.stringify(err({ nickname: "", type: "credit" })), /Enter a name/);
  assert.match(JSON.stringify(err({ nickname: "B", type: "bogus" })), /valid type/);
  assert.match(JSON.stringify(err({ nickname: "B", type: "credit", last_4: "12" })), /4 numbers/);
  assert.match(JSON.stringify(err({ nickname: "B", type: "credit", last_4: "12345" })), /4 numbers/);
  assert.match(JSON.stringify(err({ nickname: "B", type: "credit", bank_id: "nope" })), /bank/);
  assert.match(JSON.stringify(err({ nickname: "a ONE", type: "debit" })), /already has that name/);
  assert.match(JSON.stringify(err({ nickname: "a ONE", type: "debit" }, "es")), /Ya hay otra cuenta/);
  assert.match(JSON.stringify(err({ id: "missing", nickname: "Z", type: "cash" })), /not found/);
  // renaming to its own name (different case) is fine
  assert.ok(!JSON.stringify(err({ id: a.id, nickname: "A ONE", type: "credit" })).includes("error"));
});

test("addBank reuses an existing bank by name", () => {
  const { rt } = freshApp({ entries: 50 });
  const first = post(rt, "addBank", { name: "Banco Nuevo" }).data;
  const again = post(rt, "addBank", { name: " banco nuevo " }).data;
  assert.equal(first.id, again.id);
  assert.equal(rt.rows("Banks").filter((b) => /banco nuevo/i.test(b.name)).length, 1);
  assert.ok(post(rt, "getMeta").data.banks.some((b) => b.id === first.id));
});
