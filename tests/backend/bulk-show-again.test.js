// Undo after a bulk delete / hide and the bulk "Show again" (Friends, Accounts, Categories; owner's request 2026-11-03). Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const setup = () => { const { rt } = freshApp({ entries: 10 }); post(rt, "getMeta"); return rt; };

test("the backend says it can undo and show again in bulk", () => {
  assert.equal(post(setup(), "getMeta").data.capabilities.bulkShowAgain, true);
});

test("friends: Undo shows the hidden ones again AND brings back the ones deleted for good; Show again alone works too", () => {
  const rt = setup();
  const add = (name) => post(rt, "addFriend", { name }).data;
  const free = add("Free Test"), history = add("History Test"), other = add("Other Test");
  post(rt, "setFriendPhone", { id: free.id, phone: "999000111" });
  post(rt, "addLoan", { friend_id: history.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-05" });
  post(rt, "recordRepayment", { friend_id: history.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-06", payment_method_id: rt.rows("Payment Methods")[0].id });
  const out = post(rt, "deleteFriends", { ids: [free.id, history.id] }).data;
  assert.deepEqual(out.deleted, [free.id]);
  assert.equal(out.deletedRows.length, 1);
  assert.equal(out.deletedRows[0].name, "Free Test");
  assert.ok(!rt.rows("Friends").some((f) => f.id === free.id));
  const back = post(rt, "restoreFriends", { show: [history.id], rows: out.deletedRows }).data;
  assert.deepEqual([back.shown, back.restored, back.skipped], [1, 1, []]);
  const rows = rt.rows("Friends");
  assert.equal(rows.find((f) => f.id === history.id).hidden || "", "");
  const restored = rows.find((f) => f.id === free.id);
  assert.equal(restored.name, "Free Test");
  assert.equal(String(restored.phone).replace(/\D/g, ""), "999000111", "the number comes back with the friend");
  assert.equal(rows.filter((f) => f.id === free.id).length, 1);
  // Twice is harmless: nobody is duplicated.
  const again = post(rt, "restoreFriends", { show: [history.id], rows: out.deletedRows }).data;
  assert.deepEqual([again.restored, again.skipped], [0, ["Free Test"]]);
  assert.equal(rt.rows("Friends").filter((f) => f.id === free.id).length, 1);
  // A friend with the same name added meanwhile is not duplicated either.
  post(rt, "deleteFriends", { ids: [other.id] });
  add("Other Test");
  const clash = post(rt, "restoreFriends", { rows: [{ id: other.id, name: "Other Test" }] }).data;
  assert.deepEqual([clash.restored, clash.skipped], [0, ["Other Test"]]);
  assert.equal(rt.rows("Friends").filter((f) => f.name === "Other Test").length, 1);
  // Show again on its own, and a missing id is skipped.
  post(rt, "deleteFriends", { ids: [history.id] });
  assert.equal(post(rt, "restoreFriends", { show: [history.id, "ghost"] }).data.shown, 1);
  assert.equal(post(rt, "restoreFriends", {}).ok, true);
});

test("accounts: Undo shows hidden ones again and puts back a deleted one with its starting balance", () => {
  const rt = setup();
  const mk = (nickname) => post(rt, "savePaymentMethod", { nickname, type: "debit" }).data.id;
  const free = mk("Demo Free"), used = mk("Demo Used");
  post(rt, "setPaymentMethodOpeningBalance", { id: free, balances: [{ currency: "PEN", amount: 50, date: "2026-01-01" }] });
  rt.run(`appendRowObject('Entries', { id: 'sa-1', type: 'expense', date: '2026-01-05', amount: 10, currency: 'PEN', description: 'x', paid_by: 'me', status: 'confirmed', source: 'manual', payment_method_id: ${JSON.stringify(used)} });`);
  const out = post(rt, "removePaymentMethods", { ids: [free, used] }).data;
  assert.deepEqual(out.deleted.map((d) => d.id), [free]);
  assert.deepEqual(out.hidden.map((d) => d.id), [used]);
  assert.equal(out.deletedRows.accounts.length, 1);
  assert.equal(out.deletedRows.balances.length, 1);
  assert.ok(!rt.rows("Payment Methods").some((p) => p.id === free));
  const back = post(rt, "restorePaymentMethods", { show: [used], rows: out.deletedRows }).data;
  assert.deepEqual([back.shown, back.restored, back.skipped], [1, 1, []]);
  const pms = rt.rows("Payment Methods");
  assert.equal(pms.find((p) => p.id === used).hidden || "", "");
  assert.equal(pms.find((p) => p.id === free).nickname, "Demo Free");
  assert.equal(pms.find((p) => p.id === free).hidden || "", "");
  const bal = rt.rows("Account Opening Balances").filter((b) => b.payment_method_id === free);
  assert.equal(bal.length, 1);
  assert.equal(Number(bal[0].amount), 50);
  // Twice: nothing doubles.
  const again = post(rt, "restorePaymentMethods", { rows: out.deletedRows }).data;
  assert.equal(again.restored, 0);
  assert.equal(rt.rows("Account Opening Balances").filter((b) => b.payment_method_id === free).length, 1);
});

test("categories: Show again in bulk", () => {
  const rt = setup();
  const mk = (name) => post(rt, "saveCategory", { type: "expense", name, icon: "🐶" }).data.id;
  const a = mk("Demo A"), b = mk("Demo B"), c = mk("Demo C");
  [a, b].forEach((id) => post(rt, "setCategoryHidden", { id, hidden: true }));
  const res = post(rt, "showCategories", { ids: [a, b, "ghost", a] }).data;
  assert.equal(res.shown, 2);
  const cats = rt.rows("Categories");
  assert.equal(cats.find((x) => x.id === a).hidden || "", "");
  assert.equal(cats.find((x) => x.id === b).hidden || "", "");
  assert.equal(cats.find((x) => x.id === c).hidden || "", "");
  assert.equal(post(rt, "showCategories", { ids: [] }).data.shown, 0);
});
