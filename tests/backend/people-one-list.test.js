// Payors and friends become one list of people (2026-11-09). Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
const meta = (rt) => post(rt, "getMeta").data;
const addPayorRow = (rt, id, name) => rt.run(`appendRowObject('Payors', { id: '${id}', name: '${name}', notes: '' }); bumpStructureVersion_();`);
const income = (rt, paid_by, date, extra = {}) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id: "i-" + Math.random(), type: "income", date, amount: 10, currency: "PEN", category_id: "", description: "Work", payment_method_id: "", paid_by, status: "confirmed", source: "manual" }, extra))}); bumpVersion_('ENTRIES_VERSION');`);
const setup = () => freshApp({ entries: 10 }).rt;

test("no shared names: the owner's copy merges by itself, payers keep their ids and past income its payer", () => {
  const rt = setup();
  addPayorRow(rt, "p-employer", "Employer Test");
  income(rt, "p-employer", "2026-10-01");
  const m = meta(rt);
  assert.deepEqual(m.payorMergeAsk, []);
  assert.ok(rt.rows("Friends").some((f) => f.id === "p-employer" && f.name === "Employer Test"));
  assert.ok(meta(rt).payors.some((p) => p.id === "p-employer"));
  assert.ok(meta(rt).friends.some((f) => f.id === "p-employer"));
  assert.ok(rt.rows("Payors").length > 0, "the old tab stays");
});

test("a shared name is asked first on the owner's copy, and nothing moves until answered", () => {
  const rt = setup();
  const friend = post(rt, "addFriend", { name: "Ana Test" }).data;
  addPayorRow(rt, "p-ana", "ana test");
  income(rt, "p-ana", "2026-10-02", { id: "inc-ana" });
  const m = meta(rt);
  assert.deepEqual(m.payorMergeAsk, [{ payor_id: "p-ana", friend_id: friend.id, name: "Ana Test" }]);
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-ana").paid_by, "p-ana");
  post(rt, "applyPayorMerge", { separate: [] });
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-ana").paid_by, friend.id);
  assert.equal(rt.rows("Friends").filter((f) => String(f.name).toLowerCase() === "ana test").length, 1);
  assert.deepEqual(meta(rt).payorMergeAsk, []);
});

test("same name but a different person stays apart, with a marked name", () => {
  const rt = setup();
  post(rt, "addFriend", { name: "Luis Test" });
  addPayorRow(rt, "p-luis", "Luis Test");
  income(rt, "p-luis", "2026-10-02", { id: "inc-luis" });
  meta(rt);
  post(rt, "applyPayorMerge", { separate: ["p-luis"] });
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-luis").paid_by, "p-luis");
  assert.equal(rt.rows("Friends").find((f) => f.id === "p-luis").name, "Luis Test (payer)");
});

test("running the merge twice changes nothing the second time", () => {
  const rt = setup();
  post(rt, "addFriend", { name: "Sol Test" });
  addPayorRow(rt, "p-sol", "Sol Test");
  addPayorRow(rt, "p-new", "New Test");
  rt.run(`mergePayorsIntoFriends_({});`);
  const before = rt.rows("Friends").length;
  rt.run(`mergePayorsIntoFriends_({});`);
  assert.equal(rt.rows("Friends").length, before);
});

test("the unused starter example is not carried over; if it was used it is", () => {
  const rt = setup();
  addPayorRow(rt, "p-seed", "Acme Corp");
  meta(rt);
  assert.ok(!rt.rows("Friends").some((f) => f.name === "Acme Corp"));
  const rt2 = setup();
  addPayorRow(rt2, "p-seed", "Acme Corp");
  income(rt2, "p-seed", "2026-10-01");
  meta(rt2);
  assert.ok(rt2.rows("Friends").some((f) => f.id === "p-seed"));
});

test("last_income counts only real income: a repayment's extra and entries waiting for review do not", () => {
  const rt = setup();
  meta(rt);
  const a = post(rt, "addPayor", { name: "Recent Test" }).data;
  const b = post(rt, "addPayor", { name: "Older Test" }).data;
  income(rt, a.id, "2026-10-20");
  income(rt, b.id, "2026-09-01");
  income(rt, b.id, "2026-11-01", { description: "Overpayment from Older Test's loan repayment" });
  income(rt, b.id, "2026-11-02", { status: "pending" });
  const m = meta(rt);
  assert.equal(m.payors.find((p) => p.id === a.id).last_income, "2026-10-20");
  assert.equal(m.payors.find((p) => p.id === b.id).last_income, "2026-09-01");
});

test("after the merge addPayor is addFriend (no second person), and someone with income cannot be deleted away", () => {
  const rt = setup();
  meta(rt);
  const f = post(rt, "addFriend", { name: "Same Test" }).data;
  const p = post(rt, "addPayor", { name: "same test" }).data;
  assert.equal(p.id, f.id);
  income(rt, f.id, "2026-10-01");
  assert.equal(post(rt, "deleteFriend", { id: f.id }).ok, false);
  const out = post(rt, "deleteFriends", { ids: [f.id] }).data;
  assert.deepEqual(out.deleted, []);
  assert.equal(out.hidden.length, 1);
});
