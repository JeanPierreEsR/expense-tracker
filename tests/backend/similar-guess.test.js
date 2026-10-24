// Guessing a category from SIMILAR descriptions, and Confirm in Needs review filing the look-alikes (2026-10-24). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp({ entries: 20 });
  rt.run(`ensureEntriesMerchantColumn_();`);
  for (const [id, name] of [["cat-food", "Sim Food"], ["cat-fun", "Sim Fun"], ["cat-mall", "Sim Mall"]]) {
    rt.run(`appendRowObject('Categories', { id: '${id}', name: '${name}', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  }
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  return { rt, data };
}
let n = 0;
function entry(rt, merchant, over = {}) {
  const e = { id: "s" + ++n, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: "", description: merchant.toUpperCase(), merchant,
    paid_by: "me", status: "confirmed", source: "import", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
const cat = (rt, id) => rt.rows("Entries").find((e) => e.id === id).category_id;
const guess = (rt, description) => rt.run(`guessCategoryForNewEntry_(${JSON.stringify({ type: "expense", description, category_id: "" })})`);

test("a place with no history of its own takes what its similar places agree on", () => {
  const { rt } = setup();
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  entry(rt, "wong miraflores", { category_id: "cat-food" });
  assert.equal(guess(rt, "WONG SURCO*98765"), "cat-food");
});

test("one similar entry is not enough, and a family that disagrees guesses nothing", () => {
  const { rt } = setup();
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  assert.equal(guess(rt, "wong surco"), "");
  entry(rt, "wong miraflores", { category_id: "cat-fun" });
  assert.equal(guess(rt, "wong surco"), "");
});

test("a place with history of its own is never overridden by its family", () => {
  const { rt } = setup();
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  entry(rt, "wong miraflores", { category_id: "cat-food" });
  entry(rt, "wong barranco", { category_id: "cat-fun" });
  entry(rt, "wong barranco", { category_id: "cat-mall" });   // its own history is split: no guess, even though the family leans food
  assert.equal(guess(rt, "wong barranco"), "");
});

test("a way of paying is not a place: YAPE or PAGO never forms a family", () => {
  const { rt } = setup();
  entry(rt, "yape juan", { category_id: "cat-food" });
  entry(rt, "yape maria", { category_id: "cat-food" });
  assert.equal(guess(rt, "yape pedro"), "");
});

test("brand words glued or spaced still line up, and a longer brand wins over a shorter one", () => {
  const { rt } = setup();
  entry(rt, "plaza vea surco", { category_id: "cat-food" });
  entry(rt, "plaza vea lince", { category_id: "cat-food" });
  entry(rt, "plaza bonita", { category_id: "cat-mall" });
  entry(rt, "plaza norte", { category_id: "cat-mall" });
  assert.equal(guess(rt, "plazavea magdalena"), "cat-food");
  assert.equal(guess(rt, "plaza vea san miguel"), "cat-food");
  assert.equal(guess(rt, "plaza lima sur"), "");   // "plaza" alone is split between two kinds of place
});

test("categorizing one entry also files blanks of similar places, only when the family agrees", () => {
  const { rt } = setup();
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  const chosen = entry(rt, "wong miraflores");
  const same = entry(rt, "wong miraflores");
  const similar = entry(rt, "wong surco");
  const stranger = entry(rt, "wongtech");
  const r = rt.api("updateEntry", { id: chosen.id, fields: { category_id: "cat-food" } });
  assert.equal(r.follow.count, 2);
  assert.equal(r.follow.similarCount, 1);
  assert.equal(cat(rt, same.id), "cat-food");
  assert.equal(cat(rt, similar.id), "cat-food");
  assert.equal(cat(rt, stranger.id), "");
});

test("with no other evidence, only the exact place follows — never the family on one choice", () => {
  const { rt } = setup();
  const chosen = entry(rt, "wong miraflores");
  const same = entry(rt, "wong miraflores");
  const similar = entry(rt, "wong surco");
  const r = rt.api("updateEntry", { id: chosen.id, fields: { category_id: "cat-food" } });
  assert.equal(r.follow.count, 1);
  assert.equal(cat(rt, same.id), "cat-food");
  assert.equal(cat(rt, similar.id), "");
});

test("Tidy my history suggests from similar places and says so", () => {
  const { rt } = setup();
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  entry(rt, "wong miraflores", { category_id: "cat-food" });
  entry(rt, "wong surco");
  entry(rt, "bodega esquina");
  const g = rt.api("listTidyGroups", {}).groups;
  const wong = g.find((x) => x.key === "wong surco");
  assert.equal(wong.suggestion.categoryId, "cat-food");
  assert.equal(wong.suggestion.similar, true);
  assert.equal(g.find((x) => x.key === "bodega esquina").suggestion, null);
});

test("confirming a pending entry files the blank look-alikes, and Undo puts them back", () => {
  const { rt } = setup();
  const pending = entry(rt, "bodega esquina", { status: "pending", category_id: "cat-food" });
  const b = entry(rt, "bodega esquina"), c = entry(rt, "bodega esquina");
  const other = entry(rt, "farmacia sur");
  const r = rt.api("confirmEntry", { id: pending.id });
  assert.equal(r.done, true);
  assert.equal(r.follow.count, 2);
  assert.equal(r.follow.categoryName, "Sim Food");
  assert.equal(cat(rt, b.id), "cat-food"); assert.equal(cat(rt, c.id), "cat-food");
  assert.equal(cat(rt, other.id), "");
  const u = rt.api("undoCategoryFollow", { changes: [{ categoryId: r.follow.categoryId, ids: r.follow.ids }], annualIds: r.follow.annualIds });
  assert.equal(u.reverted, 2);
  assert.equal(cat(rt, b.id), ""); assert.equal(cat(rt, pending.id), "cat-food");
});

test("confirming with nothing to follow answers as before", () => {
  const { rt } = setup();
  const pending = entry(rt, "bodega esquina", { status: "pending", category_id: "cat-food" });
  const r = rt.api("confirmEntry", { id: pending.id });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), { done: true });
});

test("a bank statement line takes the category of the same or similar places, and the report counts it", () => {
  const { rt, data } = setup();
  const savings = data.pms.find((p) => p.type === "debit");
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  entry(rt, "wong miraflores", { category_id: "cat-food" });
  const stmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "s.pdf",
    lines: [
      { date: "2019-03-05", description: "COMPRA WONG SURCO", amount: -23.47, currency: "PEN" },
      { date: "2019-03-14", description: "COMPRA FARMACIA SUR", amount: -40.1, currency: "PEN" }
    ]
  };
  const plan = JSON.parse(rt.run(`JSON.stringify(planStatementHistory(${JSON.stringify({ statements: [stmt] })}))`));
  const dry = rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: true, filename: "history", statements: [stmt], actions: plan.actions })})`);
  assert.equal(dry.categoriesGuessed, 1);
  assert.equal(rt.rows("Entries").filter((e) => e.external_id && /^stmt-/.test(e.external_id)).length, 0, "a dry run writes nothing");
  const real = rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "history", statements: [stmt], actions: plan.actions })})`);
  assert.equal(real.categoriesGuessed, 1);
  const added = rt.rows("Entries").filter((e) => /^stmt-/.test(e.external_id || ""));
  assert.equal(added.find((e) => /wong/i.test(e.description)).category_id, "cat-food");
  assert.equal(added.find((e) => /farmacia/i.test(e.description)).category_id, "");
});

test("a line whose file names a category is never guessed over", () => {
  const { rt, data } = setup();
  const savings = data.pms.find((p) => p.type === "debit");
  entry(rt, "wong san isidro", { category_id: "cat-food" });
  entry(rt, "wong miraflores", { category_id: "cat-food" });
  const stmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "s.csv", source: "app",
    lines: [{ date: "2019-03-05", description: "wong surco", amount: -23.47, currency: "PEN", category: "Something Unmapped" }]
  };
  const plan = JSON.parse(rt.run(`JSON.stringify(planStatementHistory(${JSON.stringify({ statements: [stmt] })}))`));
  const real = rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "history", statements: [stmt], actions: plan.actions })})`);
  assert.equal(real.categoriesGuessed, undefined);
  assert.equal(rt.rows("Entries").find((e) => /^stmt-/.test(e.external_id || "")).category_id, "");
});
