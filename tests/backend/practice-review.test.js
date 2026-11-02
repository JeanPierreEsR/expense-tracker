// First-use practice "Needs review": createPracticePending / removePracticeReview and the guards that keep the practice entries from
// teaching or alerting anything. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, linkTelegram } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const cat = data.cats.find((c) => c.type === "expense");
  return { rt, data, cat };
}
const practiceRows = (rt) => rt.rows("Entries").filter((e) => e.source === "practice");

test("capability: a backend that can run the Needs review practice says so", () => {
  const { rt } = setup();
  assert.equal(rt.api("getMeta").capabilities.practiceReview, true);
});

test("createPracticePending makes two waiting expenses, English or Spanish, with no category, account or merchant", () => {
  const { rt } = setup();
  const en = rt.api("createPracticePending", { lang: "en" });
  const es = rt.api("createPracticePending", { lang: "es" });
  const byId = (id) => rt.rows("Entries").find((e) => e.id === id);
  assert.equal(byId(en.purchase_id).description, "Practice purchase");
  assert.equal(byId(en.charge_id).description, "Practice charge");
  assert.equal(byId(es.purchase_id).description, "Compra de práctica");
  assert.equal(byId(es.charge_id).description, "Cargo de práctica");
  for (const id of [en.purchase_id, en.charge_id]) {
    const e = byId(id);
    assert.equal(e.status, "pending");
    assert.equal(e.type, "expense");
    assert.equal(e.date, today());
    assert.equal(e.source, "practice");
    assert.equal(String(e.category_id || ""), "");
    assert.equal(String(e.payment_method_id || ""), "");
    assert.equal(String(e.merchant || ""), "");
  }
  const pending = rt.api("listPendingEntries", {});
  assert.ok(pending.some((e) => e.id === en.purchase_id) && pending.some((e) => e.id === en.charge_id));
});

test("creating, confirming and discarding the practice entries sends nothing to Telegram and raises no name question or trip suggestion", () => {
  const { rt, cat } = setup();
  linkTelegram(rt);
  rt.api("addTrip", { name: "Now trip", kind: "trip", start_date: today(), end_date: "2099-12-31" });
  const before = rt.svc.fetchLog.length;
  const made = rt.api("createPracticePending", { lang: "en" });
  const row = rt.api("listPendingEntries", {}).find((e) => e.id === made.purchase_id);
  assert.equal(row.suggested_trip_id, undefined, "a running trip must not be suggested (Confirm would link the practice to it)");
  assert.equal(row.maybe_own, undefined, "no 'Maybe yours?' name question");
  rt.api("updateEntry", { id: made.purchase_id, fields: { category_id: cat.id, description: "Practice purchase", amount: 38.5, trip_id: "" } });
  const res = rt.api("confirmEntry", { id: made.purchase_id });
  assert.equal(res.follow, undefined);
  rt.api("discardEntry", { id: made.charge_id });
  assert.equal(rt.svc.fetchLog.length, before, "no message left the backend");
  assert.equal(rt.rows("Entries").find((e) => e.id === made.purchase_id).status, "confirmed");
  assert.equal(rt.rows("Entries").some((e) => e.id === made.charge_id), false);
});

test("confirming a practice entry teaches nothing: no look-alike is filled, no merchant memory, no payee memory", () => {
  const { rt, cat } = setup();
  const made = rt.api("createPracticePending", { lang: "en" });
  // Even if the practice entry somehow carried a merchant, it must neither follow nor teach.
  rt.run(`updateRowFields_('Entries', ${JSON.stringify(made.purchase_id)}, { merchant: 'zz practice cafe' })`);
  const blanks = [1, 2, 3].map((i) => rt.api("createEntry", { type: "expense", date: today(), amount: 5 + i, currency: "PEN", category_id: "", description: "ZZ Practice Cafe", paid_by: "me" }));
  rt.run(`blanks_ = null;`);
  rt.api("updateEntry", { id: made.purchase_id, fields: { category_id: cat.id } });
  rt.api("confirmEntry", { id: made.purchase_id });
  const stillBlank = blanks.every((b) => String(rt.rows("Entries").find((e) => e.id === b.id).category_id || "") === "");
  assert.ok(stillBlank, "look-alike entries stay blank");
  assert.equal(rt.run(`categoryFollowAfterEdit_(${JSON.stringify(made.purchase_id)})`), null);
  assert.equal(rt.run(`buildGuessContext_().history['zz practice cafe'] === undefined`), true, "category guess memory untouched");
  assert.equal(rt.run(`Object.keys(buildPayeeHistory_()).indexOf('practice purchase') === -1`), true, "payee memory untouched");
  assert.deepEqual(rt.api("suggestForDescription", { description: "Practice purchase" }), {});
  const tidy = rt.api("listTidyGroups", {});
  assert.equal(JSON.stringify(tidy).indexOf("Practice purchase"), -1, "Tidy my history does not list the practice");
});

test("a practice entry never counts as a statement candidate or as an e-mail overlap", () => {
  const { rt } = setup();
  const made = rt.api("createPracticePending", { lang: "en" });
  const near = rt.api("getEntriesNear", { date: today(), kind: "expense", amount: 38.5, currency: "PEN", description: "x" });
  assert.equal(near.some((c) => c.id === made.purchase_id), false);
  assert.equal(rt.run(`Object.keys(buildEntryOverlapIndex_()).indexOf('PEN|38.50') === -1 || buildEntryOverlapIndex_()['PEN|38.50'].every(function (x) { return x.source !== 'practice'; })`), true);
});

test("removePracticeReview deletes waiting and confirmed practice entries (even renamed), and nothing else", () => {
  const { rt, cat } = setup();
  const a = rt.api("createPracticePending", { lang: "en" });
  const b = rt.api("createPracticePending", { lang: "es" });
  rt.api("updateEntry", { id: a.purchase_id, fields: { category_id: cat.id } });
  rt.api("confirmEntry", { id: a.purchase_id });
  rt.api("updateEntry", { id: b.charge_id, fields: { description: "renamed by the person" } });
  const real = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: cat.id, description: "Real lunch", paid_by: "me" });
  const old = rt.api("createEntry", { type: "expense", date: "2020-01-05", amount: 20, currency: "PEN", category_id: cat.id, description: "Practice purchase", paid_by: "me" });
  const waitingReal = rt.api("createEntry", { type: "expense", date: today(), amount: 9, currency: "PEN", category_id: cat.id, description: "Real waiting", paid_by: "me" });
  rt.run(`updateEntryFields(${JSON.stringify(waitingReal.id)}, { status: 'pending' })`);
  const before = rt.rows("Entries").length;
  const res = rt.api("removePracticeReview", { started_on: today() });
  assert.equal(res.entries, 4);
  assert.equal(rt.rows("Entries").length, before - 4);
  assert.equal(practiceRows(rt).length, 0);
  const ids = rt.rows("Entries").map((e) => e.id);
  assert.ok(ids.includes(real.id), "a real entry stays");
  assert.ok(ids.includes(old.id), "an entry with the name but dated before the practice started stays");
  assert.ok(ids.includes(waitingReal.id), "a real waiting entry stays");
  assert.equal(rt.api("removePracticeReview", { started_on: today() }).entries, 0, "a repeat is harmless");
});

test("the practice entries stay out of Telegram's twin warning of a real waiting entry", () => {
  const { rt } = setup();
  const made = rt.api("createPracticePending", { lang: "en" });
  const row = rt.api("listPendingEntries", {}).find((e) => e.id === made.purchase_id);
  assert.deepEqual(row.twins, [], "the purchase and the charge are different places and amounts");
});
