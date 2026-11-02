// Speed pass (2026-11-02): saveEntryAll does in ONE call what the phone used to send as 2-4 calls, with the same result; and a
// call that only looks (get…/list…) reads each sheet from Google once. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const uuid = () => "1234abcd-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
const bill = (friendId) => ({
  v: 1, total: "100", people: [friendId],
  items: [{ id: 1, name: "Ceviche", price: "100", people: ["me", friendId], discount: false }],
  adjs: [], tip: { type: "percent", percent: "", amount: "", mode: "proportional" }
});

function setup() {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Speed Pal " + Math.random().toString(36).slice(2, 7) });
  const cat = data.cats.find((c) => c.type === "expense");
  const tag = rt.rows("Tags")[0];
  const fields = { type: "expense", date: today(), amount: 100, currency: "PEN", category_id: cat.id, description: "Speed dinner", paid_by: "me", payment_method_id: data.pms[3].id };
  return { rt, data, friend, cat, tag, fields };
}
const loansOf = (rt, entryId) => rt.rows("Loans").filter((l) => l.source_entry_id === entryId || l.entry_id === entryId);
const splitsOf = (rt, entryId) => rt.rows("Entry Splits").filter((s) => s.entry_id === entryId).map((s) => [s.friend_id, Number(s.amount)]);

test("create in one call = createEntry + saveEntrySplits + saveEntryBill", () => {
  const { rt, friend, tag, fields } = setup();
  const id = uuid();
  const out = rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id, tag_ids: [tag.id] }), splits: [{ friend_id: friend.id, amount: 40 }], bill: bill(friend.id) });
  assert.equal(out.id, id);
  const one = { splits: splitsOf(rt, id), loans: loansOf(rt, id).length, bill: rt.api("getEntryBill", { entryId: id }).bill, tags: rt.api("getEntryTags", { entryId: id }) };

  const old = rt.api("createEntry", Object.assign({}, fields, { client_id: uuid(), tag_ids: [tag.id] }));
  rt.api("saveEntrySplits", { entryId: old.id, splits: [{ friend_id: friend.id, amount: 40 }] });
  rt.api("saveEntryBill", { entryId: old.id, bill: bill(friend.id) });
  const sep = { splits: splitsOf(rt, old.id), loans: loansOf(rt, old.id).length, bill: rt.api("getEntryBill", { entryId: old.id }).bill, tags: rt.api("getEntryTags", { entryId: old.id }) };

  assert.deepEqual(one, sep);
  assert.equal(one.splits.length, 1);
  assert.deepEqual(one.tags, [tag.id]);
});

test("a create sent twice (lost reply) makes one entry and one split", () => {
  const { rt, friend, fields } = setup();
  const id = uuid();
  const payload = { kind: "create", fields: Object.assign({}, fields, { client_id: id }), splits: [{ friend_id: friend.id, amount: 40 }] };
  rt.api("saveEntryAll", payload);
  rt.api("saveEntryAll", payload);
  assert.equal(rt.rows("Entries").filter((e) => e.id === id).length, 1);
  assert.equal(splitsOf(rt, id).length, 1);
});

test("update in one call changes the fields, the split and the tags", () => {
  const { rt, friend, tag, fields } = setup();
  const id = uuid();
  rt.api("saveEntryAll", { kind: "create", fields: Object.assign({}, fields, { client_id: id }) });
  rt.api("saveEntryAll", { kind: "update", id, fields: { description: "Renamed", amount: 80 }, splits: [{ friend_id: friend.id, amount: 30 }], tag_ids: [tag.id] });
  const e = rt.rows("Entries").find((x) => x.id === id);
  assert.equal(e.description, "Renamed");
  assert.equal(Number(e.amount), 80);
  assert.deepEqual(splitsOf(rt, id), [[friend.id, 30]]);
  assert.deepEqual(rt.api("getEntryTags", { entryId: id }), [tag.id]);
  // tags sent as [] clear them (as saveEntryTags did)
  rt.api("saveEntryAll", { kind: "update", id, fields: { description: "Again" }, tag_ids: [] });
  assert.deepEqual(rt.api("getEntryTags", { entryId: id }), []);
  assert.deepEqual(splitsOf(rt, id), [[friend.id, 30]], "no split sent = split left as it was");
});

test("confirm in one call confirms a waiting entry with its category", () => {
  const { rt, cat } = setup();
  const made = rt.api("createPracticePending", { lang: "en" });
  const out = rt.api("saveEntryAll", { kind: "confirm", id: made.purchase_id, fields: { category_id: cat.id } });
  assert.equal(out.done, true);
  const e = rt.rows("Entries").find((x) => x.id === made.purchase_id);
  assert.equal(e.status, "confirmed");
  assert.equal(e.category_id, cat.id);
});

test("the backend says it can do this (entrySaveOne), so the phone uses one call", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta", {}).capabilities.entrySaveOne, true);
});

test("a screen-loading call reads each sheet once", () => {
  const { rt } = setup();
  const proto = Object.getPrototypeOf(rt.sheet("Entries"));
  const orig = proto._read;
  const per = {};
  proto._read = function (...a) { per[this.name] = (per[this.name] || 0) + 1; return orig.apply(this, a); };
  try {
    for (const action of ["getHomeGlance", "listBudgets", "listLoanBalances"]) {
      for (const k in per) delete per[k];
      rt.api(action, {});
      for (const [sheet, n] of Object.entries(per)) assert.ok(n <= 2, `${action} read ${sheet} ${n} times`);
    }
  } finally { proto._read = orig; }
});

test("a read call still sees what it changed itself (a sheet opened for a change is read again)", () => {
  const { rt } = setup();
  const n = rt.run(`withRowsMemo_(function () {
    var before = getAllRows('Friends').length;
    appendRowObject('Friends', { id: 'memo-check', name: 'Memo Check' });
    var sheet = getSheet('Friends');
    sheet.getRange(sheet.getLastRow(), getHeaders(sheet).indexOf('name') + 1).setValue('Memo Check 2');
    var after = getAllRows('Friends');
    return [before, after.length, after[after.length - 1].name];
  })`);
  assert.equal(n[1], n[0] + 1);
  assert.equal(n[2], "Memo Check 2");
});
