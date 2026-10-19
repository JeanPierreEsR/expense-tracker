// Projection methods (2026-10-19): the owner picks what predicts his expenses
// best — six presets + custom, a default, a choice per category, "apply to all",
// and "which would have worked best for you" (a replay of the last 12 months).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const A = "cat-pm-a", B = "cat-pm-b";
const [thisYear, thisMonth] = today().split("-").map(Number);

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  [A, B].forEach((id) => rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(id)}, name: ${JSON.stringify("Method " + id)}, type: 'expense', icon: '🧪', color: '#ccc', parent_id: '' });`));
  return { rt, data };
}
let seq = 0;
function addEntry(rt, category, date, amount, description = "spend") {
  const id = "e-pm-" + ++seq;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date, amount, currency: "PEN", category_id: category, description, paid_by: "me", status: "confirmed", source: "manual" })});`);
  return id;
}
// A date `k` complete months before the backend's current month.
function ago(k, day = 10) {
  const d = new Date(Date.UTC(thisYear, thisMonth - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
// One entry a month for the last `months` complete months: amount(k) with k = 1 for last month.
function series(rt, category, months, amount) {
  for (let k = months; k >= 1; k--) addEntry(rt, category, ago(k), amount(k));
}
const projection = (rt, id, displayPeriodType = "month") =>
  rt.api("listCategoryProjections", { displayPeriodType }).categories.find((c) => c.category_id === id);
const compare = (rt, categoryId) => rt.api("compareProjectionMethods", categoryId ? { categoryId } : {});
const errorOf = (cat, id) => cat.methods.find((m) => m.id === id).errorPct;

test("the default is Balanced, and every preset or a valid custom is accepted; anything else is refused", () => {
  const { rt } = setup();
  assert.equal(rt.api("getProjectionMethodSettings").defaultMethod, "balanced");
  ["balanced", "steady", "recent", "seasonal", "last_year", "ytd", "custom:6:2", "custom:24:5", "custom:3:0"].forEach((m) => {
    assert.equal(rt.api("setProjectionMethod", { method: m }).defaultMethod, m);
  });
  ["", "fast", "custom:5:2", "custom:6:4", "custom:6", "balanced "].slice(0, 5).forEach((m) => {
    assert.throws(() => rt.api("setProjectionMethod", { method: m }), /isn't available/i, m);
  });
  assert.throws(() => rt.api("setProjectionMethod", { categoryId: A, method: "nope" }), /isn't available/i);
});

test("a method changes what Expected is built from: Recent looks 3 months back, Steady 12", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(30), 1, "first ever");
  series(rt, A, 12, (k) => (k <= 3 ? 300 : 100));       // the last 3 months at 300, the 9 before at 100
  rt.api("setProjectionMethod", { method: "steady" });
  assert.ok(Math.abs(projection(rt, A).ratePerMonth - 150) < 1e-9, "(3 x 300 + 9 x 100) / 12");
  rt.api("setProjectionMethod", { method: "recent" });
  const p = projection(rt, A);
  assert.ok(Math.abs(p.ratePerMonth - 300) < 1e-9);
  assert.equal(p.method, "recent");
  assert.equal(p.methodIsOwn, false, "it is the default, not this category's own choice");
});

test("a category can have its own method; 'apply to all' replaces every choice and sets the default", () => {
  const { rt } = setup();
  [A, B].forEach((c) => { addEntry(rt, c, ago(30), 1, "first ever"); series(rt, c, 12, (k) => (k <= 3 ? 300 : 100)); });
  rt.api("setProjectionMethod", { method: "steady" });
  rt.api("setProjectionMethod", { categoryId: A, method: "recent" });
  assert.equal(projection(rt, A).ratePerMonth, 300);
  assert.equal(projection(rt, A).methodIsOwn, true);
  assert.equal(projection(rt, B).ratePerMonth, 150, "the other category keeps the default");
  assert.deepEqual(rt.api("getProjectionMethodSettings").overrides, { [A]: "recent" });

  rt.api("setProjectionMethod", { categoryId: A, method: "" });   // back to the default
  assert.equal(projection(rt, A).ratePerMonth, 150);

  rt.api("setProjectionMethod", { categoryId: A, method: "recent" });
  const after = rt.api("applyProjectionMethodToAll", { method: "ytd" });
  assert.equal(after.defaultMethod, "ytd");
  assert.deepEqual(after.overrides, {}, "every category's own choice is cleared");
  assert.equal(projection(rt, A).method, "ytd");
  assert.equal(projection(rt, B).method, "ytd");
});

test("'This year so far' uses this year's complete months; in January it looks back 12 months instead", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(40), 1, "first ever");
  series(rt, A, 24, (k) => (k <= thisMonth - 1 ? 500 : 100));   // this year's complete months at 500, the rest at 100
  rt.api("setProjectionMethod", { method: "ytd" });
  const p = projection(rt, A);
  if (thisMonth > 1) assert.ok(Math.abs(p.ratePerMonth - 500) < 1e-9, "only this year's months");
  else assert.ok(p.ratePerMonth > 0, "January: no month of this year yet, so 12 months back");
});

test("custom:<months>:<years> looks back that many complete months", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(40), 1, "first ever");
  series(rt, A, 24, (k) => (k <= 6 ? 200 : 100));
  rt.api("setProjectionMethod", { method: "custom:6:0" });
  assert.ok(Math.abs(projection(rt, A).ratePerMonth - 200) < 1e-9);
  rt.api("setProjectionMethod", { method: "custom:24:0" });
  assert.ok(Math.abs(projection(rt, A).ratePerMonth - 125) < 1e-9, "(6 x 200 + 18 x 100) / 24");
});

test("'Same month last year' copies each month of the previous calendar year", () => {
  const { rt } = setup();
  addEntry(rt, A, `${thisYear - 2}-06-01`, 1, "first ever");
  for (let m = 1; m <= 12; m++) addEntry(rt, A, `${thisYear - 1}-${String(m).padStart(2, "0")}-10`, m * 10);
  rt.api("setProjectionMethod", { method: "last_year" });
  const month = projection(rt, A, "month");
  assert.equal(month.methodUsed, "last_year");
  assert.equal(month.lastYearYear, thisYear - 1);
  assert.equal(month.baseAmountPen, thisMonth * 10, "this month's base = the same month of last year");
  const year = projection(rt, A, "year");
  assert.equal(year.baseAmountPen, 780, "the whole year = last year's total (10 + 20 + ... + 120)");
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: A, displayPeriodType: "month" });
  assert.equal(detail.ytdBreakdown.months.length, 12, "the trace lists last year's 12 months");
  assert.equal(detail.ytdBreakdown.method, "last_year");
});

test("'Same month last year' falls back to Balanced, and says so, when there is no previous year", () => {
  const { rt } = setup();
  series(rt, A, 6, () => 100);        // the category began 6 months ago
  rt.api("setProjectionMethod", { method: "last_year" });
  const p = projection(rt, A);
  assert.equal(p.method, "last_year");
  assert.equal(p.methodUsed, "balanced");
  assert.equal(p.methodFallback, "last_year_history");
});

// ---- which would have worked best -------------------------------------------------------------------------
test("a step change in spending: Recent would have worked better than Steady, and it is the best", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(31), 1, "first ever");
  series(rt, A, 30, (k) => (k <= 6 ? 300 : 100));       // 100 a month, then 300 for the last 6
  const r = compare(rt, A);
  const cat = r.categories[0];
  assert.equal(cat.enough, true);
  assert.ok(errorOf(cat, "recent") < errorOf(cat, "steady"), "recent adapts, steady lags");
  assert.equal(cat.best, "recent");
  assert.equal(cat.current, "balanced");
  assert.ok(cat.gain >= 0.05, "by a clear margin");
  assert.ok(cat.methods.every((m) => m.months >= 6 || m.id === "last_year"), "every method was replayed over the last 12 months");
});

test("a flat category: every method is about as good, so nothing changes", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(31), 1, "first ever");
  series(rt, A, 30, () => 100);
  const cat = compare(rt, A).categories[0];
  assert.equal(cat.best, "balanced", "a tie goes to what is already in use");
  cat.methods.filter((m) => m.errorPct != null).forEach((m) => assert.ok(m.errorPct < 0.01, m.id));
});

test("a seasonal category: a method with the time of year beats one without it", () => {
  const { rt } = setup();
  addEntry(rt, A, `${thisYear - 5}-01-10`, 1, "first ever");
  for (let y = thisYear - 4; y <= thisYear; y++) {
    for (let m = 1; m <= 12; m++) {
      const key = `${y}-${String(m).padStart(2, "0")}-10`;
      if (key >= ago(0, 1)) continue;                       // only complete months
      addEntry(rt, A, key, m === 12 ? 400 : 100);
    }
  }
  const cat = compare(rt, A).categories[0];
  assert.ok(errorOf(cat, "balanced") < errorOf(cat, "steady"), "December is predictable from past Decembers");
  assert.ok(errorOf(cat, "seasonal") <= errorOf(cat, "steady"));
});

test("not enough history: no recommendation", () => {
  const { rt } = setup();
  series(rt, A, 3, () => 100);
  const cat = compare(rt, A).categories[0];
  assert.equal(cat.enough, false);
  assert.equal(cat.best, null);
});

test("comparing every category gives an overall picture; 'use the best for each' only changes those that gain 5 points or more", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(31), 1, "first ever");
  series(rt, A, 30, (k) => (k <= 6 ? 300 : 100));        // step change: Recent is clearly better
  addEntry(rt, B, ago(31), 1, "first ever");
  series(rt, B, 30, () => 100);                            // flat: nothing to gain
  const all = compare(rt);
  assert.ok(all.categories.some((c) => c.category_id === A) && all.categories.some((c) => c.category_id === B));
  assert.ok(all.overall.length >= 5 && all.overall.every((o) => o.errorPct != null));
  const result = rt.api("applyBestProjectionMethods");
  assert.ok(result.changed.some((c) => c.category_id === A && c.to === "recent"));
  assert.ok(!result.changed.some((c) => c.category_id === B), "the flat category is left alone");
  assert.equal(result.settings.overrides[A], "recent");
  assert.equal(result.settings.overrides[B], undefined);
  assert.equal(projection(rt, A).method, "recent");
  // And a second run has nothing left to change.
  assert.ok(!rt.api("applyBestProjectionMethods").changed.some((c) => c.category_id === A));
});

test("budgets use the same method as projections", () => {
  const { rt } = setup();
  addEntry(rt, A, ago(40), 1, "first ever");
  series(rt, A, 24, (k) => (k <= 3 ? 300 : 100));
  rt.api("setProjectionMethod", { categoryId: A, method: "recent" });
  const budget = rt.api("addBudget", { category_id: A, amount: 9000, currency: "PEN", period_type: "yearly", thresholds: "100" });
  const chart = rt.api("getBudgetChartSeries", { budgetId: budget.id, startDate: `${thisYear}-01-01`, endDate: `${thisYear}-12-31`, periodType: "yearly" });
  assert.ok(Math.abs(chart.expectedRemaining - projection(rt, A, "year").expectedRemainingPen) < 0.01);
});

test("the monthly series leaves out programmed-item payments and Annual-tagged entries (no method sees them)", () => {
  const { rt } = setup();
  rt.run("ensureAnnualTag_()");
  addEntry(rt, A, ago(40), 1, "first ever");
  series(rt, A, 12, () => 100);
  const big = addEntry(rt, A, ago(2, 20), 5000, "big yearly");
  rt.run(`appendRowObject('Entry Tags', { entry_id: ${JSON.stringify(big)}, tag_id: ANNUAL_TAG_ID });`);
  const s = JSON.parse(rt.run(`JSON.stringify(buildMonthlySeries_([${JSON.stringify(A)}])[${JSON.stringify(A)}])`));
  assert.equal(s.totals[ago(2).slice(0, 7)], 100, "the Annual-tagged 5000 isn't in the month's total");
  assert.equal(s.annual[ago(2).slice(0, 7)].pen, 5000, "it is counted aside, for the trace");
});
