// Seasonality (2026-10-19): "Expected" = level x the time-of-year index of the
// days still to come, the index learned from up to 3 complete past years.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const CAT = "cat-season-test";
const thisYear = new Date().getFullYear();
const monthsElapsed = new Date().getMonth();   // complete months before this one
const needsHistory = monthsElapsed < 1 ? "no complete month yet this year" : false;

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(CAT)}, name: 'Season test', type: 'expense', icon: '🎁', color: '#ccc', parent_id: '' });`);
  return { rt, data };
}
let seq = 0;
function addEntry(rt, date, amount, description = "spend", extra = {}) {
  const id = "e-se-" + ++seq;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date, amount, currency: "PEN", category_id: CAT, description, paid_by: "me", status: "confirmed", source: "manual", ...extra })});`);
  return id;
}
const ymd = (y, m, d = 10) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// Four past years (the oldest only proves the category already existed), the
// three after it follow `monthlyAmount(m)`.
function history(rt, monthlyAmount, years = [thisYear - 3, thisYear - 2, thisYear - 1]) {
  addEntry(rt, ymd(thisYear - 4, 1), 1, "first ever");
  years.forEach((y) => { for (let m = 1; m <= 12; m++) addEntry(rt, ymd(y, m), monthlyAmount(m)); });
}
const profile = (rt) => JSON.parse(rt.run(`JSON.stringify(computeSeasonalProfiles_([${JSON.stringify(CAT)}])[${JSON.stringify(CAT)}])`));
const projection = (rt, displayPeriodType = "month") =>
  rt.api("listCategoryProjections", { displayPeriodType }).categories.find((c) => c.category_id === CAT);
const sum = (a) => a.reduce((x, y) => x + y, 0);

test("a December that is 4x the other months becomes an index of ~2.65, the others ~0.85, averaging exactly 1", () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  const p = profile(rt);
  assert.equal(p.yearsUsed, 3);
  assert.deepEqual(p.years, [thisYear - 1, thisYear - 2, thisYear - 3]);
  // ratio 3.2 / 0.8, pulled toward 1 by weight 3/4: 1 + 0.75 x 2.2 = 2.65 / 1 - 0.75 x 0.2 = 0.85
  assert.ok(Math.abs(p.index[11] - 2.65) < 1e-9);
  assert.ok(p.index.slice(0, 11).every((s) => Math.abs(s - 0.85) < 1e-9));
  assert.ok(Math.abs(sum(p.index) - 12) < 1e-9, "the yearly total never changes, only its shape");
  assert.ok(Math.abs(p.priorLevelPen - 125) < 1e-9, "last year's monthly average: (11 x 100 + 400) / 12");
});

test("a flat category stays flat, and so does one with no usable history", () => {
  const { rt } = setup();
  history(rt, () => 100);
  assert.ok(profile(rt).index.every((s) => Math.abs(s - 1) < 1e-9));
  const fresh = setup().rt;
  addEntry(fresh, ymd(thisYear, 1), 50);
  const none = profile(fresh);
  assert.equal(none.yearsUsed, 0);
  assert.ok(none.index.every((s) => s === 1));
});

test("a year only counts if the category already existed on its January 1st", () => {
  const { rt } = setup();
  for (let m = 9; m <= 12; m++) addEntry(rt, ymd(thisYear - 1, m), m === 12 ? 900 : 100);   // began in September last year
  assert.equal(profile(rt).yearsUsed, 0);
});

test("one lump in one year doesn't distort the shape: the median ignores it", () => {
  const { rt } = setup();
  addEntry(rt, ymd(thisYear - 4, 1), 1, "first ever");
  [thisYear - 3, thisYear - 2].forEach((y) => { for (let m = 1; m <= 12; m++) addEntry(rt, ymd(y, m), 100); });
  for (let m = 1; m <= 12; m++) addEntry(rt, ymd(thisYear - 1, m), m === 3 ? 5100 : 100);
  const p = profile(rt);
  assert.equal(p.yearsUsed, 3);
  assert.ok(p.index.every((s) => Math.abs(s - 1) < 1e-9), "March of one year was 51x, March of the other two normal -> median says normal");
});

test("entries explained by a programmed item are left out of the shape (rent doesn't flatten December)", () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 300 : 0) + 1000);                      // 1000 rent every month, +300 in December
  assert.ok(profile(rt).index[11] < 1.3, "with the rent counted, December looks only a little busier");
  rt.api("addRecurringExpense", { category_id: CAT, description: "Rent", amount: 1000, currency: "PEN", frequency: "monthly", day: 10 });
  // A December entry of 1300 is no longer within 10% of the rent item: only the 1000s are explained and dropped.
  const p = profile(rt);
  assert.ok(p.index[11] > 1.5, "with the rent explained away, December's extra shows");
});

test("Annual-tagged entries are left out of the shape", () => {
  const { rt } = setup();
  rt.run("ensureAnnualTag_()");   // the built-in tag exists
  history(rt, () => 100);
  [thisYear - 3, thisYear - 2, thisYear - 1].forEach((y) => {
    const id = addEntry(rt, ymd(y, 6, 20), 2000, "big yearly");
    rt.run(`appendRowObject('Entry Tags', { entry_id: ${JSON.stringify(id)}, tag_id: ANNUAL_TAG_ID });`);
  });
  assert.ok(profile(rt).index.every((s) => Math.abs(s - 1) < 1e-9));
});

test("projections: the level removes the season from this year's spend; the Year view weights the months still ahead", { skip: needsHistory }, () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), 100);   // this year so far: 100 a month
  const month = projection(rt, "month");
  const year = projection(rt, "year");
  assert.equal(month.ratePerMonth, 100, "the plain year-to-date average is still reported");
  assert.ok(Math.abs(month.levelPerMonth - 100 / 0.85) < 1e-6, "Jan..last month are all 0.85 months: level = 100 / 0.85");
  assert.equal(month.seasonalYears, 3);
  // The Year view still has December ahead: its remaining days are weighted by the index.
  assert.ok(year.seasonalFactor > month.seasonalFactor, "December (2.65) pulls the year's remaining weight up");
  const legacy = 100 * (year.daysLeft / 30);
  assert.ok(year.expectedRemainingPen > legacy, "more than the flat 'rate x days left / 30'");
  // The yearly shape is preserved: base (whole period) = level x the 12 indexes = 12 x level.
  assert.ok(Math.abs(year.baseAmountPen - 12 * year.levelPerMonth) < 1e-6);
});

test("projections: a flat category gives exactly the old figure (rate x days left / 30)", { skip: needsHistory }, () => {
  const { rt } = setup();
  history(rt, () => 100);
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), 100);
  [projection(rt, "month"), projection(rt, "year")].forEach((p) => {
    assert.equal(p.seasonalFactor, 1);
    assert.ok(Math.abs(p.expectedRemainingPen - 100 * (p.daysLeft / 30)) < 1e-6);
  });
});

test("projections: a category with no past years behaves exactly as before", { skip: needsHistory }, () => {
  const { rt } = setup();
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), 100);
  const p = projection(rt, "month");
  assert.equal(p.seasonalYears, 0);
  assert.equal(p.levelPerMonth, 100);
  assert.ok(Math.abs(p.expectedRemainingPen - 100 * (p.daysLeft / 30)) < 1e-6);
});

test("the Expected trace carries the seasonal facts", { skip: needsHistory }, () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), 100);
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: CAT, displayPeriodType: "year" });
  assert.equal(detail.ytdBreakdown.seasonalYears, 3);
  assert.ok(Math.abs(detail.ytdBreakdown.levelPerMonth - 100 / 0.85) < 1e-6);
  assert.equal(detail.projection.seasonalYears, 3);
});

test("budgets use the same seasonal 'Expected' as projections", { skip: needsHistory }, () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), 100);
  const budget = rt.api("addBudget", { category_id: CAT, amount: 5000, currency: "PEN", period_type: "yearly", thresholds: "100" });
  const series = rt.api("getBudgetChartSeries", { budgetId: budget.id, startDate: `${thisYear}-01-01`, endDate: `${thisYear}-12-31`, periodType: "yearly" });
  const year = projection(rt, "year");
  assert.ok(Math.abs(series.expectedRemaining - year.expectedRemainingPen) < 0.01, "same number in both places");
});
