// My profile → What fits me (owner's design, 2026-11-04): the card is closed by default with a count, a saved pick shows as clicked only while its
// category still exists (hidden or deleted = not clicked), and tapping it again + "Add categories" brings its category back. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp } = require("./helpers");

const DOCS = path.join(__dirname, "../../docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const css = fs.readFileSync(path.join(DOCS, "style.css"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));

const catByName = (rt, name) => rt.rows("Categories").find((c) => c.name === name);
const active = (rt) => rt.api("getProfileState", {}).active;

test("capability: a backend that knows which picks are still active says so", () => {
  assert.equal(freshApp({ small: true }).rt.api("getMeta").capabilities.profileState, true);
});

test("a saved pick is active while its category exists, and stops being active when the category is hidden or deleted", () => {
  const { rt } = freshApp({ small: true });
  rt.api("applyProfile", { answers: ["kids", "pets", "hobbies"] });
  assert.deepEqual(active(rt), ["kids", "pets", "hobbies"]);
  rt.api("setCategoryHidden", { id: catByName(rt, "Kids").id, hidden: true });
  assert.deepEqual(active(rt), ["pets", "hobbies"], "hidden: not clicked any more");
  rt.api("deleteCategory", { id: catByName(rt, "Pets").id });
  assert.ok(!catByName(rt, "Pets"), "the category is really gone");
  assert.deepEqual(active(rt), ["hobbies"], "deleted: not clicked any more");
});

test("only what the person picked is active, even if another category with that name exists", () => {
  const { rt } = freshApp({ small: true });
  rt.api("applyProfile", { answers: ["kids"] });
  rt.run(`appendRowObject('Categories', ${JSON.stringify({ id: "own-pets", name: "Pets", type: "expense", icon: "🐾", color: "#888", key: "", hidden: "" })})`);
  assert.deepEqual(active(rt), ["kids"]);
});

test("a pick covered by an older similar category stays active while that one is visible", () => {
  const { rt } = freshApp({ small: true });
  const car = rt.rows("Categories").find((c) => c.type === "expense" && c.key === "car");   // the test data's own "Car" covers "Vehicle"
  assert.ok(car);
  const res = rt.api("applyProfile", { answers: ["car"] });
  assert.equal(res.added.length, 0, "Car already covers Vehicle");
  assert.deepEqual(active(rt), ["car"]);
  rt.api("setCategoryHidden", { id: car.id, hidden: true });
  assert.deepEqual(active(rt), []);
  const again = rt.api("applyProfile", { answers: ["car"] });
  assert.equal(again.added.length, 0, "the hidden Car comes back; no second category is made");
  assert.equal(again.restored.length, 1);
  assert.equal(String(rt.rows("Categories").find((c) => c.id === car.id).hidden || ""), "");
  assert.deepEqual(active(rt), ["car"]);
});

test("picking it again brings the category back: a hidden one is shown again, a deleted one is made again", () => {
  const { rt } = freshApp({ small: true });
  rt.api("applyProfile", { answers: ["kids", "pets"] });
  const kidsId = catByName(rt, "Kids").id;
  rt.api("setCategoryHidden", { id: kidsId, hidden: true });
  rt.api("deleteCategory", { id: catByName(rt, "Pets").id });
  const res = rt.api("applyProfile", { answers: ["kids", "pets"] });
  assert.deepEqual(res.restored.map((c) => c.name), ["Kids"]);
  assert.deepEqual(res.added.map((c) => c.name), ["Pets"]);
  assert.equal(catByName(rt, "Kids").id, kidsId, "the same Kids category (its history is still on it)");
  assert.equal(String(catByName(rt, "Kids").hidden || ""), "");
  assert.ok(catByName(rt, "Pets"));
  assert.deepEqual(active(rt), ["kids", "pets"]);
  assert.equal(rt.rows("Categories").filter((c) => c.name === "Kids").length, 1);
  const third = rt.api("applyProfile", { answers: ["kids", "pets"] });
  assert.equal(third.added.length + third.restored.length, 0, "a repeat changes nothing");
});

test("un-picking removes it from the saved picks; the starter basics a person hid are still never re-added", () => {
  const { rt } = freshApp({ small: true });
  rt.api("applyProfile", { answers: ["kids", "pets"] });
  rt.api("applyProfile", { answers: ["pets"] });
  assert.deepEqual(active(rt), ["pets"]);
  assert.ok(catByName(rt, "Kids"), "un-picking deletes nothing");
  const groceries = rt.rows("Categories").find((c) => c.type === "expense" && c.key === "groceries");
  if (groceries) {
    rt.api("setCategoryHidden", { id: groceries.id, hidden: true });
    rt.api("applyProfile", { answers: ["pets"], basics: true });
    assert.equal(rt.rows("Categories").find((c) => c.id === groceries.id).hidden, "yes", "a hidden basic stays hidden");
  }
});

test("the screen: closed row with a count, compact chips, state asked from the server, welcome unchanged", () => {
  const card = html.slice(html.indexOf('id="my-profile-fits-card"'), html.indexOf('id="my-profile-dates-card"'));
  assert.match(card, /id="fits-toggle"[^>]*aria-expanded="false"/);
  assert.match(card, /id="fits-count"/);
  assert.match(card, /id="fits-body" hidden/);
  for (const id of ["fits-chips", "fits-msg", "fits-add-btn"]) assert.ok(card.slice(card.indexOf('id="fits-body"')).includes(`id="${id}"`), id + " is inside the closed part");
  const open = app.slice(app.indexOf("async function showMyProfileScreen"), app.indexOf("function drawProfileDates_"));
  assert.match(open, /fitsOpen_\(false\)/, "closed every time the screen opens");
  assert.match(open, /callApi\("getProfileState"/);
  assert.match(open, /caps\.profileState/, "an older backend keeps the saved picks as they are");
  assert.match(app, /fillFitsChips_\(fitsEl_\("fits-chips"\), fitsSel_, [^\n]*, true\)/, "My profile uses the compact chips");
  assert.match(app, /fillFitsChips_\(welcomeEl_\("wf-chips"\), welcome_\.fits, [^\n]*\);/, "the welcome keeps the full-width bars (no compact flag)");
  assert.match(app, /res\.added\.length \+ \(res\.restored \|\| \[\]\)\.length/, "a restored category counts as added");
  assert.match(css, /\.welcome-choices\.fits-compact \{ flex-direction: row; flex-wrap: wrap;/);
});

test("the new texts exist in both languages and the intro now says a hidden or deleted pick gets its category back", () => {
  for (const k of ["prof.fitsNone", "prof.fitsPicked", "fits.intro"]) assert.ok(STRINGS[k], k);
  assert.ok(STRINGS["prof.fitsNone"].en && STRINGS["prof.fitsNone"].es);
  assert.match(STRINGS["prof.fitsPicked"].en.other, /\{n\}/);
  assert.match(STRINGS["prof.fitsPicked"].es.one, /elegida/);
  assert.match(STRINGS["fits.intro"].en, /hid or deleted/);
  assert.match(STRINGS["fits.intro"].es, /ocultaste o borraste/);
});
