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
  assert.deepEqual(m.payorMergeAsk, [{ payor_id: "p-ana", friend_id: friend.id, name: "Ana Test", incomes: 1, last_income: "2026-10-02", owed: {} }]);
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-ana").paid_by, "p-ana");
  post(rt, "applyPayorMerge", { separate: [] });
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-ana").paid_by, friend.id);
  assert.equal(rt.rows("Friends").filter((f) => String(f.name).toLowerCase() === "ana test").length, 1);
  assert.deepEqual(meta(rt).payorMergeAsk, []);
});

test("each shared name says how many incomes the payer has, the latest, and what the friend owes now per currency", () => {
  const rt = setup();
  const friend = post(rt, "addFriend", { name: "Eva Test" }).data;
  const acct = rt.rows("Payment Methods")[0].id;
  post(rt, "addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 45, currency: "PEN", date: "2026-10-21", payment_method_id: acct, description: "L1" });
  post(rt, "addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 10, currency: "USD", date: "2026-10-22", payment_method_id: acct, description: "L2" });
  addPayorRow(rt, "p-eva", "Eva Test");
  income(rt, "p-eva", "2026-09-01");
  income(rt, "p-eva", "2026-11-02");
  income(rt, "p-eva", "2026-11-05", { status: "pending" });   // waiting for review: not counted
  const ask = meta(rt).payorMergeAsk[0];
  assert.equal(ask.incomes, 2);
  assert.equal(ask.last_income, "2026-11-02");
  assert.deepEqual(ask.owed, { PEN: 45, USD: -10 });
});

test("a friend's copy with a shared name is asked too (since 1.76.1): the heal leaves it alone", () => {
  const rt = setup();
  rt.svc.props.set("FEATURES", "base");   // a friend's copy
  const friend = post(rt, "addFriend", { name: "Teo Test" }).data;
  addPayorRow(rt, "p-teo", "Teo Test");
  income(rt, "p-teo", "2026-10-02", { id: "inc-teo" });
  rt.run(`mergePayorsIfNothingShared_();`);
  assert.equal(rt.run(`payorsMerged_()`), false);
  assert.equal(meta(rt).payorMergeAsk.length, 1);
  post(rt, "applyPayorMerge", { separate: [] });
  assert.equal(rt.rows("Entries").find((e) => e.id === "inc-teo").paid_by, friend.id);
});

test("a friend's copy with no shared name is merged by the heal, quietly", () => {
  const rt = setup();
  rt.svc.props.set("FEATURES", "base");
  addPayorRow(rt, "p-boss", "Boss Test");
  income(rt, "p-boss", "2026-10-02");
  rt.run(`mergePayorsIfNothingShared_();`);
  assert.equal(rt.run(`payorsMerged_()`), true);
  assert.ok(rt.rows("Friends").some((f) => f.id === "p-boss"));
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
