// Fill my history, phase 2: entries imported without a category catch up later — when the person categorizes one,
// when they tidy by merchant, and when a new entry is saved without a category. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`ensureEntriesMerchantColumn_();`);
  for (const [id, name] of [["cat-food", "Fol Food"], ["cat-fun", "Fol Fun"]]) {
    rt.run(`appendRowObject('Categories', { id: '${id}', name: '${name}', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  }
  rt.run(`appendRowObject('Categories', { id: 'cat-pay', name: 'Fol Pay', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  return rt;
}
let n = 0;
function entry(rt, over = {}) {
  const e = { id: "f" + ++n, type: "expense", date: today(), amount: 10, currency: "PEN", category_id: "", description: "RAPPI PERU*123", merchant: "rappi peru",
    paid_by: "me", status: "confirmed", source: "import", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
const cat = (rt, id) => rt.rows("Entries").find((e) => e.id === id).category_id;

test("categorizing one entry fills the other blanks of the same merchant, and only those", () => {
  const rt = setup();
  const a = entry(rt), b = entry(rt), c = entry(rt);
  const other = entry(rt, { merchant: "wong", description: "WONG" });
  const keep = entry(rt, { category_id: "cat-fun", merchant: "wong", description: "WONG" });   // already has one: untouched
  const pending = entry(rt, { status: "pending" });                       // under review: untouched
  const r = rt.api("updateEntry", { id: a.id, fields: { category_id: "cat-food" } });
  assert.equal(r.follow.count, 2);
  assert.equal(r.follow.categoryId, "cat-food");
  assert.equal(r.follow.categoryName, "Fol Food");
  assert.deepEqual([...r.follow.ids].sort(), [b.id, c.id].sort());
  for (const e of [a, b, c]) assert.equal(cat(rt, e.id), "cat-food");
  assert.equal(cat(rt, other.id), "");
  assert.equal(cat(rt, keep.id), "cat-fun");
  assert.equal(cat(rt, pending.id), "");
});

test("a merchant already split between categories is left alone", () => {
  const rt = setup();
  entry(rt, { category_id: "cat-fun" }); entry(rt, { category_id: "cat-fun" });
  const blank = entry(rt), chosen = entry(rt);
  const r = rt.api("updateEntry", { id: chosen.id, fields: { category_id: "cat-food" } });
  assert.equal(r.follow, undefined);
  assert.equal(cat(rt, blank.id), "");
});

test("the filled entries are stamped so phones pick them up, and Undo puts them back", () => {
  const rt = setup();
  const a = entry(rt), b = entry(rt);
  const r = rt.api("updateEntry", { id: a.id, fields: { category_id: "cat-food" } });
  assert.ok(rt.rows("Entries").find((e) => e.id === b.id).updated_at);
  // The person changes b by hand afterwards: Undo must not touch it.
  rt.api("updateEntry", { id: b.id, fields: { category_id: "cat-fun" } });
  const u = rt.api("undoCategoryFollow", { changes: [{ categoryId: r.follow.categoryId, ids: r.follow.ids }], annualIds: r.follow.annualIds });
  assert.equal(u.reverted, 0);
  assert.equal(cat(rt, b.id), "cat-fun");
});

test("Undo clears the entries that still carry the followed category", () => {
  const rt = setup();
  const a = entry(rt), b = entry(rt), c = entry(rt);
  const r = rt.api("updateEntry", { id: a.id, fields: { category_id: "cat-food" } });
  const u = rt.api("undoCategoryFollow", { changes: [{ categoryId: r.follow.categoryId, ids: r.follow.ids }], annualIds: r.follow.annualIds });
  assert.equal(u.reverted, 2);
  assert.equal(cat(rt, b.id), ""); assert.equal(cat(rt, c.id), "");
  assert.equal(cat(rt, a.id), "cat-food");   // the entry the person chose for stays
});

test("a manual entry lines up with a bank merchant through its description", () => {
  const rt = setup();
  const manual = entry(rt, { source: "manual", merchant: "", description: "Rappi Peru" });
  const imported = entry(rt);
  const r = rt.api("updateEntry", { id: manual.id, fields: { category_id: "cat-food" } });
  assert.equal(r.follow.count, 1);
  assert.equal(cat(rt, imported.id), "cat-food");
});

test("Tidy my history groups blanks by merchant, biggest first, with a suggestion only when history agrees", () => {
  const rt = setup();
  entry(rt, { amount: 10 }); entry(rt, { amount: 10 });
  entry(rt, { merchant: "wong", description: "WONG", amount: 300 });
  entry(rt, { merchant: "uber", description: "UBER", amount: 5, category_id: "cat-fun" });
  entry(rt, { merchant: "uber", description: "UBER", amount: 5 });
  entry(rt, { type: "income", merchant: "salary", description: "SALARY", amount: 5000 });   // income is not part of this
  const t = rt.api("listTidyGroups", {});
  assert.equal(t.totalEntries, 4);
  assert.deepEqual(t.groups.map((g) => g.key), ["wong", "rappi peru", "uber"]);
  assert.equal(t.groups[1].count, 2);
  assert.equal(t.groups[1].totalMain, 20);
  assert.equal(t.groups[1].suggestion, null);
  assert.equal(t.groups[2].suggestion.categoryId, "cat-fun");
  assert.equal(t.groups[1].samples.length, 2);
});

test("applying a choice per group fills only what is still blank and can be undone", () => {
  const rt = setup();
  const a = entry(rt), b = entry(rt);
  const w = entry(rt, { merchant: "wong", description: "WONG" });
  const r = rt.api("applyTidyGroups", { items: [{ key: "rappi peru", categoryId: "cat-food" }, { key: "wong", categoryId: "cat-fun" }] });
  assert.equal(r.count, 3);
  assert.equal(cat(rt, a.id), "cat-food"); assert.equal(cat(rt, w.id), "cat-fun");
  // a second tap changes nothing
  assert.equal(rt.api("applyTidyGroups", { items: [{ key: "rappi peru", categoryId: "cat-fun" }] }).count, 0);
  assert.equal(cat(rt, b.id), "cat-food");
  const u = rt.api("undoCategoryFollow", { changes: r.changes, annualIds: r.annualIds });
  assert.equal(u.reverted, 3);
  assert.equal(rt.api("listTidyGroups", {}).totalEntries, 3);
});

test("an income category is refused for an expense group", () => {
  const rt = setup();
  entry(rt);
  assert.throws(() => rt.api("applyTidyGroups", { items: [{ key: "rappi peru", categoryId: "cat-pay" }] }));
});

test("moving a whole group into Travel tags it Annual, and Undo removes those tags", () => {
  const rt = setup();
  rt.run(`appendRowObject('Categories', { id: 'cat-travel', name: 'Travel', type: 'expense', icon: '', color: '#ccc', parent_id: '', key: 'travel' });`);
  const a = entry(rt), b = entry(rt);
  const annual = () => rt.rows("Entry Tags").filter((t) => t.tag_id === "system-annual").map((t) => t.entry_id);
  const r = rt.api("applyTidyGroups", { items: [{ key: "rappi peru", categoryId: "cat-travel" }] });
  assert.deepEqual(annual().sort(), [a.id, b.id].sort());
  rt.api("undoCategoryFollow", { changes: r.changes, annualIds: r.annualIds });
  assert.deepEqual(annual(), []);
});

test("a new expense saved with no category takes the merchant's history, or stays blank", () => {
  const rt = setup();
  entry(rt, { category_id: "cat-food", source: "manual", merchant: "", description: "Rappi Peru" });
  const guessed = rt.api("createEntry", { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: "", description: "Rappi Peru", payment_method_id: "", paid_by: "me" });
  assert.equal(guessed.category_id, "cat-food");
  assert.equal(guessed.guessed_category_name, "Fol Food");
  const none = rt.api("createEntry", { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: "", description: "Something new", payment_method_id: "", paid_by: "me" });
  assert.equal(none.category_id, "");
  assert.equal(cat(rt, none.id), "");
});

test("a category the person picks is never replaced by the guess", () => {
  const rt = setup();
  entry(rt, { category_id: "cat-food", source: "manual", merchant: "", description: "Rappi Peru" });
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 12, currency: "PEN", category_id: "cat-fun", description: "Rappi Peru", payment_method_id: "", paid_by: "me" });
  assert.equal(e.category_id, "cat-fun");
});

// ---- Entries made by Fill my history are the ones Tidy my history is for ----
test("what Fill my history adds shows up in Tidy my history by merchant, and categorizing one purchase files the rest", () => {
  const { rt, data } = freshApp({ entries: 20 });
  const savings = data.pms.find((p) => p.type === "debit");
  const food = data.cats.find((c) => c.type === "expense");
  const stmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "s.pdf",
    lines: [
      { date: "2019-03-05", description: "COMPRA BODEGA LA ESQUINA", amount: -23.47, currency: "PEN" },
      { date: "2019-03-12", description: "COMPRA BODEGA LA ESQUINA", amount: -11.2, currency: "PEN" },
      { date: "2019-03-14", description: "COMPRA FARMACIA SUR", amount: -40.1, currency: "PEN" }
    ]
  };
  const plan = JSON.parse(rt.run(`JSON.stringify(planStatementHistory(${JSON.stringify({ statements: [stmt] })}))`));
  rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "history", statements: [stmt], actions: plan.actions })})`);
  const tidy = rt.api("listTidyGroups", {});
  const bodega = tidy.groups.find((g) => /bodega/.test(g.key));
  assert.ok(bodega, "the bank wording became a merchant group");
  assert.equal(bodega.count, 2);
  const firstBlank = rt.rows("Entries").filter((e) => e.source === "import" && /bodega/i.test(e.description) && !e.category_id)[0];
  const r = rt.api("updateEntry", { id: firstBlank.id, fields: { category_id: food.id } });
  assert.equal(r.follow.count, 1, "the other bodega purchase follows; the pharmacy does not");
  assert.ok(rt.api("listTidyGroups", {}).groups.every((g) => !/bodega/.test(g.key)));
  assert.ok(rt.api("listTidyGroups", {}).groups.some((g) => /farmacia/.test(g.key)));
});
