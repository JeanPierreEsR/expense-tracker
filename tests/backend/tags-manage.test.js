// More → Categories & tags, the Tags part: counts per tag, rename, delete (the entries only lose the label),
// the built-in Annual tag protected, and Add reusing a tag of the same name.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));

function tagTwo(rt, tagId) {
  const ids = rt.rows("Entries").slice(0, 2).map((e) => e.id);
  const res = post(rt, "setEntriesTag", { ids, tag_id: tagId, mode: "add" });
  assert.ok(res.data, JSON.stringify(res));
  return ids;
}

test("counts, rename and delete of a tag; entries stay, only the label goes", () => {
  const { rt } = freshApp({ entries: 50 });
  const tag = post(rt, "addTag", { name: "Padel lessons" }).data;
  const ids = tagTwo(rt, tag.id);
  assert.equal(post(rt, "getTagCounts").data.counts[tag.id], 2);
  assert.ok(post(rt, "getMeta").data.capabilities.tagsManage);

  const ren = post(rt, "renameTag", { id: tag.id, name: "  Office   work " });
  assert.equal(ren.data && ren.data.name, "Office work", JSON.stringify(ren));
  assert.equal(rt.rows("Tags").find((t) => t.id === tag.id).name, "Office work");

  const before = rt.rows("Entries").length;
  const del = post(rt, "deleteTag", { id: tag.id });
  assert.equal(del.data && del.data.entries, 2, JSON.stringify(del));
  assert.ok(!rt.rows("Tags").some((t) => t.id === tag.id));
  assert.ok(!rt.rows("Entry Tags").some((r) => r.tag_id === tag.id));
  assert.equal(rt.rows("Entries").length, before, "no entry deleted");
  ids.forEach((id) => assert.ok(rt.rows("Entries").some((e) => e.id === id)));
});

test("a name already used is refused (any case, accents, Annual); Add reuses a tag of the same name", () => {
  const { rt } = freshApp({ entries: 50 });
  const a = post(rt, "addTag", { name: "Café" }).data;
  const b = post(rt, "addTag", { name: "Gym" }).data;
  assert.equal(post(rt, "addTag", { name: " cafe " }).data.id, a.id);
  assert.match(JSON.stringify(post(rt, "renameTag", { id: b.id, name: "CAFE" })), /already have a tag/);
  assert.match(JSON.stringify(post(rt, "renameTag", { id: b.id, name: "anual" })), /already have a tag/);
  assert.match(JSON.stringify(post(rt, "renameTag", { id: b.id, name: "Cafe" }, "es")), /Ya tienes una etiqueta/);
  assert.match(JSON.stringify(post(rt, "renameTag", { id: b.id, name: "  " })), /name/i);
});

test("the built-in Annual tag can be neither renamed nor deleted", () => {
  const { rt } = freshApp({ entries: 50 });
  post(rt, "getMeta");   // creates it
  assert.match(JSON.stringify(post(rt, "renameTag", { id: "system-annual", name: "Yearly" })), /built in/);
  assert.match(JSON.stringify(post(rt, "deleteTag", { id: "system-annual" })), /built in/);
  assert.ok(rt.rows("Tags").some((t) => t.id === "system-annual"));
});

test("tapping a tag lists exactly its confirmed entries, all dates (listEntries tagId, owner 2026-11-27)", () => {
  const { rt } = freshApp({ entries: 50 });
  const tag = post(rt, "addTag", { name: "Depa 101" }).data;
  const ids = tagTwo(rt, tag.id);
  assert.ok(post(rt, "getMeta").data.capabilities.tagEntries);
  const listed = post(rt, "listEntries", { tagId: tag.id }).data.map((e) => e.id).sort();
  assert.deepEqual(listed, ids.slice().sort());
  assert.deepEqual(post(rt, "listEntries", { tagId: "no-such-tag" }).data, []);
  // and the app opens that list from the tag's row, with rename / delete in its ⋯ menu
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(app, /if \(tagEntriesOn_\(\)\) row\.addEventListener\("click", \(\) => openTagDrilldown_\(t\)\);/);
  assert.match(app, /openDrilldownWithPayload_\(\{ tagId: t\.id \}, t\.name, tr\("tagsScreen\.allDates"\)\);/);
});

test("tag chips: at most three rows, the last chip 'More…' opens every tag; the same in the + form, Programmed items and Needs review (owner 2026-11-27)", () => {
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(app, /if \(rows\.length <= 3\) return;\n  chips\.forEach\(\(c, i\) => \{ if \(tops\[i\] > rows\[2\]\) c\.hidden = true; \}\);\n  more\.hidden = false;/);
  for (const box of ["tags-list", "recurring-tags-list", "review-tags-chips"]) {
    assert.match(app, new RegExp(`renderTagChips_\\(document\\.getElementById\\("${box}"\\), \\{`), box);
  }
  // measured against the box: a window that grows from the bottom moves while chips are hidden
  assert.match(app, /const topIn = \(el\) => Math\.round\(el\.getBoundingClientRect\(\)\.top - box\.getBoundingClientRect\(\)\.top\);/);
});

test("Edit mode deletes several tags in one call; Annual is never deleted; entries and Programmed items only lose the labels (owner 2026-11-27)", () => {
  const { rt } = freshApp({ entries: 50 });
  const a = post(rt, "addTag", { name: "Bulk A" }).data;
  const b = post(rt, "addTag", { name: "Bulk B" }).data;
  const keep = post(rt, "addTag", { name: "Bulk keep" }).data;
  const tagged = tagTwo(rt, a.id);
  tagTwo(rt, keep.id);
  const entriesBefore = rt.rows("Entries").length;
  assert.ok(post(rt, "getMeta").data.capabilities.tagsBulkDelete);
  const out = post(rt, "deleteTags", { ids: [a.id, b.id, "system-annual", "ghost"] }).data;
  assert.deepEqual([out.tags, out.entries], [2, 2]);
  const names = rt.rows("Tags").map((t) => t.name);
  assert.ok(!names.includes("Bulk A") && !names.includes("Bulk B") && names.includes("Bulk keep"));
  assert.ok(rt.rows("Tags").some((t) => t.id === "system-annual"), "the built-in Annual stays");
  assert.equal(rt.rows("Entries").length, entriesBefore, "entries stay");
  assert.ok(!rt.rows("Entry Tags").some((et) => et.tag_id === a.id));
  assert.ok(rt.rows("Entry Tags").some((et) => et.tag_id === keep.id), "other labels stay");
  assert.ok(tagged.length === 2);
  assert.ok(!post(rt, "deleteTags", { ids: ["system-annual"] }).ok, "nothing deletable: refused");
  const app = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  assert.match(app, /saveBehindScreen_\(\(\) => callApi\("deleteTags", \{ ids \}\)/);
});
