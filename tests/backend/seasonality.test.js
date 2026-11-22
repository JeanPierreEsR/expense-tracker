// Seasonality (2026-10-19): "Expected" = level x the time-of-year index of the
// days still to come, the index learned from up to 3 complete past years.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today, lastDayOfMonth } = require("./helpers");

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
// This year's complete months so far, following the same monthly pattern as `history`. The
// level is learned from the last 12 complete months = those + the matching months of last year
// (already in `history`), so each calendar month appears exactly once in the window.
function thisYearSoFar(rt, monthlyAmount) {
  for (let m = 1; m <= monthsElapsed; m++) addEntry(rt, ymd(thisYear, m), monthlyAmount(m));
}
const DEC_HEAVY = (m) => (m === 12 ? 400 : 100);   // the 12 months add up to 1,500 = 125 a month
const FLAT = () => 100;
const daysInThisMonth = () => { const [y, m] = today().split("-").map(Number); return new Date(y, m, 0).getDate(); };
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

test("projections: 12 full months make the level the plain 12-month average; the Year view weights the months still ahead", { skip: lastDayOfMonth }, () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  thisYearSoFar(rt, DEC_HEAVY);
  const month = projection(rt, "month");
  const year = projection(rt, "year");
  assert.equal(month.ratePerMonth, 125, "the plain 12-month average is still reported: (11 x 100 + 400) / 12");
  assert.ok(Math.abs(month.levelPerMonth - 125) < 1e-6, "12 full months: the indexes sum to 12 and cancel, level = average");
  assert.equal(month.seasonalYears, 3);
  assert.ok(Math.abs(month.monthsLeft - month.daysLeft / daysInThisMonth()) < 1e-9, "Month view: days left / days in THIS month");
  assert.ok(Math.abs(month.expectedRemainingPen - month.levelPerMonth * month.monthsLeft * month.seasonalFactor) < 1e-6);
  assert.ok(Math.abs(year.expectedRemainingPen - year.levelPerMonth * year.monthsLeft * year.seasonalFactor) < 1e-6);
  // The yearly shape is preserved: base (whole period) = level x the 12 indexes = 12 x level.
  assert.ok(Math.abs(year.baseAmountPen - 12 * year.levelPerMonth) < 1e-6);
});

test("projections: a flat category gives rate x the months still to come (days left / days in that month)", { skip: lastDayOfMonth }, () => {
  const { rt } = setup();
  history(rt, () => 100);
  thisYearSoFar(rt, FLAT);
  const month = projection(rt, "month");
  assert.equal(month.seasonalFactor, 1);
  assert.ok(Math.abs(month.expectedRemainingPen - 100 * month.daysLeft / daysInThisMonth()) < 1e-6, "a 28-day month weighs exactly as much as a 31-day one");
  const year = projection(rt, "year");
  assert.ok(Math.abs(year.expectedRemainingPen - 100 * year.monthsLeft) < 1e-6);
});

test("every remaining day weighs 1 / the days of ITS month: February is a whole month, like July", () => {
  const { rt } = setup();
  const monthsLeft = (start, end) => JSON.parse(rt.run(`JSON.stringify(seasonalMonthsLeft_(flatSeasonProfile_(), '${start}', '${end}'))`));
  // A period in the future counts whole: Feb 2099 (28 days) = 1 month, July 2099 (31 days) = 1 month, the year = 12.
  assert.ok(Math.abs(monthsLeft("2099-02-01", "2099-02-28").months - 1) < 1e-12);
  assert.ok(Math.abs(monthsLeft("2099-07-01", "2099-07-31").months - 1) < 1e-12);
  assert.ok(Math.abs(monthsLeft("2099-01-01", "2099-12-31").months - 12) < 1e-12);
  assert.ok(Math.abs(monthsLeft("2096-02-01", "2096-02-29").months - 1) < 1e-12, "a leap February too");
  assert.equal(monthsLeft("2000-02-01", "2000-02-29").months, 0, "an ended period has nothing left");
});

test("a category younger than the window uses only its complete months since its first entry", { skip: lastDayOfMonth }, () => {
  const { rt } = setup();
  const [y, m] = today().split("-").map(Number);
  const at = (k, day = 10) => { const d = new Date(Date.UTC(y, m - 1 - k, 1)); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, day); };
  addEntry(rt, at(4, 20), 1, "first");                         // started 4 months ago (that month is partial: left out)
  for (let k = 1; k <= 3; k++) addEntry(rt, at(k), 300);
  const p = projection(rt, "month");
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: CAT, displayPeriodType: "month" });
  assert.equal(detail.ytdBreakdown.months.length, 3);
  assert.equal(p.ratePerMonth, 300, "three complete months of 300");
});

test("the Expected trace carries the window and the seasonal facts", () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  thisYearSoFar(rt, DEC_HEAVY);
  const detail = rt.api("getCategoryProjectionDetail", { categoryId: CAT, displayPeriodType: "year" });
  assert.equal(detail.ytdBreakdown.seasonalYears, 3);
  assert.equal(detail.ytdBreakdown.months.length, 12);
  assert.ok(Math.abs(detail.ytdBreakdown.levelPerMonth - 125) < 1e-6);
  assert.equal(detail.projection.seasonalYears, 3);
  assert.ok(detail.projection.monthsLeft > 0);
});

test("budgets use the same seasonal 'Expected' as projections", () => {
  const { rt } = setup();
  history(rt, (m) => (m === 12 ? 400 : 100));
  thisYearSoFar(rt, DEC_HEAVY);
  const budget = rt.api("addBudget", { category_id: CAT, amount: 5000, currency: "PEN", period_type: "yearly", thresholds: "100" });
  const series = rt.api("getBudgetChartSeries", { budgetId: budget.id, startDate: `${thisYear}-01-01`, endDate: `${thisYear}-12-31`, periodType: "yearly" });
  const year = projection(rt, "year");
  assert.ok(Math.abs(series.expectedRemaining - year.expectedRemainingPen) < 0.01, "same number in both places");
});
