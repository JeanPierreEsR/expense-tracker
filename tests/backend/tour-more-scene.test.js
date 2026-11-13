// The tour's animated More tab (docs/tour-scenes.js SCENES.more) builds each row as tr("more." + name). After the More-tab merges it kept asking for
// rows that no longer existed (exchangeRates, mainCurrency, statements, export, devices) and drew them as raw keys; the plain text test could not see
// it because the key is built piece by piece. These checks close that gap: every row the scene draws must be a text AND a real row of More.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "../../docs");
const scenes = fs.readFileSync(path.join(DOCS, "tour-scenes.js"), "utf8");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));

const scene = scenes.slice(scenes.indexOf("SCENES.more = {"), scenes.indexOf("SCENES.statements = {"));

// Since 2026-11-13 the scene COPIES the person's live More tab (its rows, groups, icons and words) instead of drawing its own list: it
// can no longer ask for removed rows or draw owner-only rows on a friend's copy. These checks keep it that way.
test("the More scene copies the live More tab, only its cards on show", () => {
  assert.match(scene, /document\.getElementById\("screen-more"\)/);
  assert.match(scene, /!c\.hidden && c\.classList\.contains\("card"\)/);
  assert.ok(!/tr\("more\./.test(scene), "no row is drawn from its own text any more");
  assert.ok(html.includes('<div id="screen-more" class="screen"'), "the More tab is still there to copy");
});

test("a copy is only a picture: no ids, translation hooks or screen names of its own", () => {
  const strip = scenes.slice(scenes.indexOf("function strip(el)"), scenes.indexOf("function copyOf("));
  for (const a of ["id", "data-i18n", "data-screen"]) assert.ok(strip.includes(`"${a}"`), a);
});

test("the More card's texts name today's things, and friends' copies get the Feedback & privacy sentence", () => {
  assert.ok(!/exchange rates|tipos de cambio/.test(STRINGS["tour.more.body"].en + STRINGS["tour.more.body"].es));
  assert.match(STRINGS["tour.more.body"].en, /currencies/);
  assert.match(STRINGS["tour.more.body"].es, /monedas/);
  assert.match(STRINGS["tour.more.body"].en, /your profile/);
  assert.match(app, /key === "more" && !perfIsOwnerCopy_\(\)\) body \+= tr\("tour\.more\.feedback"\)/);
  assert.match(STRINGS["wf.intro"].en, /More → My profile/);
  assert.match(STRINGS["wf.intro"].es, /Más → Mi perfil/);
});
