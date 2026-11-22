// QA round 2 (2026-11-03): safety nets and wording-support the testers asked for in the bulk Edit modes. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("Undo of a Travel move strips the Annual tag only from the entries that really went back", () => {
  const { rt, data } = freshApp({ entries: 20 });
  const cat = (name) => rt.api("saveCategory", { type: "expense", name, icon: "🐶" }).id;
  const a = cat("R2 A"), elsewhere = cat("R2 Elsewhere");
  const travel = rt.rows("Categories").find((x) => x.type === "expense" && x.key === "travel");
  const add = (id) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: a, description: id, paid_by: "me", status: "confirmed", source: "manual", payment_method_id: data.pms[3].id })});`);
  add("r2-1"); add("r2-2");
  const res = rt.api("setEntriesCategory", { ids: ["r2-1", "r2-2"], categories: { expense: travel.id } });
  assert.equal(res.annualIds.length, 2);
  // r2-2 is moved on elsewhere (another device) before the Undo; it keeps its Annual tag with it
  rt.api("setEntriesCategory", { ids: ["r2-2"], categories: { expense: elsewhere } });
  const undo = rt.api("undoSetEntriesCategory", { changes: res.changed, annualIds: res.annualIds });
  assert.deepEqual(undo.reverted, ["r2-1"]);
  const tagged = (id) => rt.rows("Entry Tags").some((t) => t.tag_id === "system-annual" && t.entry_id === id);
  assert.equal(tagged("r2-1"), false, "the reverted one lost the tag the move gave it");
  assert.equal(tagged("r2-2"), true, "the one moved on elsewhere keeps its tag");
});

test("bulk Discard keeps a safety copy: Undo (restore) brings the waiting entries back, still waiting", () => {
  const { rt, data } = freshApp({ entries: 10 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const setPending = (id) => rt.run(`(function(){ var s = getSheet('Entries'); var h = getHeaders(s); var r = findRowIndexById(s, h, ${JSON.stringify(id)}); setCellByRow_(s, h, r, 'status', 'pending'); if (ROWS_MEMO_) delete ROWS_MEMO_['Entries']; })()`);
  const mk = (d) => { const e = rt.api("createEntry", { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: cat.id, description: d, paid_by: "me", payment_method_id: pm }); setPending(e.id); return e.id; };
  const a = mk("R2 waiting A"), b = mk("R2 waiting B");
  const out = rt.api("discardEntries", { ids: [a, b] });
  assert.deepEqual(out.discarded.sort(), [a, b].sort());
  assert.ok(out.batch_id, "a safety batch id is answered");
  assert.ok(!rt.rows("Entries").some((e) => e.id === a || e.id === b));
  const listed = rt.api("listDeletedEntries", {}).batches.find((x) => x.batch_id === out.batch_id);
  assert.equal(listed.entries.length, 2);
  assert.equal(listed.entries[0].status, "pending", "the list can say they were waiting");
  const back = rt.api("restoreDeletedEntries", { batch_id: out.batch_id, ids: out.discarded });
  assert.equal(back.restored.length, 2);
  const e = rt.rows("Entries").find((x) => x.id === a);
  assert.equal(e.status, "pending", "back in Needs review");
  // nothing discarded: no batch
  assert.equal(rt.api("discardEntries", { ids: ["gone"] }).batch_id, undefined);
});

test("Recently deleted tells which entries were shared with a friend", () => {
  const { rt, data } = freshApp({ entries: 10 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense");
  const pal = rt.api("addFriend", { name: "R2 Pal" });
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 60, currency: "PEN", category_id: cat.id, description: "R2 shared", paid_by: "me", payment_method_id: pm });
  rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: pal.id, amount: 30 }] });
  const plain = rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: cat.id, description: "R2 plain", paid_by: "me", payment_method_id: pm });
  const out = rt.api("deleteEntries", { ids: [e.id, plain.id] });
  const rows = rt.api("listDeletedEntries", {}).batches.find((b) => b.batch_id === out.batch_id).entries;
  assert.equal(rows.find((r) => r.entry_id === e.id).shared, true);
  assert.equal(rows.find((r) => r.entry_id === plain.id).shared, false);
});

test("deleting a trip whose group friend still has a balance says which friend stayed", () => {
  const { rt } = freshApp({ entries: 10 });
  const trip = rt.api("addTrip", { name: "R2 Trip", start_date: "2026-10-01", end_date: "2026-10-05" });
  const friend = rt.run(`ensureTripGroupFriend_(getAllRows('Trips').find(function (t) { return t.id === ${JSON.stringify(trip.id)}; }))`);
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-10-02" });
  const free = rt.api("addTrip", { name: "R2 Free Trip", start_date: "2026-11-01", end_date: "2026-11-02" });
  const out = rt.api("deleteTrips", { ids: [trip.id, free.id] });
  assert.equal(out.deleted.length, 2);
  assert.equal(out.groupsKept.length, 1);
  assert.equal(out.groupsKept[0].trip, "R2 Trip");
  assert.ok(rt.rows("Friends").some((f) => f.id === friend.id), "the group friend stayed, as an ordinary friend");
});

test("previewBusinessDelete counts the expected payments and IGV records that would go", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.api("setBusinessFeatures", { on: true });
  const co = rt.api("addCompany", { name: "R2 Co" });
  const other = rt.api("addCompany", { name: "R2 Busy Co" });
  const p1 = rt.api("addProject", { company_id: co.id, name: "R2 P1" });
  const p2 = rt.api("addProject", { company_id: other.id, name: "R2 P2" });
  rt.api("addExpectedPayment", { project_id: p1.id, client: "C", amount: 500, currency: "PEN", due_date: "2026-11-30" });
  rt.api("addExpectedPayment", { project_id: p1.id, client: "C", amount: 120, currency: "USD", due_date: "2026-12-30" });
  rt.api("addExpectedPayment", { project_id: p2.id, client: "C", amount: 999, currency: "PEN", due_date: "2026-12-30" });
  rt.run(`appendRowObject('IGV Payments', { id: 'igv-1', company_id: ${JSON.stringify(co.id)}, date: '2026-10-05', amount: 99, currency: 'PEN', note: '' });`);
  rt.run(`appendRowObject('IGV Payments', { id: 'igv-2', company_id: ${JSON.stringify(other.id)}, date: '2026-10-05', amount: 11, currency: 'PEN', note: '' });`);
  const res = rt.api("previewBusinessDelete", { company_ids: [co.id, other.id], project_ids: [p1.id] });
  assert.equal(res.expected.count, 2);
  assert.deepEqual(res.expected.byCurrency, [{ currency: "PEN", amount: 500 }, { currency: "USD", amount: 120 }]);
  assert.equal(res.igv.count, 1, "only the company that would really go (R2 Busy Co keeps its project)");
  assert.deepEqual(rt.api("previewBusinessDelete", {}), { expected: { count: 0, byCurrency: [] }, igv: { count: 0 } });
});

test("adding a name that already exists keeps that friend's number (and says it was not a new person)", () => {
  const { rt } = freshApp({ entries: 5 });
  const ana = rt.api("addFriend", { name: "R2 Ana", phone: "+51 999 888 111" });
  const noPhone = rt.api("addFriend", { name: "R2 Ben" });
  const again = rt.api("addFriend", { name: "r2 ana", phone: "+51 999 000 222" });
  assert.equal(again.id, ana.id);
  assert.equal(again.existed, true);
  assert.equal(again.phoneKept, true, "the number it sent was not used");
  assert.equal(String(rt.rows("Friends").find((f) => f.id === ana.id).phone).replace(/\D/g, ""), "51999888111", "the old number is intact");
  // a friend with no number gets it filled in
  const filled = rt.api("addFriend", { name: "R2 Ben", phone: "+51 999 777 333" });
  assert.equal(filled.id, noPhone.id);
  assert.equal(filled.phoneKept, undefined);
  assert.equal(String(rt.rows("Friends").find((f) => f.id === noPhone.id).phone).replace(/\D/g, ""), "51999777333");
});
