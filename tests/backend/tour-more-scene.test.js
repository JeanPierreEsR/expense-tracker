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
const drawn = [...scene.matchAll(/card\(\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([A-Za-z]+)"/g)].map((k) => k[1]));
const moreScreen = html.slice(html.indexOf('id="screen-more"'), html.indexOf('id="screen-recurring"'));

test("the More scene draws rows (it was not emptied by accident)", () => {
  assert.ok(drawn.length >= 10, drawn.join(","));
  assert.ok(drawn.includes("currencies") && drawn.includes("myData") && drawn.includes("myProfile") && drawn.includes("bankEmails"));
});

test("every row the scene draws is a text in both languages and a real row of the More tab", () => {
  for (const k of drawn) {
    const t = STRINGS["more." + k];
    assert.ok(t && t.en && t.es, `more.${k} has no text`);
    assert.ok(moreScreen.includes(`data-i18n="more.${k}"`), `more.${k} is not a row of More any more`);
  }
});

test("the rows the scene does not draw (owner-only and friend-only) are not drawn by mistake", () => {
  for (const gone of ["exchangeRates", "mainCurrency", "statements", "export", "devices", "privacy", "feedback", "extras", "perfShare", "ownerNames"]) {
    assert.ok(!drawn.includes(gone), gone + " no longer exists as a More row");
  }
  for (const friendsOnly of ["feedbackPrivacy", "friends", "perf"]) assert.ok(!drawn.includes(friendsOnly), friendsOnly + " is not on every copy");
});

test("the finger taps a row that is drawn", () => {
  const timeline = scene.slice(scene.indexOf("timeline(p, ctx)"));
  for (const m of timeline.matchAll(/p\.rows\.([A-Za-z]+)/g)) assert.ok(drawn.includes(m[1]), m[1]);
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
