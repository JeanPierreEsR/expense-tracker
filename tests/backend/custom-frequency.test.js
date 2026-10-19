// Frequency "Other" (2026-10-19): a programmed item that repeats every N days /
// weeks / months / years, counted from its start date — and, with a variable
// amount, a car service that happens "about every 5 months".
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const CAT = "cat-custom-test";
const jr = (rt, code) => JSON.parse(rt.run(`JSON.stringify(${code})`));
const rowOf = (rt, id) => `getRecurringExpenseRows_().filter(function (r) { return r.id === ${JSON.stringify(id)}; })[0]`;
const occ = (rt, id, a, b) => jr(rt, `recurringExpenseOccurrencesInRange_(${rowOf(rt, id)}, '${a}', '${b}')`);
const raw = (rt, id, a, b) => jr(rt, `customOccurrenceDatesRaw_(${rowOf(rt, id)}, '${a}', '${b}')`);
const ym = () => today().slice(0, 7);
const monthEnd = () => { const [y, m] = today().split("-").map(Number); return `${ym()}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`; };

function setup() {
  const { rt, data } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Categories', { id: ${JSON.stringify(CAT)}, name: 'Custom test', type: 'expense', icon: '🔧', color: '#ccc', parent_id: '' });`);
  return { rt, data };
}
let seq = 0;
function addEntry(rt, date, amount, description, extra = {}) {
  const id = "e-cf-" + ++seq;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date, amount, currency: "PEN", category_id: CAT, description, paid_by: "me", status: "confirmed", source: "manual", ...extra })});`);
  return id;
}
function monthsAgo(k, day) {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const custom = (rt, extra = {}) => rt.api("addRecurringExpense", {
  category_id: CAT, description: "Every 2 weeks thing", amount: 50, currency: "PEN", frequency: "custom",
  interval: 2, interval_unit: "weeks", start_date: "2026-10-05", ...extra
});
const listed = (rt, id) => rt.api("listRecurringExpenses").find((x) => x.id === id);
const expectedFor = (rt, id) => rt.api("listExpectedRecurringItems").groups.flatMap((g) => g.items).filter((i) => i.id === id);

// ---- the dates ------------------------------------------------------------------
test("every 2 weeks counts exact 14-day steps from the start date", () => {
  const { rt } = setup();
  const r = custom(rt);
  assert.deepEqual(occ(rt, r.id, "2026-10-01", "2026-11-30"), ["2026-10-05", "2026-10-19", "2026-11-02", "2026-11-16", "2026-11-30"]);
});

test("every 10 days; every 3 weeks", () => {
  const { rt } = setup();
  assert.deepEqual(occ(rt, custom(rt, { interval: 10, interval_unit: "days", start_date: "2026-01-01" }).id, "2026-01-01", "2026-02-15"), ["2026-01-01", "2026-01-11", "2026-01-21", "2026-01-31", "2026-02-10"]);
  assert.deepEqual(occ(rt, custom(rt, { interval: 3, interval_unit: "weeks", start_date: "2026-01-05" }).id, "2026-01-01", "2026-03-01"), ["2026-01-05", "2026-01-26", "2026-02-16"]);
});

test("every 2 months keeps the start day and clamps it in short months", () => {
  const { rt } = setup();
  const r = custom(rt, { interval: 2, interval_unit: "months", start_date: "2026-01-31" });
  assert.deepEqual(occ(rt, r.id, "2026-01-01", "2026-12-31"), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-09-30", "2026-11-30"]);
  const m = custom(rt, { interval: 1, interval_unit: "months", start_date: "2026-01-31" });
  assert.deepEqual(occ(rt, m.id, "2026-01-01", "2026-03-31"), ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("every 2 years; a leap day lands on the 28th in other years", () => {
  const { rt } = setup();
  const r = custom(rt, { interval: 2, interval_unit: "years", start_date: "2024-03-15" });
  assert.deepEqual(occ(rt, r.id, "2024-01-01", "2030-12-31"), ["2024-03-15", "2026-03-15", "2028-03-15", "2030-03-15"]);
  const leap = custom(rt, { interval: 1, interval_unit: "years", start_date: "2024-02-29" });
  assert.deepEqual(occ(rt, leap.id, "2024-01-01", "2026-12-31"), ["2024-02-29", "2025-02-28", "2026-02-28"]);
});

test("the series also runs BACKWARDS from the start date (used to match past payments), but only counts from it", () => {
  const { rt } = setup();
  const r = custom(rt, { interval: 2, interval_unit: "weeks", start_date: "2026-10-05" });
  assert.deepEqual(raw(rt, r.id, "2026-09-01", "2026-10-06"), ["2026-09-07", "2026-09-21", "2026-10-05"]);
  assert.deepEqual(occ(rt, r.id, "2026-09-01", "2026-10-06"), ["2026-10-05"], "nothing before the start date counts as expected");
});

test("end date, pausing and skipping a month still apply", () => {
  const { rt } = setup();
  const r = custom(rt, { end_date: "2026-10-31" });
  assert.deepEqual(occ(rt, r.id, "2026-10-01", "2026-12-31"), ["2026-10-05", "2026-10-19"]);
  rt.api("skipRecurringOccurrence", { id: r.id, month: "2026-10" });
  assert.deepEqual(occ(rt, r.id, "2026-10-01", "2026-12-31"), []);
  rt.api("unskipRecurringOccurrence", { id: r.id, month: "2026-10" });
  rt.api("updateRecurringExpense", { id: r.id, active: false });
  assert.deepEqual(occ(rt, r.id, "2026-10-01", "2026-12-31"), []);
});

// ---- saving ---------------------------------------------------------------------------
test("a custom item is listed with its interval, unit and start date; day/month follow the start date", () => {
  const { rt } = setup();
  const item = listed(rt, custom(rt, { interval: 3, interval_unit: "months", start_date: "2026-04-12" }).id);
  assert.equal(item.frequency, "custom");
  assert.equal(item.interval, 3);
  assert.equal(item.interval_unit, "months");
  assert.equal(item.start_date, "2026-04-12");
  assert.equal(item.day, 12);
  assert.equal(item.month, 4);
});

test("bad intervals, units and a missing start date are refused", () => {
  const { rt } = setup();
  assert.throws(() => custom(rt, { interval: 0 }), /whole number/i);
  assert.throws(() => custom(rt, { interval: 1.5 }), /whole number/i);
  assert.throws(() => custom(rt, { interval: "abc" }), /whole number/i);
  assert.throws(() => custom(rt, { interval: 1000 }), /whole number/i);
  assert.throws(() => custom(rt, { interval_unit: "fortnights" }), /days, weeks/i);
  assert.throws(() => custom(rt, { start_date: "" }), /start date/i);
});

test("editing: switching to Other needs the fields, switching away clears them", () => {
  const { rt } = setup();
  const r = rt.api("addRecurringExpense", { category_id: CAT, description: "Gym", amount: 80, currency: "PEN", frequency: "monthly", day: 5 });
  assert.throws(() => rt.api("updateRecurringExpense", { id: r.id, frequency: "custom" }), /whole number|start date/i);
  rt.api("updateRecurringExpense", { id: r.id, frequency: "custom", interval: 6, interval_unit: "weeks", start_date: "2026-03-02" });
  let item = listed(rt, r.id);
  assert.equal(item.frequency, "custom");
  assert.equal(item.interval, 6);
  assert.equal(item.day, 2);
  rt.api("updateRecurringExpense", { id: r.id, interval: 8 });
  assert.equal(listed(rt, r.id).interval, 8, "interval can be edited alone");
  rt.api("updateRecurringExpense", { id: r.id, frequency: "monthly" });
  item = listed(rt, r.id);
  assert.equal(item.frequency, "monthly");
  assert.equal(item.interval, null);
  assert.equal(item.interval_unit, "");
});

// ---- matching real payments ---------------------------------------------------------------
test("'Programmed this month' lists each unpaid occurrence on its own, and a payment covers just its own", () => {
  const { rt } = setup();
  const [y, m] = today().split("-").map(Number);
  const first = `${ym()}-01`;
  const r = custom(rt, { interval: 1, interval_unit: "weeks", start_date: first });
  const dates = occ(rt, r.id, first, monthEnd());
  assert.ok(dates.length >= 4);
  assert.equal(expectedFor(rt, r.id).length, dates.length, "one line per occurrence");

  addEntry(rt, dates[1], 50, "weekly thing");                    // pays the 2nd occurrence exactly
  const left = expectedFor(rt, r.id).map((i) => i.day);
  assert.equal(left.length, dates.length - 1);
  assert.ok(!left.includes(Number(dates[1].slice(8, 10))), "that occurrence is gone, the others stay");

  addEntry(rt, dates[1], 50, "weekly thing again");              // a second entry on the same day does not pay a neighbour
  assert.equal(expectedFor(rt, r.id).length, dates.length - 1);
});

test("a fixed custom item's window never lets neighbouring occurrences claim one entry", () => {
  const { rt } = setup();
  const r = custom(rt, { interval: 4, interval_unit: "days", start_date: "2026-03-01" });
  const win = jr(rt, `recurringMatchWindowDays_(${rowOf(rt, r.id)})`);
  assert.equal(win, 1, "ceil(4/2) - 1");
  const weekly = custom(rt, { interval: 1, interval_unit: "weeks", start_date: "2026-03-01" });
  assert.equal(jr(rt, `recurringMatchWindowDays_(${rowOf(rt, weekly.id)})`), 3);
  const monthlyLike = custom(rt, { interval: 2, interval_unit: "months", start_date: "2026-03-01" });
  assert.equal(jr(rt, `recurringMatchWindowDays_(${rowOf(rt, monthlyLike.id)})`), 5, "capped at the usual 5 days");
});

// ---- variable amount + a loose date: the car service ---------------------------------------------
function carService(rt, extra = {}) {
  return rt.api("addRecurringExpense", {
    category_id: CAT, description: "Car service", amount: 500, currency: "PEN", frequency: "custom",
    interval: 5, interval_unit: "months", start_date: monthsAgo(5, 10), variable: true, match_words: "service mantenimiento", ...extra
  });
}

test("a variable item can use the Other frequency; an item that is yearly still can't", () => {
  const { rt } = setup();
  assert.equal(listed(rt, carService(rt).id).variable, true);
  assert.throws(() => rt.api("addRecurringExpense", { category_id: CAT, description: "x", amount: 5, currency: "PEN", frequency: "yearly", month: 3, day: 3, variable: true, match_words: "luz" }), /monthly/i);
});

test("the estimate is the average of the last 3 services, one per occurrence, even months apart", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(5, 14), 600, "Car service");
  addEntry(rt, monthsAgo(10, 3), 800, "Mantenimiento carro");
  addEntry(rt, monthsAgo(15, 20), 700, "Car service");
  addEntry(rt, monthsAgo(20, 11), 9000, "Car service");   // far outside the plausible range of the others
  const item = listed(rt, carService(rt).id);
  assert.equal(item.amount, 700, "(600 + 800 + 700) / 3");
  assert.equal(item.payments_used, 3);
});

test("two entries for one service (parts + labour) count as ONE occurrence, the nearest one wins", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(5, 10), 300, "Car service parts");
  addEntry(rt, monthsAgo(5, 25), 40, "Car service tip");      // same service, a couple of weeks later
  addEntry(rt, monthsAgo(10, 10), 320, "Car service");
  addEntry(rt, monthsAgo(15, 10), 280, "Car service");
  const item = listed(rt, carService(rt).id);
  assert.equal(item.payments_used, 3, "three services, not four entries");
  assert.equal(item.amount, 300, "(300 + 320 + 280) / 3");
});

test("projections: the service is Programmed in its month; paying it a few weeks early counts, even in the previous month", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(5, 14), 600, "Car service");
  addEntry(rt, monthsAgo(10, 3), 800, "Car service");
  addEntry(rt, monthsAgo(15, 20), 700, "Car service");
  const r = carService(rt);
  const proj = () => rt.api("listCategoryProjections", { displayPeriodType: "month" }).categories.find((c) => c.category_id === CAT);
  // The next service falls this month (5 months after the one 5 months ago).
  assert.ok(Math.abs(proj().programmedRemainingPen - 700) < 0.01, "unpaid: Programmed at the average");
  assert.equal(expectedFor(rt, r.id).length, 1);

  addEntry(rt, monthsAgo(1, 27), 650, "Car service");      // done last month, ~2 weeks before its nominal date
  assert.ok(Math.abs(proj().programmedRemainingPen) < 0.01, "already paid: nothing left to program this month");
  assert.equal(expectedFor(rt, r.id).length, 0, "and the card no longer lists it");
});

test("projections: the paid service is taken out of the category's 12-month average (no double count)", () => {
  const { rt } = setup();
  addEntry(rt, monthsAgo(36, 1), 1, "first ever");              // the category already existed long before the window
  const serviceDate = monthsAgo(3, 10);
  addEntry(rt, serviceDate, 600, "Car service");
  const proj = () => rt.api("listCategoryProjections", { displayPeriodType: "month" }).categories.find((c) => c.category_id === CAT);
  assert.ok(proj().ratePerMonth > 0, "without the item the service feeds the average");
  rt.api("addRecurringExpense", {
    category_id: CAT, description: "Car service", amount: 600, currency: "PEN", frequency: "custom",
    interval: 5, interval_unit: "months", start_date: serviceDate, variable: true, match_words: "service"
  });
  const after = proj();   // a category with nothing left to project drops out of the list altogether
  assert.ok(!after || Math.abs(after.ratePerMonth) < 0.001, "explained by the item, nothing left in Expected");
});

test("a hand link counts for the occurrence near it, not for the whole month", () => {
  const { rt } = setup();
  const r = custom(rt, { interval: 1, interval_unit: "weeks", start_date: `${ym()}-01` });
  const dates = occ(rt, r.id, `${ym()}-01`, monthEnd());
  const odd = addEntry(rt, dates[2], 7, "something else");
  rt.api("linkEntryToRecurring", { entryId: odd, recurringExpenseId: r.id });
  const left = expectedFor(rt, r.id).map((i) => i.day);
  assert.equal(left.length, dates.length - 1);
  assert.ok(!left.includes(Number(dates[2].slice(8, 10))));
});
