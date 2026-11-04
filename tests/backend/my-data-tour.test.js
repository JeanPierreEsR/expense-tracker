// The My data tour card and the Export practice (owner's plan, 2026-11-03). The scene draws the hub's rows from text keys "md.<name>" built piece
// by piece (the plain "every text exists" test cannot see those), so these checks close the gap: every row the scene draws is a text in both
// languages AND a real row of the My data hub; the card is in the Advanced list; the Export practice is wired to its screen and its texts exist.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "../../docs");
const scenes = fs.readFileSync(path.join(DOCS, "tour-scenes.js"), "utf8");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));

const scene = scenes.slice(scenes.indexOf("SCENES.mydata = {"), scenes.indexOf("// ---- The big picture, as a flow chart"));
const hub = html.slice(html.indexOf('id="screen-my-data"'), html.indexOf('id="screen-my-profile"'));
const drawn = [...new Set([...scene.matchAll(/\["([a-z]+)", "[^"\w]+"\]/g)].map((m) => m[1]))];   // (tidy appears in both branches of the Recently deleted choice)

test("the My data scene draws the hub's five rows (it was not emptied by accident)", () => {
  assert.deepEqual(drawn.sort(), ["bank", "deleted", "export", "import", "tidy"]);
});

test("every row and heading the scene draws is a text in both languages and a real part of the hub", () => {
  for (const k of drawn) {
    const t = STRINGS["md." + k];
    assert.ok(t && t.en && t.es, `md.${k} has no text`);
    assert.ok(hub.includes(`data-i18n="md.${k}"`), `md.${k} is not a row of the My data hub`);
  }
  for (const head of ["md.title", "md.bringIn", "md.tidyHead", "md.takeOut"]) {
    assert.ok(STRINGS[head].en && STRINGS[head].es, head);
    assert.ok(hub.includes(`data-i18n="${head}"`), head + " is not on the hub");
  }
});

test("Recently deleted is drawn only where the app shows it, and the finger only taps drawn rows", () => {
  assert.match(scene, /ctx\.restore \?/);
  assert.match(app, /restore: !!\(\(meta && meta\.capabilities\) \|\| \{\}\)\.entriesRestore/);
  assert.match(app, /entriesRestore\) body \+= tr\("tour\.mydata\.deleted"\)/);
});

test("the My data card follows the Bank statements card in the Advanced list and its texts exist in both languages", () => {
  assert.match(app, /cards\.push\("statements"\);\s*cards\.push\("mydata"\)/);
  for (const k of ["title", "body", "deleted", "export", "pIntro", "pExport"]) {
    const t = STRINGS["tour.mydata." + k];
    assert.ok(t && t.en && t.es, "tour.mydata." + k);
  }
});

test("the card's texts name today's rows and the way back to the practices", () => {
  const all = (lang) => ["body", "deleted", "export", "pIntro", "pExport"].map((k) => STRINGS["tour.mydata." + k][lang]).join("");
  assert.match(all("en"), /More → My data/);
  assert.match(all("es"), /Más → Mis datos/);
  assert.match(all("en"), /More → How to use the app → 💡 Practice tips/);
  assert.match(all("es"), /Más → Cómo usar la app → 💡 Práctica guiada/);
  // the row names the card quotes are the hub's own
  for (const [lang, rows] of [["en", ["Bank statements", "Import from another app", "Tidy my history", "Recently deleted", "Export my data"]], ["es", ["Estados de cuenta", "Importar de otra app", "Ordenar mi historial", "Eliminados recientemente", "Exportar mis datos"]]]) {
    for (const r of rows) assert.ok(all(lang).includes(r), `${lang}: the card never names “${r}”`);
  }
});

test("the Export practice: invitation box on the screen, offered when the screen is drawn, texts in both languages", () => {
  const exportScreen = html.slice(html.indexOf('id="screen-export"'), html.indexOf('id="screen-my-data"'));
  assert.ok(exportScreen.includes('id="export-tip-invite"'));
  const show = app.slice(app.indexOf("function showExportScreen()"), app.indexOf("function refreshExportScreen_()"));
  assert.match(show, /offerExportTip_\(\)/);
  assert.match(app, /offerTip_\("export", "export-tip-invite", tr\("spot\.e\.invite"\), startExportPractice_\)/);
  const practice = app.slice(app.indexOf("function practiceESteps_()"), app.indexOf("// ---- Categories that catch up later"));
  const keys = new Set([...practice.matchAll(/tr\("(spot\.e\.[A-Za-z0-9]+)"/g)].map((m) => m[1]));
  for (const k of ["spot.e.invite", "spot.e.note", "spot.e.intro", "spot.e.start", "spot.e.s1", "spot.e.s2", "spot.e.s3", "spot.e.s4", "spot.e.s4err", "spot.e.s5", "spot.e.s6", "spot.e.gotIt", "spot.e.finish", "spot.e.done"]) {
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  }
  for (const k of keys) assert.ok(STRINGS[k], k + " is asked for but missing");
});

test("the Export practice records nothing and calls no extra server action: it only reads, then puts the screen's choices back", () => {
  const practice = app.slice(app.indexOf("function practiceESteps_()"), app.indexOf("// ---- Categories that catch up later"));
  assert.ok(!/callApi\(/.test(practice), "the practice itself makes no server call (the screen's own Get my files does)");
  assert.match(practice, /localStorage\.setItem\(EXPORT_PREFS_KEY/);
  // the steps use the REAL controls of the screen
  for (const id of ["export-entries-check", "export-range", "export-pending-check", "export-backup-check", "export-get-btn", "export-ready"]) {
    assert.ok(practice.includes(id), id);
    assert.ok(html.includes(`id="${id}"`), id + " is not in the page");
  }
});
