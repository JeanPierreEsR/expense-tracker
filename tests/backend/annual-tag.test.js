// The built-in "Annual" tag (2026-10-14): it only CLEANS the monthly picture.
//  - Projections: an Annual-tagged expense is left out of the category's monthly
//    rate (the year-to-date pool); nothing is projected in its place.
//  - Budgets: a MONTHLY budget doesn't count it, a YEARLY one does.
//  - The tag exists on its own, is shown "Anual" in Spanish, and typing
//    "annual"/"anual" as a new tag never makes a second one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, lastDayOfMonth } = require("./helpers");

const post = (rt, action, payload = {}, lang) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload, ...(lang ? { lang } : {}) }));
const year = new Date().getFullYear();
const monthsElapsed = new Date().getMonth();   // complete months before this one
const needsHistory = monthsElapsed < 1 ? "no complete month yet this year" : false;

// A brand-new expense category, so only the entries below feed its figures.
function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: 'cat-annual-test', name: 'Car test', type: 'expense', icon: '🚗', color: '#ccc', parent_id: '' });`);
  return rt;
}
function addEntry(rt, id, date, amount, annual) {
  rt.run(`appendRowObject('Entries', { id: ${JSON.stringify(id)}, type: 'expense', date: ${JSON.stringify(date)}, amount: ${amount}, currency: 'PEN', category_id: 'cat-annual-test', description: ${JSON.stringify(id)}, paid_by: 'me', status: 'confirmed', source: 'manual' });`);
  if (annual) rt.run(`appendRowObject('Entry Tags', { entry_id: ${JSON.stringify(id)}, tag_id: ANNUAL_TAG_ID });`);
}
// A date `k` months before the backend's current month (inside the 12-month window the
// projection's level is learned from; a category's first-ever entry is placed years back
// so the whole window counts).
const ago = (k, day) => {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};
const projection = (rt, displayPeriodType = "month") =>
  rt.api("listCategoryProjections", { displayPeriodType }).categories.find((c) => c.category_id === "cat-annual-test");

test("the Annual tag exists once, English 'Annual' / Spanish 'Anual', and a new one with that name is the same tag", () => {
  const { rt } = freshApp({ entries: 50 });
  const tagsIn = (lang) => post(rt, "getMeta", {}, lang).data.tags;
  assert.equal(tagsIn("en").filter((t) => t.id === "system-annual").length, 1);
  assert.equal(tagsIn("en").find((t) => t.id === "system-annual").name, "Annual");
  assert.equal(tagsIn("es").find((t) => t.id === "system-annual").name, "Anual");
  tagsIn("en");   // a second getMeta must not add another
  assert.equal(rt.rows("Tags").filter((t) => t.id === "system-annual").length, 1);
  assert.equal(rt.rows("Tags").find((t) => t.id === "system-annual").name, "Annual", "stored in English");
  ["anual", "Annual", " ANUAL "].forEach((name) => assert.equal(post(rt, "addTag", { name }, "es").data.id, "system-annual"));
  assert.equal(rt.rows("Tags").filter((t) => /^(annual|anual)$/i.test(t.name)).length, 1);
  assert.notEqual(post(rt, "addTag", { name: "Extra tag" }).data.id, "system-annual", "other names still create their own tag");
});

test("searching finds an Annual-tagged entry by either name", () => {
  const rt = setup();
  post(rt, "getMeta", {});   // the app always loads this first; it creates the tag
  addEntry(rt, "e-annual", today(), 700, true);
  addEntry(rt, "e-plain", today(), 40, false);
  const found = (search) => rt.api("listEntries", { search, categoryId: "cat-annual-test" }).map((e) => e.id);
  assert.deepEqual(found("anual"), ["e-annual"]);
  assert.deepEqual(found("annual"), ["e-annual"]);
});

test("projections: an Annual-tagged expense is left out of the monthly rate, and nothing replaces it", { skip: lastDayOfMonth }, () => {
  const rt = setup();
  addEntry(rt, "e-first", ago(36, 1), 1, false);               // the category already existed long before the window
  addEntry(rt, "e-gas", ago(2, 10), 100, false);
  addEntry(rt, "e-service", ago(2, 20), 1200, true);           // car maintenance, tagged Annual
  const m = projection(rt);
  assert.ok(Math.abs(m.ratePerMonth - 100 / 12) < 0.001, "rate = only the untagged 100 over the 12-month window");
  const y = projection(rt, "year");
  assert.ok(Math.abs(y.baseAmountPen - 100) < 0.001, "the year view uses the same rate x 12 — no extra for the tagged one");
  // Without the tag the same expense would have inflated the rate.
  rt.run(`deleteRowsWhere_('Entry Tags', function (r) { return r.entry_id === 'e-service'; });`);
  assert.ok(Math.abs(projection(rt).ratePerMonth - 1300 / 12) < 0.001);
});

test("projections: a Month view leaves an Annual-tagged expense out of Actual (reported aside); a Year view counts it; the trace reports it", { skip: lastDayOfMonth }, () => {
  const rt = setup();
  addEntry(rt, "e-first", ago(36, 1), 1, false);
  addEntry(rt, "e-gas", ago(2, 10), 100, false);
  addEntry(rt, "e-service", ago(2, 20), 1200, true);
  addEntry(rt, "e-today", today(), 900, true);
  const m = projection(rt);
  assert.equal(m.actualPen, 0, "a Month view leaves the tagged 900 out of Actual, like a monthly budget");
  assert.equal(m.annualInPeriodPen, 900, "and reports it aside");
  assert.ok(projection(rt, "year").actualPen >= 900, "a Year view counts it (a yearly budget does too)");
  assert.equal(projection(rt, "year").annualInPeriodPen, 0);
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: "cat-annual-test", displayPeriodType: "month" });
  assert.equal(detail.dailyActualPen[today()], undefined, "the chart's solid line leaves it out too");
  assert.equal(detail.ytdBreakdown.annualExcludedPen, 1200, "over the window, the tagged 1200 is reported as left out");
  assert.equal(detail.ytdBreakdown.annualExcludedCount, 1);
  assert.ok(Math.abs(detail.ytdBreakdown.totalPen - 100) < 0.001);
  assert.equal(detail.ytdBreakdown.months.length, 12, "one row per month of the window");
  assert.ok(detail.ytdBreakdown.months.every((x) => x.amountPen === 0 || x.amountPen === 100));
});

test("a programmed (recurring) item is still projected, tag or no tag", () => {
  const rt = setup();
  addEntry(rt, "e-first", ago(36, 1), 1, false);
  addEntry(rt, "e-service", ago(2, 20), 1200, true);
  rt.api("addRecurringExpense", { category_id: "cat-annual-test", description: "Car insurance", amount: 260, currency: "PEN", frequency: "monthly", day: 28 });
  const m = projection(rt);
  assert.equal(m.recurringAmountPen, 260);
  assert.equal(m.ratePerMonth, 0, "the tagged service adds nothing to the variable rate");
});

test("budgets: a monthly budget doesn't count Annual-tagged expenses; a yearly one does", () => {
  const rt = setup();
  addEntry(rt, "e-plain", today(), 200, false);
  addEntry(rt, "e-annual", today(), 800, true);
  rt.api("addBudget", { category_id: "cat-annual-test", amount: 1000, currency: "PEN", period_type: "monthly" });
  const budgets = () => rt.api("listBudgets", { displayPeriodType: "month" }).budgets || rt.api("listBudgets", { displayPeriodType: "month" });
  const mine = (list, period) => list.find((b) => b.category_id === "cat-annual-test" && b.period_type === period);
  assert.equal(mine(budgets(), "monthly").progress.spentPen, 200);
  assert.equal(mine(budgets(), "monthly").progress.spent, 200);
  // browsed by year, a monthly budget is still a monthly budget
  const byYear = rt.api("listBudgets", { displayPeriodType: "year" });
  assert.equal(mine(byYear.budgets || byYear, "monthly").progress.spentPen, 200);
  // a yearly budget on the same category counts everything
  rt.api("addBudget", { category_id: "cat-annual-test", amount: 6000, currency: "PEN", period_type: "yearly" });
  assert.equal(mine(budgets(), "yearly").progress.spentPen, 1000);
  assert.equal(mine(budgets(), "monthly").progress.spentPen, 200, "adding the yearly one changes nothing for the monthly one");
});

test("budgets: the drill-down list and the chart agree with a monthly budget's figure", () => {
  const rt = setup();
  addEntry(rt, "e-plain", today(), 200, false);
  addEntry(rt, "e-annual", today(), 800, true);
  const created = rt.api("addBudget", { category_id: "cat-annual-test", amount: 1000, currency: "PEN", period_type: "monthly" });
  const start = today().slice(0, 8) + "01", end = today().slice(0, 8) + "31";
  const listed = rt.api("listEntries", { startDate: start, endDate: end, type: "expense", categoryIds: ["cat-annual-test"], excludeAnnual: true });
  assert.deepEqual(listed.map((e) => e.id), ["e-plain"]);
  const all = rt.api("listEntries", { startDate: start, endDate: end, type: "expense", categoryIds: ["cat-annual-test"] });
  assert.equal(all.length, 2, "without the flag (a yearly budget) both show");
  const chart = rt.api("getBudgetChartSeries", { budgetId: created.id, startDate: start, endDate: end, periodType: "monthly" });
  assert.equal(Object.values(chart.dailySpend).reduce((a, b) => a + b, 0), 200);
});

test("suggested monthly budgets ignore Annual-tagged expenses", () => {
  const rt = setup();
  addEntry(rt, "e-plain", `${year}-01-10`, 120, false);
  addEntry(rt, "e-annual", `${year}-01-12`, 1200, true);
  const avg = rt.run(`computeCategoryMonthlyAverages_('${year}-01-01', '${year}-01-31', 1)`);
  assert.equal(avg["cat-annual-test"], 120);
});

test("Telegram: the Annual tag is found by either name and shown translated", () => {
  const { rt } = freshApp({ entries: 50 });
  post(rt, "getMeta", {});   // creates the tag
  assert.equal(rt.run("fuzzyFindTag_('anual').id"), "system-annual");
  assert.equal(rt.run("fuzzyFindTag_('annual').id"), "system-annual");
});
