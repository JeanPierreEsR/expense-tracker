// More → Friends: a plain friend can be listed, renamed and deleted in ANY copy (Business pack off). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const setup = () => freshApp({ entries: 30 }).rt;

test("the backend says it can edit friends", () => {
  assert.equal(setup().api("getMeta", {}).capabilities.friendsEdit, true);
});

test("a plain friend is renamed in a personal copy; names stay unique; a business role is still refused", () => {
  const rt = setup();
  const ana = rt.api("addFriend", { name: "Ana Test" });
  const ben = rt.api("addFriend", { name: "Ben Test" });
  assert.equal(rt.api("updateFriend", { id: ana.id, name: "Ana Torres" }).name, "Ana Torres");
  assert.ok(rt.rows("Friends").some((f) => f.id === ana.id && f.name === "Ana Torres"));
  assert.ok(!rt.run(`getHeaders(getSheet('Friends'))`).includes("role"), "no business column was created");
  assert.throws(() => rt.api("updateFriend", { id: ben.id, name: "ana torres" }), /already have a person/i);
  assert.throws(() => rt.api("updateFriend", { id: ben.id, name: "  " }), /name/i);
  assert.throws(() => rt.api("updateFriend", { id: ben.id, name: "Ben", role: "client" }), /turned off/i);
});

test("listMyFriends shows each friend with what is owed per currency, in every copy", () => {
  const rt = setup();
  const ana = rt.api("addFriend", { name: "Ana Test" });
  const ben = rt.api("addFriend", { name: "Ben Test" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 80, currency: "PEN", date: "2026-10-05" });
  rt.api("addLoan", { friend_id: ana.id, direction: "i_owe_them", amount: 10, currency: "USD", date: "2026-10-05" });
  const list = rt.api("listMyFriends", {});
  const a = list.find((f) => f.id === ana.id), b = list.find((f) => f.id === ben.id);
  assert.deepEqual(a.totals.map((t) => [t.currency, t.net]).sort(), [["PEN", 80], ["USD", -10]]);
  assert.deepEqual(b.totals, []);
});

test("a friend with debts or shared expenses cannot be deleted; an unused one can", () => {
  const rt = setup();
  const ana = rt.api("addFriend", { name: "Ana Test" });
  const free = rt.api("addFriend", { name: "Free Test" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-05" });
  assert.throws(() => rt.api("deleteFriend", { id: ana.id }), /still has debts/i);
  assert.deepEqual(rt.api("deleteFriend", { id: free.id }), { done: true });
  assert.ok(!rt.api("listMyFriends", {}).some((f) => f.id === free.id));
  assert.throws(() => rt.api("deleteFriend", { id: "ghost" }), /not found|No se encontr/i);
});

test("Delete on several friends: unused ones are deleted, ones with history are hidden, ones with money still owed are kept", () => {
  const rt = setup();
  assert.equal(rt.api("getMeta", {}).capabilities.friendsBulkDelete, true);
  const owing = rt.api("addFriend", { name: "Owing Test" });
  const history = rt.api("addFriend", { name: "History Test" });
  const a = rt.api("addFriend", { name: "Free One" });
  const b = rt.api("addFriend", { name: "Free Two" });
  rt.api("addLoan", { friend_id: owing.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-05" });
  // History but nothing owed: a loan that was fully repaid.
  const loan = rt.api("addLoan", { friend_id: history.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-05" });
  rt.api("recordRepayment", { friend_id: history.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-06", payment_method_id: rt.rows("Payment Methods")[0].id });
  assert.equal(rt.api("listMyFriends", {}).find((f) => f.id === history.id).totals.length, 0, "history friend owes nothing");
  const out = rt.api("deleteFriends", { ids: [a.id, owing.id, b.id, a.id, history.id, "ghost"] });
  assert.deepEqual(out.deleted.sort(), [a.id, b.id].sort());
  assert.deepEqual(out.hidden, [{ id: history.id, name: "History Test" }]);
  assert.deepEqual(out.kept.map((k) => [k.id, k.reason]).sort(), [[owing.id, "balance"], ["ghost", "missing"]].sort());
  const list = rt.api("listMyFriends", {});
  assert.ok(!list.some((f) => f.id === a.id || f.id === b.id), "unused ones are gone");
  assert.equal(list.find((f) => f.id === history.id).hidden, true);
  assert.equal(list.find((f) => f.id === owing.id).hidden, false);
  assert.ok(rt.rows("Loans").some((l) => l.id === loan.id), "the history is untouched");
  assert.equal(rt.api("getMeta", {}).friends.find((f) => f.id === history.id).hidden, "yes", "the app still gets the name (old entries show it) but flagged hidden");
  assert.deepEqual(rt.api("deleteFriends", { ids: [] }), { deleted: [], deletedRows: [], hidden: [], kept: [] });
});

test("adding a friend whose name is hidden brings the hidden one back; Unhide does the same; renaming onto a hidden name says so", () => {
  const rt = setup();
  const ana = rt.api("addFriend", { name: "Ana Hidden" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-05" });
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 20, currency: "PEN", date: "2026-10-06", payment_method_id: rt.rows("Payment Methods")[0].id });
  assert.equal(rt.api("deleteFriends", { ids: [ana.id] }).hidden.length, 1);
  const again = rt.api("addFriend", { name: "ana hidden" });
  assert.equal(again.id, ana.id, "no second person");
  assert.equal(again.unhidden, true);
  assert.equal(rt.api("listMyFriends", {}).filter((f) => /ana hidden/i.test(f.name)).length, 1);
  assert.equal(rt.api("listMyFriends", {}).find((f) => f.id === ana.id).hidden, false);
  rt.api("deleteFriends", { ids: [ana.id] });
  assert.deepEqual(rt.api("unhideFriend", { id: ana.id }), { id: ana.id, hidden: false });
  assert.equal(rt.api("listMyFriends", {}).find((f) => f.id === ana.id).hidden, false);
  assert.throws(() => rt.api("unhideFriend", { id: "ghost" }), /not found|No se encontr/i);
  rt.api("deleteFriends", { ids: [ana.id] });
  const ben = rt.api("addFriend", { name: "Ben Plain" });
  assert.throws(() => rt.api("updateFriend", { id: ben.id, name: "Ana Hidden" }), /hidden|oculto/i);
});
