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

test("deleting several friends at once removes the unused ones and reports the ones kept, without undoing the rest", () => {
  const rt = setup();
  assert.equal(rt.api("getMeta", {}).capabilities.friendsBulkDelete, true);
  const ana = rt.api("addFriend", { name: "Ana Test" });
  const a = rt.api("addFriend", { name: "Free One" });
  const b = rt.api("addFriend", { name: "Free Two" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-05" });
  const out = rt.api("deleteFriends", { ids: [a.id, ana.id, b.id, a.id, "ghost"] });
  assert.deepEqual(out.deleted.sort(), [a.id, b.id].sort());
  assert.deepEqual(out.kept.map((k) => [k.id, k.reason]).sort(), [[ana.id, "used"], ["ghost", "missing"]].sort());
  assert.equal(out.kept.find((k) => k.id === ana.id).name, "Ana Test");
  const left = rt.api("listMyFriends", {}).map((f) => f.id);
  assert.ok(left.includes(ana.id) && !left.includes(a.id) && !left.includes(b.id));
  assert.deepEqual(rt.api("deleteFriends", { ids: [] }), { deleted: [], kept: [] });
});
