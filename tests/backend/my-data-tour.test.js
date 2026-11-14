// The My data tour card and the Export practice (owner's plan, 2026-11-03). Since 2026-11-13 the scene COPIES the live hub (its rows, icons
// and words, Recently deleted only where the app shows it) instead of drawing its own list, so it cannot fall behind the hub; these checks keep
// it that way. The card is in the Advanced list; the Export practice is wired to its screen and its texts exist.
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
test("the My data scene copies the live hub and lights only the rows on show", () => {
  assert.match(scene, /document\.querySelector\("#screen-my-data \.card"\)/);
  assert.match(scene, /\.md-row:not\(\[hidden\]\)/, "a hidden row (Recently deleted on a copy that cannot restore) is never visited");
  for (const head of ["md.title", "md.bringIn", "md.tidyHead", "md.takeOut", "md.bank", "md.import", "md.tidy", "md.deleted", "md.export"]) {
    assert.ok(STRINGS[head].en && STRINGS[head].es, head);
    assert.ok(hub.includes(`data-i18n="${head}"`), head + " is not on the hub");
  }
  assert.ok(hub.includes('class="card"'), "the hub is one card the scene can copy");
});

test("the My data card is last in the Advanced list and says only what the hub holds (shorter cards, owner 2026-11-14)", () => {
  assert.match(app, /cards\.push\("mydata"\);/);
  assert.ok(!/"statements"\s*[,\]]/.test(app.slice(app.indexOf("function tourCards_("), app.indexOf("function openTour_("))), "no separate statements card");
  const t = STRINGS["tour.mydata.body"];
  assert.match(t.en, /More → My data/); assert.match(t.es, /Más → Mis datos/);
  for (const k of ["deleted", "export", "pIntro", "pExport", "pDeleted", "pImport", "pBank"]) assert.ok(!STRINGS["tour.mydata." + k], "tour.mydata." + k + " is gone");
});

test("the Export walkthrough: no yellow card, offered by the idle bubble, texts in both languages", () => {
  const exportScreen = html.slice(html.indexOf('id="screen-export"'), html.indexOf('id="screen-my-data"'));
  assert.ok(!exportScreen.includes('id="export-tip-invite"'));
  const show = app.slice(app.indexOf("function showExportScreen()"), app.indexOf("function refreshExportScreen_()"));
  assert.match(show, /watchExportIdle_\(\)/);
  assert.match(app, /function watchExportIdle_[\s\S]*?idleOffer_\(/);
  const practice = app.slice(app.indexOf("function practiceESteps_()"), app.indexOf("// ---- Categories that catch up later"));
  const keys = new Set([...practice.matchAll(/tr\("(spot\.e\.[A-Za-z0-9]+)"/g)].map((m) => m[1]));
  for (const k of ["spot.e.note", "spot.e.intro", "spot.e.start", "spot.e.s2", "spot.e.s4", "spot.e.s4err", "spot.e.s5", "spot.e.s6", "spot.e.finish", "spot.e.done"]) {
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  }
  for (const k of keys) assert.ok(STRINGS[k], k + " is asked for but missing");
});

test("the Export practice records nothing and calls no extra server action: it starts from the person's choices and puts back only the period", () => {
  const practice = app.slice(app.indexOf("function practiceESteps_()"), app.indexOf("// ---- Categories that catch up later"));
  assert.ok(!/callApi\(/.test(practice), "the practice itself makes no server call (the screen's own Get my files does)");
  assert.match(practice, /practiceE_ = \{ range: exportEl_\("export-range"\)\.value \}/);
  assert.match(practice, /exportEl_\("export-range"\)\.value = mine\.range;\s*saveExportPrefs_\(\);/);
  assert.ok(!/export-(pending|backup)-check/.test(practice), "the other choices are never touched");
  // the steps use the REAL controls of the screen
  for (const id of ["export-entries-check", "export-range", "export-get-btn", "export-ready"]) {
    assert.ok(practice.includes(id), id);
    assert.ok(html.includes(`id="${id}"`), id + " is not in the page");
  }
});

test("the Tidy practice is gone (owner, 2026-11-12: the real tutorial teaches it); only its cleanup of a half-done practice stays", () => {
  assert.ok(!html.includes('id="tidy-tip-invite"'));
  for (const name of ["offerTidyTip_", "startTidyPractice_", "practiceYSteps_", "practiceYMake_"]) assert.ok(!app.includes(name), name);
  assert.ok(!STRINGS["tour.mydata.pTidy"] && !STRINGS["spot.y.invite"] && !STRINGS["spot.y.intro"]);
  assert.match(app, /async function practiceYRemove_\(\)/);
  assert.match(app, /async function practiceYLeftover_\(\)/);
  assert.ok(STRINGS["spot.y.leftover"] && STRINGS["spot.y.removed"] && STRINGS["spot.y.removeFailed"]);
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
  for (const i of [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 14]) assert.ok(STRINGS["spot.d.s" + i] && STRINGS["spot.d.s" + i].es, "step " + i);   // (s7 and s11 were merged into s8 and s12, owner's plan 2026-11-05)
  assert.equal((app.match(/callApi\("removePracticeDeleted"/g) || []).length, 1, "one cleanup call");
  assert.equal((app.match(/callApi\("createPracticeDeleted"/g) || []).length, 1, "one call makes the entries");
  assert.match(app, /setTimeout\(practiceDLeftover_, 22000\)/, "a practice left by a closed app is offered for removal");
  assert.match(app, /"Practice snack", "Lonche de práctica"/, "Home marks the practice entries as being deleted");
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
  assert.match(app, /window\.statementsPracticeLeftover_/, "a practice left by a closed app is offered for removal");
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

test("the Bank statements practice: invitation box in Bank mode, offered after the screen has loaded, flag-gated, texts in both languages, one cleanup call, account made by one call", () => {
  const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");
  assert.match(html, /class="card tip-invite stmt-bank-only" id="bank-tip-invite"/, "shown in Bank mode only");
  assert.match(stm, /Promise\.allSettled\(loaded\)\.then\(\(\) => \{[\s\S]{0,200}offerBankTip_\(\)/, "offered only once the status line and the Inbox have arrived");
  assert.match(stm, /offerTip_\("bank", "bank-tip-invite", tr\("spot\.s\.invite"\), startBankPractice_\)/);
  assert.match(stm, /!caps\.practiceBank \|\| screenMode !== "bank"/);
  for (const k of new Set([...stm.matchAll(/tr\(`?"?(spot\.s\.[A-Za-z0-9]+)/g)].map((m) => m[1]))) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k + " is asked for but missing");
  for (let i = 1; i <= 11; i++) if (i !== 2) assert.ok(STRINGS["spot.s.s" + i] && STRINGS["spot.s.s" + i].es, "step " + i);
  for (const k of ["stillRemoving", "busyRun", "removing", "removed", "leftover", "note"]) assert.ok(STRINGS["spot.s." + k] && STRINGS["spot.s." + k].es, k);
  assert.equal((stm.match(/callApi\("removePracticeBank"/g) || []).length, 1, "one cleanup call");
  assert.equal((stm.match(/callApi\("createPracticeBankAccount"/g) || []).length, 1, "one call makes the account");
  assert.match(app, /"Practice Bakery", "Panadería De Práctica"/, "Home marks the practice entries as being deleted");
  assert.match(app, /removePracticeBank: 150000/);
  // the steps use the REAL buttons of the statement screens; the account is chosen by the practice, never offered for a real one
  const steps = stm.slice(stm.indexOf("function practiceBSteps_()"), stm.indexOf("// Adds the empty Practice account"));
  for (const sel of ["tm-use", "#stmt-next-2", "#statement-history-save", "#stmt-undo-btn", "#stmt-upload-card"]) assert.ok(steps.includes(sel), sel);
  assert.match(steps, /sel\.value = practiceI_\.accountId/);
  // it never deletes an account it did not make, and refuses to start when one with that name exists
  assert.match(stm, /account: !!p\.accountMade/);
  assert.match(stm, /isPracticeAccountName_\(pm\.nickname\)\)\) \{ showToast_\(tr\("spot\.s\.accountExists"\)\)/);
  assert.match(stm, /if \(res\.existed\) \{ practiceI_\.accountMade = false;/);
});

test("statements.js never replaces a global that app.js already defines (the Import hook once overwrote the Investments leftover prompt)", () => {
  const stm = fs.readFileSync(path.join(DOCS, "statements.js"), "utf8");
  const clashes = [...stm.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]).filter((name) => new RegExp("(^|\\n)(async\\s+)?function\\s+" + name + "\\s*\\(").test(app));
  assert.deepEqual(clashes, []);
});
