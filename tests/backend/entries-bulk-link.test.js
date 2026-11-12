// Home → Edit, stage 4 (owner's plan, 2026-11-03): link several entries to a trip or event, and add / remove a tag, each with an Undo. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  const pm = data.pms[3].id;
  const cat = data.cats.find((c) => c.type === "expense"), incomeCat = data.cats.find((c) => c.type === "income");
  const add = (id, extra) => rt.run(`appendRowObject('Entries', ${JSON.stringify(Object.assign({ id, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: cat.id, description: id, paid_by: "me", status: "confirmed", source: "manual", payment_method_id: pm }, extra))});`);
  const cusco = rt.api("addTrip", { name: "Cusco", kind: "trip", start_date: "2026-12-10", end_date: "2026-12-15" });
  const party = rt.api("addTrip", { name: "Party", kind: "event", start_date: "2026-12-20", end_date: "2026-12-20" });
  add("bl-e1", {}); add("bl-e2", {}); add("bl-e3", { trip_id: party.id }); add("bl-e4", { trip_id: cusco.id });
  add("bl-income", { type: "income", category_id: incomeCat.id }); add("bl-transfer", { type: "transfer", category_id: "" });
  const tag = rt.api("addTag", { name: "Bulk tag" });
  const tripOf = (id) => String(rt.rows("Entries").find((e) => e.id === id).trip_id || "");
  const tagged = (id, t = tag.id) => rt.rows("Entry Tags").some((r) => r.entry_id === id && r.tag_id === t);
  return { rt, cusco, party, tag, tripOf, tagged };
}

test("the backend says it can link trips and tags in bulk", () => {
  assert.equal(freshApp({ entries: 5 }).rt.api("getMeta", {}).capabilities.entriesBulkLink, true);
});

test("expenses are linked to the chosen trip; income, transfers, entries already there and unknown ids are kept with the reason; others in another trip are moved", () => {
  const { rt, cusco, tripOf } = setup();
  const res = rt.api("setEntriesTrip", { ids: ["bl-e1", "bl-e2", "bl-e3", "bl-e4", "bl-income", "bl-transfer", "gone-1", "bl-e1"], trip_id: cusco.id });
  assert.deepEqual(res.changed.map((c) => c.id).sort(), ["bl-e1", "bl-e2", "bl-e3"], "a repeated id counts once");
  assert.equal(res.changed.find((c) => c.id === "bl-e3").from.length > 0, true, "it was in another trip and is moved");
  assert.deepEqual(Object.fromEntries(res.kept.map((k) => [k.id, k.reason])), { "bl-e4": "same", "bl-income": "type", "bl-transfer": "type", "gone-1": "missing" });
  ["bl-e1", "bl-e2", "bl-e3", "bl-e4"].forEach((id) => assert.equal(tripOf(id), cusco.id, id));
  assert.equal(tripOf("bl-income"), "", "an income entry never belongs to a trip");
});

test("an empty trip_id takes entries out of their trip; an unknown trip is refused", () => {
  const { rt, tripOf } = setup();
  const res = rt.api("setEntriesTrip", { ids: ["bl-e3", "bl-e4", "bl-e1"], trip_id: "" });
  assert.deepEqual(res.changed.map((c) => c.id).sort(), ["bl-e3", "bl-e4"]);
  assert.equal(res.kept.find((k) => k.id === "bl-e1").reason, "same", "it had no trip");
  assert.equal(tripOf("bl-e3"), "");
  assert.throws(() => rt.api("setEntriesTrip", { ids: ["bl-e1"], trip_id: "no-such-trip" }), /Trip|trip|not found/);
});

test("Undo puts each entry back in its OWN old trip and never overwrites a later change; other phones see the change", () => {
  const { rt, cusco, party, tripOf } = setup();
  const first = rt.api("syncEntrySearchIndex", {});
  const res = rt.api("setEntriesTrip", { ids: ["bl-e1", "bl-e3", "bl-e4"], trip_id: cusco.id });
  const delta = rt.api("syncEntrySearchIndex", { since: first.syncedAt, structureVersion: first.structureVersion, entriesVersion: first.entriesVersion });
  assert.ok(delta.changed.some((r) => r.id === "bl-e1" && r.trip_id === cusco.id), "the next sync carries the new trip");
  rt.api("setEntriesTrip", { ids: ["bl-e4"], trip_id: party.id });   // moved again meanwhile
  const undo = rt.api("undoSetEntriesTrip", { changes: res.changed });
  assert.deepEqual(undo.reverted.sort(), ["bl-e1", "bl-e3"]);
  assert.equal(tripOf("bl-e1"), "");
  assert.equal(tripOf("bl-e3"), party.id, "back in ITS OWN old trip");
  assert.equal(tripOf("bl-e4"), party.id, "a later change is kept");
});

test("a tag is added to any type of entry once, removed again, and the app is told what really changed", () => {
  const { rt, tag, tagged } = setup();
  rt.api("saveEntryTags", { entryId: "bl-e2", tagIds: [tag.id] });
  const add = rt.api("setEntriesTag", { ids: ["bl-e1", "bl-e2", "bl-income", "bl-transfer", "gone-1"], tag_id: tag.id, mode: "add" });
  assert.deepEqual(add.changed.sort(), ["bl-e1", "bl-income", "bl-transfer"]);
  assert.deepEqual(Object.fromEntries(add.kept.map((k) => [k.id, k.reason])), { "bl-e2": "same", "gone-1": "missing" });
  ["bl-e1", "bl-e2", "bl-income", "bl-transfer"].forEach((id) => assert.ok(tagged(id), id));
  assert.equal(rt.rows("Entry Tags").filter((r) => r.entry_id === "bl-e2" && r.tag_id === tag.id).length, 1, "no duplicate row");
  const remove = rt.api("setEntriesTag", { ids: ["bl-e1", "bl-e2", "bl-e3"], tag_id: tag.id, mode: "remove" });
  assert.deepEqual(remove.changed.sort(), ["bl-e1", "bl-e2"]);
  assert.equal(remove.kept.find((k) => k.id === "bl-e3").reason, "same", "it did not have the tag");
  assert.ok(!tagged("bl-e1") && !tagged("bl-e2") && tagged("bl-income"));
  assert.throws(() => rt.api("setEntriesTag", { ids: ["bl-e1"], tag_id: "no-such-tag", mode: "add" }), /tag/i);
});

test("tag Undo reverses exactly what changed (an add is removed, a removal is put back)", () => {
  const { rt, tag, tagged } = setup();
  rt.api("saveEntryTags", { entryId: "bl-e2", tagIds: [tag.id] });
  const add = rt.api("setEntriesTag", { ids: ["bl-e1", "bl-e2"], tag_id: tag.id, mode: "add" });   // only e1 changes
  rt.api("undoSetEntriesTag", { ids: add.changed, tag_id: tag.id, mode: "add" });
  assert.ok(!tagged("bl-e1"), "the one that was added is removed");
  assert.ok(tagged("bl-e2"), "the one that already had it keeps it");
  const remove = rt.api("setEntriesTag", { ids: ["bl-e2"], tag_id: tag.id, mode: "remove" });
  rt.api("undoSetEntriesTag", { ids: remove.changed, tag_id: tag.id, mode: "remove" });
  assert.ok(tagged("bl-e2"), "the removal is undone");
});

test("the screen: one Change button with Category, Trip or event and Tag, the three sheets, an Undo for each, both languages", () => {
  const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
  const html = docs("index.html"), app = docs("app.js"), strings = docs("strings.js");
  assert.match(html, /id="entries-change-selected-btn"/);
  assert.match(app, /callApi\("setEntriesTrip", entriesListThen_\(\{ ids: sendIds, trip_id: tripId \}\)\)/);
  assert.match(app, /callApi\("undoSetEntriesTrip"/);
  assert.match(app, /callApi\("setEntriesTag", entriesListThen_\(\{ ids: sendIds, tag_id: tagId, mode \}\)\)/);
  assert.match(app, /callApi\("undoSetEntriesTag"/);
  assert.match(app, /busy: "entriesBulk\.linking"/);
  for (const key of ["entriesBulk.changeN", "entriesBulk.change", "entriesBulk.changeTitle", "entriesBulk.menuCategory", "entriesBulk.menuTrip", "entriesBulk.menuTag", "entriesBulk.tripTitle", "entriesBulk.tripPick",
    "entriesBulk.tripNone", "entriesBulk.tripMoveNote", "entriesBulk.tripLeftOut", "entriesBulk.tripNothingEligible", "entriesBulk.tripGo", "entriesBulk.tripDone", "entriesBulk.tripRemoved",
    "entriesBulk.tagTitle", "entriesBulk.tagPick", "entriesBulk.tagNone", "entriesBulk.tagGoAdd", "entriesBulk.tagGoRemove", "entriesBulk.tagDoneAdd", "entriesBulk.tagDoneRemove", "entriesBulk.tagNoChange",
    "entriesBulk.linking", "entriesBulk.linkUndoHint"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: .+, es: .+ \\}`), key);
  }
});
