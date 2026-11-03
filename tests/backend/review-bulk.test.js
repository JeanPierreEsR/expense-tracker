// Home → Needs review → Edit (owner's request 2026-11-03): confirm or discard several waiting entries at once, by the single Confirm / Discard's rules. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-r', name: 'Review test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  const add = (id, extra) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date: "2026-10-05", amount: 25, currency: "PEN", category_id: "cat-r", description: id, paid_by: "me", status: "pending", source: "email", payment_method_id: data.pms[0].id }, extra))});`);
  add("rv-ready1", {}); add("rv-ready2", {});
  add("rv-nocat", { category_id: "" });
  add("rv-zero", { amount: 0 });
  add("rv-invest-noplatform", { type: "investment", category_id: "", to_payment_method_id: "" });
  add("rv-confirmed", { status: "confirmed" });
  return { rt, data, add };
}
const status = (rt, id) => { const e = rt.rows("Entries").find((x) => x.id === id); return e ? e.status : null; };

test("the backend says it can confirm and discard waiting entries in bulk", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.reviewBulk, true);
});

test("confirmEntries confirms only entries that are pending and ready, and says why the others stay", () => {
  const { rt } = setup();
  const out = rt.api("confirmEntries", { items: [{ id: "rv-ready1" }, { id: "rv-ready2" }, { id: "rv-nocat" }, { id: "rv-zero" }, { id: "rv-invest-noplatform" }, { id: "rv-confirmed" }, { id: "gone-1" }, { id: "rv-ready1" }] });
  assert.deepEqual(out.confirmed.sort(), ["rv-ready1", "rv-ready2"], "a repeated id counts once");
  const why = Object.fromEntries(out.kept.map((k) => [k.id, k.reason]));
  assert.deepEqual(why, { "rv-nocat": "needsCategory", "rv-zero": "badAmount", "rv-invest-noplatform": "needsPlatform", "rv-confirmed": "notPending", "gone-1": "missing" });
  assert.equal(status(rt, "rv-ready1"), "confirmed");
  assert.equal(status(rt, "rv-nocat"), "pending", "left in the queue");
});

test("a confirmed expense gets its (empty) split row like the single Confirm, and the suggested trip is linked only now", () => {
  const { rt, add } = setup();
  const trip = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-10-01", end_date: "2026-10-09" });
  add("rv-trip", {});
  const out = rt.api("confirmEntries", { items: [{ id: "rv-trip", trip_id: trip.id }, { id: "rv-ready1", trip_id: "" }] });
  assert.equal(out.confirmed.length, 2);
  assert.equal(rt.rows("Entries").find((e) => e.id === "rv-trip").trip_id, trip.id);
  assert.equal(rt.rows("Entries").find((e) => e.id === "rv-ready1").trip_id, "");
});

test("discardEntries removes pending entries only, and never one that is part of a repayment", () => {
  const { rt, data } = setup();
  const friend = rt.api("addFriend", { name: "Review Friend" });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  // 130 arrives for a 100 debt: the extra 30 waits in Needs review with no category (a repayment's extra)
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id });
  const extraId = rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0].gap.entry_id;
  assert.equal(rt.rows("Entries").find((e) => e.id === extraId).status, "pending", "the extra is waiting in Needs review");
  const entriesBefore = rt.rows("Entries").length;
  const out = rt.api("discardEntries", { ids: ["rv-ready1", "rv-nocat", "rv-confirmed", extraId, "gone-2", "rv-ready1"] });
  assert.deepEqual(out.discarded.sort(), ["rv-nocat", "rv-ready1"]);
  const why = Object.fromEntries(out.kept.map((k) => [k.id, k.reason]));
  assert.equal(why["rv-confirmed"], "notPending", "a confirmed entry is not discarded from Needs review");
  assert.equal(why[extraId], "repayment");
  assert.equal(why["gone-2"], "missing");
  assert.equal(rt.rows("Entries").length, entriesBefore - 2);
  assert.ok(rt.rows("Entries").some((e) => e.id === extraId), "the repayment's extra is untouched");
});

test("an empty list does nothing", () => {
  const { rt } = setup();
  assert.deepEqual(rt.api("confirmEntries", { items: [] }), { confirmed: [], kept: [] });
  assert.deepEqual(rt.api("discardEntries", {}), { discarded: [], kept: [] });
});

test("the screen: a pencil on the card, tick rows, a fixed bar with Confirm and Discard, one question each, names in the result, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  for (const id of ["review-edit-btn", "review-editbar", "review-done-btn", "review-confirm-selected-btn", "review-discard-selected-btn"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(app, /callApi\("confirmEntries", \{ items \}\)/);
  assert.match(app, /callApi\("discardEntries", \{ ids \}\)/);
  assert.match(app, /busy: "reviewBulk\.confirming"/);
  assert.match(app, /busy: "reviewBulk\.discarding"/);
  assert.match(app, /name !== "entries" && reviewEditing_/, "leaving Home ends Edit mode");
  assert.match(app, /isPracticeReviewEntry_\(entry\)/, "the first-use practice's own entries are not ticked");
  for (const key of ["reviewBulk.confirmAsk", "reviewBulk.noneReady", "reviewBulk.leftNote", "reviewBulk.discardAsk", "reviewBulk.repaymentNote", "reviewBulk.confirming", "reviewBulk.discarding",
    "reviewBulk.doneConfirmed", "reviewBulk.doneDiscarded", "reviewBulk.resultKept", "reviewBulk.why.needsCategory", "reviewBulk.why.duplicate", "reviewBulk.why.repayment", "reviewBulk.why.notPending"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: .+, es: .+ \\}`), key);   // (some keys have singular / plural forms)
  }
});
