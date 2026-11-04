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
  for (const k of ["title", "body", "deleted", "export", "pIntro", "pTidy", "pExport"]) {
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
  for (const k of ["spot.e.invite", "spot.e.note", "spot.e.intro", "spot.e.start", "spot.e.s1", "spot.e.s2", "spot.e.s4", "spot.e.s4err", "spot.e.s5", "spot.e.s6", "spot.e.finish", "spot.e.done"]) {
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

test("the Tidy practice: invitation box, offered after the list loads, flag-gated, texts in both languages, one cleanup call", () => {
  const tidyScreen = html.slice(html.indexOf('id="screen-tidy"'), html.indexOf('id="screen-bank-emails"'));
  assert.ok(tidyScreen.includes('id="tidy-tip-invite"'));
  const show = app.slice(app.indexOf("async function showTidyScreen()"), app.indexOf("async function loadTidy_()"));
  assert.match(show, /await loadTidy_\(\);\s*offerTidyTip_\(\)/, "offered only once the list has arrived");
  assert.match(app, /offerTip_\("tidy", "tidy-tip-invite", tr\("spot\.y\.invite"\), startTidyPractice_\)/);
  assert.match(app, /if \(!caps\.practiceTidy\) return;/);
  const practice = app.slice(app.indexOf("function practiceYSteps_()"), app.indexOf("// ---- More → My data: one row for everything"));
  for (const k of new Set([...practice.matchAll(/tr\("(spot\.y\.[A-Za-z0-9]+)"/g)].map((m) => m[1]))) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  for (const k of ["spot.y.invite", "spot.y.note", "spot.y.intro", "spot.y.start", "spot.y.s1", "spot.y.s2", "spot.y.s3", "spot.y.s3fix", "spot.y.s4", "spot.y.s5", "spot.y.removing", "spot.y.removed", "spot.y.leftover", "spot.y.removeFailed", "spot.y.createFailed", "spot.y.stillRemoving"]) {
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  }
  assert.equal((app.match(/callApi\("removePracticeTidy"/g) || []).length, 1, "one cleanup call");
  assert.match(app, /setTimeout\(practiceYLeftover_, 20000\)/, "a practice left by a closed app is offered for removal");
  assert.match(app, /"Practice coffee shop", "Cafetería de práctica"/, "Home marks the practice entries as being deleted");
  // the steps light up the practice's own group only, never a real group or "Apply all suggestions"
  assert.ok(!practice.includes("tidy-apply-all-btn"));
  assert.match(practice, /practiceYBox_\(\)/);
});

test("the Tidy tour line names the screen and sits with the others", () => {
  assert.match(app, /tr\("tour\.mydata\.pTidy"\);[^\n]*\n[\s\S]{0,200}tr\("tour\.mydata\.pDeleted"\);[\s\S]{0,120}tr\("tour\.mydata\.pImport"\);\s*body \+= tr\("tour\.mydata\.pExport"\)/);
  assert.match(STRINGS["tour.mydata.pTidy"].en, /Tidy my history/);
  assert.match(STRINGS["tour.mydata.pTidy"].es, /Ordenar mi historial/);
});

test("the Recently deleted practice: invitation box, offered after the list loads, flag-gated, texts in both languages, one cleanup call", () => {
  const screen = html.slice(html.indexOf('id="screen-deleted-entries"'), html.indexOf('id="screen-tidy"'));
  assert.ok(screen.includes('id="deleted-tip-invite"'));
  const show = app.slice(app.indexOf("async function showDeletedScreen_()"), app.indexOf("async function refreshDeletedScreen_()"));
  assert.match(show, /await refreshDeletedScreen_\(\);[\s\S]*offerDeletedTip_\(\)/, "offered only once the list has arrived");
  assert.match(app, /offerTip_\("deleted", "deleted-tip-invite", tr\("spot\.d\.invite"\), startDeletedPractice_\)/);
  assert.match(app, /!caps\.practiceDeleted \|\| !caps\.entriesRestore \|\| !caps\.entriesBulk/);
  const practice = app.slice(app.indexOf("function practiceDSteps_()"), app.indexOf("// A practice left behind (the app was closed midway)", app.indexOf("function practiceDSteps_()")));
  for (const k of new Set([...app.matchAll(/tr\("(spot\.d\.[A-Za-z0-9]+)"/g)].map((m) => m[1]))) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k + " is asked for but missing");
  for (const k of ["spot.d.invite", "spot.d.note", "spot.d.intro", "spot.d.start", "spot.d.finish", "spot.d.removing", "spot.d.removed", "spot.d.leftover", "spot.d.removeFailed", "spot.d.createFailed", "spot.d.stillRemoving", "spot.d.deleteFailed"]) {
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  }
  for (let i = 1; i <= 14; i++) assert.ok(STRINGS["spot.d.s" + i] && STRINGS["spot.d.s" + i].es, "step " + i);
  assert.equal((app.match(/callApi\("removePracticeDeleted"/g) || []).length, 1, "one cleanup call");
  assert.equal((app.match(/callApi\("createPracticeDeleted"/g) || []).length, 1, "one call makes the entries");
  assert.match(app, /setTimeout\(practiceDLeftover_, 22000\)/, "a practice left by a closed app is offered for removal");
  assert.match(app, /"Practice snack", "Merienda de práctica"/, "Home marks the practice entries as being deleted");
  // the steps use the REAL controls: the Home edit mode, the delete sheet, the nav, the More rows and the batch buttons
  for (const id of ["entries-edit-btn", "entries-delete-selected-btn", "entries-bulk-go", "more-my-data-btn", "more-deleted-btn"]) {
    assert.ok(practice.includes(id), id);
    if (id !== "entries-bulk-go") assert.ok(html.includes(`id="${id}"`), id + " is not in the page");   // (the confirm button is drawn by the delete sheet)
    else assert.ok(app.includes(`id="${id}"`), id + " is not drawn by the delete sheet");
  }
  // never lights up "Select all", "Restore all" or a real batch: only the practice's own rows and its one batch
  assert.ok(!practice.includes("entries-selectall-btn"));
  assert.ok(!practice.includes("deleted-all"));
  assert.match(practice, /practiceDIds_\(\)/);
});

test("the Recently deleted tour line names the screen, only where the screen exists", () => {
  assert.match(STRINGS["tour.mydata.pDeleted"].en, /Recently deleted/);
  assert.match(STRINGS["tour.mydata.pDeleted"].es, /Eliminados recientemente/);
  assert.match(app, /cp\.entriesRestore && cp\.practiceDeleted && cp\.entriesBulk\) body \+= tr\("tour\.mydata\.pDeleted"\)/);
});

test("the Import practice: invitation box in Import mode, offered when the screen opens, flag-gated, texts in both languages, one cleanup call", () => {
  const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");
  assert.ok(html.includes('id="import-tip-invite"'));
  assert.match(html, /id="import-tip-invite"[^>]*>/);
  assert.match(html, /class="card tip-invite stmt-import-only" id="import-tip-invite"/, "shown in Import mode only");
  assert.match(stm, /if \(next === "import"\) offerImportTip_\(\);/);
  assert.match(stm, /offerTip_\("import", "import-tip-invite", tr\("spot\.f\.invite"\), startImportPractice_\)/);
  assert.match(stm, /!caps\.practiceImport \|\| screenMode !== "import"/);
  for (const k of new Set([...stm.matchAll(/tr\("(spot\.f\.[A-Za-z0-9]+)"/g)].map((m) => m[1]))) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k + " is asked for but missing");
  for (let i = 1; i <= 11; i++) assert.ok(STRINGS["spot.f.s" + i] && STRINGS["spot.f.s" + i].es, "step " + i);
  assert.equal((stm.match(/callApi\("removePracticeImport"/g) || []).length, 1, "one cleanup call");
  assert.match(app, /window\.practiceILeftover_/, "a practice left by a closed app is offered for removal");
  assert.match(app, /"Practice Lunch", "Almuerzo De Práctica"/, "Home marks the practice entries as being deleted");
  assert.match(app, /removePracticeImport: 150000/);
  // the steps use the REAL buttons of the import screens
  const steps = stm.slice(stm.indexOf("function practiceISteps_()"), stm.indexOf("// Builds the made-up file"));
  for (const sel of ["tm-use", "#stmt-next-2", "#statement-history-save", "#stmt-undo-btn", ".stmt-upload-btn"]) assert.ok(steps.includes(sel), sel);
  for (const id of ["stmt-next-2", "statement-history-save"]) assert.ok(html.includes(`id="${id}"`) || stm.includes(`id="${id}"`), id);
  // only the practice's own file skips the confirm questions, and only while the walkthrough runs
  assert.match(stm, /practiceNoConfirm_\(practiceIOwns_\(/);
  assert.match(stm, /practiceNoConfirm_\(practiceIOwnsBatch_\(batchId\)\)/);
  // the made-up file goes to the real file handler
  assert.match(stm, /handleStatementFiles\(\[new File\(\[f\.text\], f\.name/);
});

test("the Import tour line names the screen and only shows where the cleanup exists", () => {
  assert.match(STRINGS["tour.mydata.pImport"].en, /Import from another app/);
  assert.match(STRINGS["tour.mydata.pImport"].es, /Importar de otra app/);
  assert.match(app, /if \(cp\.practiceImport\) body \+= tr\("tour\.mydata\.pImport"\)/);
});
