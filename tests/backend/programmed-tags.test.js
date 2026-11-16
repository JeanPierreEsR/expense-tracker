// Tags on Programmed items (owner, 2026-11-16; specs/recurring.md § Tags):
//  - an item keeps its tags (tag_ids); a deleted tag goes from the items too;
//  - an item tagged Annual counts like an annual expense: out of monthly budgets and a Projections month view, in yearly budgets and
//    "Annual expenses";
//  - a payment saved or confirmed that matches an item with tags it lacks brings a question (tag_ask / tag_asks); "Add tags" only adds;
//  - "Mark as paid → pick an entry" adds the item's tags; "Record the payment…" does not (the form carried them);
//  - existing items repeating every 3 months or more are listed once (annualItemsAsk) and tagged on the answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freshApp, today, lastDayOfMonth } = require("./helpers");

const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const STRINGS = require(path.join(__dirname, "../../docs/strings.js"));
const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-pt', name: 'Car test', type: 'expense', icon: '🚗', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-pt-inc', name: 'Bonus test', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  post(rt, "getMeta", {});   // creates the Annual tag (after the categories: it caches them)
  const sport = rt.api("addTag", { name: "Sport" });
  return { rt, sport };
}
const item = (rt, fields) => rt.api("addRecurringExpense", Object.assign({ category_id: "cat-pt", description: "Gym", amount: 120, currency: "PEN", frequency: "monthly", day: 31 }, fields));
const listed = (rt, id) => rt.api("listRecurringExpenses", {}).find((r) => r.id === id);
const tagsOf = (rt, entryId) => rt.rows("Entry Tags").filter((t) => t.entry_id === entryId).map((t) => t.tag_id).sort();

test("an item keeps its tags; unknown ids are dropped; an update replaces them; a deleted tag leaves the item", () => {
  const { rt, sport } = setup();
  const it = item(rt, { tag_ids: [sport.id, "nope", sport.id] });
  assert.deepEqual(listed(rt, it.id).tag_ids, [sport.id]);
  rt.api("updateRecurringExpense", { id: it.id, tag_ids: ["system-annual", sport.id] });
  assert.deepEqual(listed(rt, it.id).tag_ids, ["system-annual", sport.id]);
  assert.equal(rt.api("getTagCounts", {}).items[sport.id], 1, "the tag list knows how many items carry it");
  const del = rt.api("deleteTag", { id: sport.id });
  assert.equal(del.items, 1);
  assert.deepEqual(listed(rt, it.id).tag_ids, ["system-annual"]);
  assert.equal(rt.rows("Recurring Expenses").find((r) => r.id === it.id).tag_ids, "system-annual");
});

test("budgets: an Annual item's planned amount leaves the monthly budget and counts in the yearly and Annual expenses ones", { skip: lastDayOfMonth }, () => {
  const { rt } = setup();
  const monthly = rt.api("addBudget", { category_id: "cat-pt", amount: 1000, currency: "PEN", period_type: "monthly", start: "always" });
  const yearly = rt.api("addBudget", { category_id: "cat-pt", amount: 9000, currency: "PEN", period_type: "yearly", start: "always" });
  const annual = rt.api("addBudget", { category_id: "ANNUAL", amount: 9000, currency: "PEN", period_type: "yearly", start: "always" });
  const it = item(rt, {});
  const prog = (id, period) => { const l = rt.api("listBudgets", { displayPeriodType: period }); return (l.budgets || l).find((b) => b.id === id).progress.programmed; };
  assert.equal(prog(monthly.id, "month"), 120, "untagged: in the monthly budget");
  assert.equal(prog(annual.id, "year") || 0, 0, "untagged: not annual");
  rt.api("updateRecurringExpense", { id: it.id, tag_ids: ["system-annual"] });
  assert.equal(prog(monthly.id, "month") || 0, 0, "tagged Annual: out of the monthly budget");
  assert.ok(prog(yearly.id, "year") >= 120, "in the yearly budget of its category");
  assert.ok(prog(annual.id, "year") >= 120, "and in Annual expenses");
  const start = today().slice(0, 8) + "01", end = today().slice(0, 8) + "31";
  const chart = (id) => rt.api("getBudgetChartSeries", { budgetId: id, startDate: start, endDate: end, periodType: "monthly" }).recurringOccurrences.length;
  assert.equal(chart(monthly.id), 0, "the monthly budget's chart agrees");
});

test("projections: a month view leaves an Annual item out of Programmed; a year view counts it", { skip: lastDayOfMonth }, () => {
  const { rt } = setup();
  rt.run(`appendRowObject('Entries', { id: 'e-pt-old', type: 'expense', date: '${today().slice(0, 8)}01', amount: 1, currency: 'PEN', category_id: 'cat-pt', description: 'old', paid_by: 'me', status: 'confirmed', source: 'manual' });`);
  const it = item(rt, { tag_ids: ["system-annual"] });
  const proj = (p) => rt.api("listCategoryProjections", { displayPeriodType: p }).categories.find((c) => c.category_id === "cat-pt");
  assert.equal(proj("month").programmedRemainingPen, 0);
  assert.ok(proj("year").programmedRemainingPen >= 120);
  rt.api("updateRecurringExpense", { id: it.id, tag_ids: [] });
  assert.equal(proj("month").programmedRemainingPen, 120);
});

test("a matching payment saved or confirmed asks for the item's tags; Add tags only adds; the pick in Mark as paid adds them", () => {
  const { rt, sport } = setup();
  const d = today();
  const it = item(rt, { day: Number(d.slice(8, 10)), tag_ids: [sport.id, "system-annual"] });
  const saved = rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date: d, amount: 118, currency: "PEN", category_id: "cat-pt", description: "Shoes", paid_by: "me" } });
  assert.ok(saved.tag_ask, "same category, ~10% amount, on the due date: a question");
  assert.equal(saved.tag_ask.item_id, it.id);
  assert.deepEqual(saved.tag_ask.tag_ids.slice().sort(), [sport.id, "system-annual"].sort());
  assert.deepEqual(tagsOf(rt, saved.id), [], "nothing is written before the answer");
  rt.api("addEntriesTags", { items: [{ entry_id: saved.id, tag_ids: saved.tag_ask.tag_ids }] });
  rt.api("addEntriesTags", { items: [{ entry_id: saved.id, tag_ids: saved.tag_ask.tag_ids }] });   // twice is harmless
  assert.deepEqual(tagsOf(rt, saved.id), [sport.id, "system-annual"].sort());
  // A far amount: no question.
  const far = rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date: d, amount: 40, currency: "PEN", category_id: "cat-pt", description: "Socks", paid_by: "me" } });
  assert.equal(far.tag_ask, undefined);
  // Mark as paid → pick an entry: the tags come with the link.
  rt.api("linkEntryToRecurring", { entryId: far.id, recurringExpenseId: it.id });
  assert.deepEqual(tagsOf(rt, far.id), [sport.id, "system-annual"].sort());
  // Record the payment…: the form carried the tags; the person removed one, so the link must not put it back.
  const rec = rt.api("saveEntryAll", { kind: "create", link_recurring_id: it.id, fields: { type: "expense", date: d, amount: 120, currency: "PEN", category_id: "cat-pt", description: "Gym", paid_by: "me", tag_ids: [sport.id] } });
  assert.deepEqual(tagsOf(rt, rec.id), [sport.id]);
  assert.equal(rec.tag_ask, undefined);
});

test("existing items repeating every 3 months or more are listed once and tagged Annual on the answer", () => {
  const { rt } = setup();
  const yearly = item(rt, { description: "Insurance", frequency: "yearly", day: 5, month: 3 });
  const quarterly = item(rt, { description: "Service", frequency: "custom", interval: 3, interval_unit: "months", start_date: today() });
  const monthly = item(rt, { description: "Gym" });
  item(rt, { category_id: "cat-pt-inc", description: "Bonus", frequency: "yearly", day: 5, month: 12 });
  const mine = [yearly.id, quarterly.id, monthly.id];
  const ask = post(rt, "getMeta", {}).data.annualItemsAsk.map((x) => x.id).filter((id) => mine.includes(id)).sort();
  assert.deepEqual(ask, [yearly.id, quarterly.id].sort(), "expenses only, every 3 months or more (the bonus is income)");
  assert.ok(!post(rt, "getMeta", {}).data.annualItemsAsk.some((x) => x.description === "Bonus"));
  assert.ok(rt.api("answerAnnualItems", { apply: true }).tagged >= 2);
  assert.deepEqual(listed(rt, yearly.id).tag_ids, ["system-annual"]);
  assert.deepEqual(listed(rt, quarterly.id).tag_ids, ["system-annual"]);
  assert.deepEqual(listed(rt, monthly.id).tag_ids, []);
  assert.deepEqual(post(rt, "getMeta", {}).data.annualItemsAsk, [], "asked once");
});

test("the app: the form's chips, the Annual pre-tick and its alert, pills, the questions, both languages", () => {
  for (const k of ["recTags.annualHint", "recTags.annualAsk", "recTags.keepAnnual", "recTags.removeAnnual", "progTags.askOne", "progTags.askMany", "progTags.line",
    "progTags.add", "progTags.no", "progTags.annualItemsAsk", "progTags.annualItemsYes", "progTags.annualItemsNo", "progTags.annualItemsLater", "tagsScreen.deleteAskItems"])
    assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
  assert.match(app, /if \(programmedTagsOn_\(\)\) fields\.tag_ids = \[\.\.\.recurringTagIds_\]/);
  assert.match(app, /unit === "years" \|\| \(unit === "months" && n >= 3\) \|\| \(unit === "weeks" && n >= 13\) \|\| \(unit === "days" && n >= 90\)/);
  assert.match(app, /askConfirmApp_\(tr\("recTags\.annualAsk"/);
  assert.match(app, /out\.tag_ask\) askProgrammedTags_/);
  assert.match(app, /result\.tag_asks\.length\) askProgrammedTags_/);
  assert.match(app, /tagIds: \(item\.tag_ids \|\| \[\]\)\.slice\(\)/, "Record the payment… starts with the item's tags");
});
