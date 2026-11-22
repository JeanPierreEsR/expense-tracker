// First-use practice "Import from another app": the phone builds a made-up CSV (StatementTable.practiceFile) and runs the REAL import and Undo.
// The only server piece is removePracticeImport (cleanup after an Exit / a closed app): it undoes batches made ONLY of practice entries, with the
// real undo (which also removes the category the import created), and forgets the practice file's remembered layout. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");
const ST = require("../../docs/statement-table.js");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const api = (rt, name, payload) => rt.api(name, payload);

function practiceStatement(lang) {
  const f = ST.practiceFile(lang, today());
  const rows = f.text.trim().split("\n").slice(1).map((l) => l.split(","));
  const lines = rows.map(([date, description, amount, category]) => ({ date, description, amount: Number(amount), currency: "PEN", category }));
  return { key: "NOACCOUNT", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: f.name,
    period: { start: lines[lines.length - 1].date, end: lines[0].date }, lines };
}
function importIt(rt, st, categoryMap) {
  const plan = api(rt, "planStatementHistory", { statements: [st] });
  return api(rt, "applyStatementDecisions", { dryRun: false, filename: st.file_name, statements: [st], categoryMap: categoryMap || {}, categoryNames: {}, actions: plan.actions });
}
const batchEntries = (rt, id) => run(rt, `getAllRows('Entries').filter(function (e) { return e.import_batch_id === ${JSON.stringify(id)}; })`);
const catNames = (rt) => run(rt, "getAllRows('Categories').map(function (c) { return c.name; })");

test("capability: a backend that can clean up the Import practice says so", () => {
  assert.equal(freshApp({ small: true }).rt.api("getMeta").capabilities.practiceImport, true);
});

test("the made-up file is read the way the screen needs: columns guessed, three expenses, a category on each, in both languages", async () => {
  for (const lang of ["en", "es"]) {
    const f = ST.practiceFile(lang, "2026-03-02");
    const rows = await ST.readTable(new TextEncoder().encode(f.text), f.name);
    const g = ST.guessMapping(rows, {});
    assert.deepEqual([g.date, g.description, g.amount, g.category, g.sign], [0, 1, 2, 3, "negative"], lang);
    assert.equal(ST.recognize(g.headers), null, "never mistaken for a known app layout");
    const out = ST.applyMapping(rows, g);
    assert.equal(out.lines.length, 3);
    assert.equal(out.skipped.length, 0);
    assert.ok(out.lines.every((l) => l.amount < 0 && l.category));
    assert.ok(ST.PRACTICE_FILE_NAMES.includes(f.name));
    assert.match(ST.signature(g, rows), /practice file|archivo de practica/, "its layout key cannot collide with a real file's");
  }
});

test("the practice lines carry names the server treats as practice entries (no budget alerts) in both languages", () => {
  const { rt } = freshApp({ small: true });
  for (const lang of ["en", "es"]) {
    for (const l of practiceStatement(lang).lines) assert.equal(run(rt, `isPracticeEntry_({description: ${JSON.stringify(l.description)}})`), true, l.description);
  }
});

test("removePracticeImport undoes a practice import that was saved and never undone, with the category it created", () => {
  const { rt } = freshApp({ small: true });
  const before = run(rt, "getAllRows('Entries').length");
  const catsBefore = catNames(rt);
  const st = practiceStatement("en");
  const saved = importIt(rt, st, { "expense:practice rides": "create" });
  assert.equal(batchEntries(rt, saved.batchId).length, 3);
  assert.ok(catNames(rt).includes("Practice rides"), "the import created the new category");
  const out = api(rt, "removePracticeImport", {});
  assert.equal(out.batches, 1);
  assert.equal(out.entries, 3);
  assert.equal(run(rt, "getAllRows('Entries').length"), before);
  // ("Refunds" is a standard income category that the import plan puts back if a person had deleted it: existing behaviour of every import, not the practice's.)
  assert.deepEqual(catNames(rt).filter((n) => n !== "Refunds"), catsBefore.filter((n) => n !== "Refunds"), "the created category went with it");
});

test("removePracticeImport forgets the made-up file's remembered layout and only that one", () => {
  const { rt } = freshApp({ small: true });
  api(rt, "saveStatementFormat", { signature: "date|description|amount|category|practice file", label: "", mapping: { date: 0 }, accounts: {}, categories: {} });
  api(rt, "saveStatementFormat", { signature: "date|description|amount", label: "My bank", mapping: { date: 0 }, accounts: {}, categories: {} });
  const out = api(rt, "removePracticeImport", { signature: "date|description|amount|category|practice file" });
  assert.equal(out.layouts, 1);
  assert.equal(api(rt, "getStatementFormat", { signature: "date|description|amount|category|practice file" }).found, false);
  assert.equal(api(rt, "getStatementFormat", { signature: "date|description|amount" }).found, true, "a real layout stays");
});

test("removePracticeImport never touches a real import, even one with a practice-named entry mixed in", () => {
  const { rt } = freshApp({ small: true });
  const real = { key: "NOACCOUNT", kind: "csv", source: "app", holder: "", verified: false, balances: {}, file_name: "real.csv",
    period: { start: "2019-03-05", end: "2019-03-07" }, lines: [
      { date: "2019-03-05", description: "Bodega la Esquina", amount: -23.47, currency: "PEN", category: "Food" },
      { date: "2019-03-06", description: "Practice lunch", amount: -9, currency: "PEN", category: "Food" }] };
  const saved = importIt(rt, real);
  const n = batchEntries(rt, saved.batchId).length;
  assert.equal(n, 2);
  const out = api(rt, "removePracticeImport", {});
  assert.equal(out.batches, 0);
  assert.equal(batchEntries(rt, saved.batchId).length, 2, "the whole real batch is still there");
});

test("removePracticeImport with nothing to remove is a harmless no-op", () => {
  const { rt } = freshApp({ small: true });
  const out = api(rt, "removePracticeImport", { signature: "never-saved" });
  assert.deepEqual(out, { batches: 0, entries: 0, layouts: 0 });
});

test("a description with accents is capitalised word by word without breaking the accented letter (found while building this practice)", () => {
  const { rt } = freshApp({ small: true });
  const t = (x) => run(rt, `stmtCleanDescription_(${JSON.stringify(x)})`);
  assert.equal(t("almuerzo de práctica"), "Almuerzo De Práctica");
  assert.equal(t("CAFÉ  DEL   PARQUE"), "Café Del Parque");
  assert.equal(t("pago ñandú*lima per"), "Pago Ñandú");
  assert.equal(t("Bodega la esquina"), "Bodega la esquina", "written with care: left as it is");
});

test("saved through the real import, the practice entries carry exactly the names the cleanup looks for, in both languages", () => {
  for (const lang of ["en", "es"]) {
    const { rt } = freshApp({ small: true });
    const saved = importIt(rt, practiceStatement(lang), {});
    const names = batchEntries(rt, saved.batchId).map((e) => e.description);
    assert.equal(names.length, 3, lang);
    for (const n of names) assert.equal(run(rt, `isPracticeEntry_({description: ${JSON.stringify(n)}})`), true, n);
    assert.equal(api(rt, "removePracticeImport", {}).batches, 1, lang);
  }
});
