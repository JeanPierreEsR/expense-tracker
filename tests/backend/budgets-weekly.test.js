// Weekly budgets and the Week view (owner, 2026-11-07): a week runs Monday to Sunday; a weekly budget across a month or a year
// counts its weeks (a week cut by the period's edge by its days); Home's budget card stays monthly. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

let n = 0;
function setup() {
  const { rt } = freshApp({ small: true });
  rt.run(`appendRowObject('Categories', { id: 'cat-wk', name: 'Week test', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run("deleteRowsWhere_('Budgets', function () { return true; })");
  return rt;
}
function spend(rt, date, amount) {
  const e = { id: "wk" + ++n, type: "expense", date, amount, currency: "PEN", category_id: "cat-wk", description: "x", paid_by: "me", status: "confirmed", source: "manual" };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
}
const addDays = (iso, k) => { const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + k)); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const thisMonday = () => mondayOf(today());
const daysIn = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();
const list = (rt, displayPeriodType, anchorDate) => rt.api("listBudgets", { displayPeriodType, anchorDate });
const shown = (rt, id, type, anchor) => list(rt, type, anchor).budgets.find((b) => b.id === id);
const addWeekly = (rt, extra = {}) => rt.api("addBudget", { category_id: "cat-wk", amount: 70, currency: "PEN", period_type: "weekly", ...extra });

test("a weekly budget runs Monday to Sunday and counts only that week's spending", () => {
  const rt = setup();
  const b = addWeekly(rt);
  assert.equal(b.period_type, "weekly");
  assert.equal(b.start, thisMonday(), "it starts on this week's Monday");
  spend(rt, today(), 30);
  spend(rt, addDays(thisMonday(), -1), 500);   // last Sunday: the week before
  const p = shown(rt, b.id, "week", thisMonday()).progress;
  assert.deepEqual([p.startDate, p.endDate, p.periodKey], [thisMonday(), addDays(thisMonday(), 6), thisMonday()]);
  assert.equal(p.effectiveAmount, 70);
  assert.equal(p.spent, 30);
  assert.equal(p.effectivePeriodType, "weekly");
});

test("the Week view: a past week shows that week; a monthly budget shows the month holding the week's Thursday", () => {
  const rt = setup();
  const w = addWeekly(rt, { start: "always" });
  rt.api("addBudget", { category_id: "cat-wk", amount: 300, currency: "PEN", period_type: "monthly", start: "always" });
  const lastMonday = addDays(thisMonday(), -7);
  assert.equal(shown(rt, w.id, "week", lastMonday).progress.startDate, lastMonday);
  const monthly = list(rt, "week", lastMonday).budgets.find((b) => b.period_type === "monthly").progress;
  assert.equal(monthly.effectivePeriodType, "monthly", "a Week view never narrows a monthly budget");
  assert.equal(monthly.periodKey, addDays(lastMonday, 3).slice(0, 7));
});

test("a weekly budget across a month counts its weeks, a week cut by the month by its days", () => {
  const rt = setup();
  const b = addWeekly(rt, { start: "always" });
  const ym = today().slice(0, 7);
  const p = shown(rt, b.id, "month", ym + "-01").progress;
  assert.equal(p.weeksWidened, true);
  assert.equal(p.effectivePeriodType, "monthly");
  assert.equal(p.effectiveAmount, Math.round(70 * daysIn(ym) / 7 * 100) / 100);
  assert.equal(p.weeksCounted, Math.round(daysIn(ym) / 7 * 10) / 10);
});

test("the totals card counts a weekly budget 52 times a year, 52/12 a month; Home's card leaves it out", () => {
  const rt = setup();
  addWeekly(rt);
  const s = list(rt, "month").summary;
  assert.equal(Math.round(s.monthlyPen * 100) / 100, Math.round(70 * 52 / 12 * 100) / 100);
  assert.equal(s.yearlyPen, 70 * 52);
  assert.equal(rt.api("getHomeGlance", {}).budget, null, "Home's budget card stays monthly");
});

test("a weekly budget changes forward only, week by week; it can start next week", () => {
  const rt = setup();
  const b = addWeekly(rt, { start: "always" });
  rt.api("updateBudget", { id: b.id, amount: 100 });
  const lastMonday = addDays(thisMonday(), -7);
  assert.equal(shown(rt, b.id, "week", lastMonday).progress.effectiveAmount, 70);
  assert.equal(shown(rt, b.id, "week", thisMonday()).progress.effectiveAmount, 100);
  const later = rt.api("addBudget", { category_id: "ALL", amount: 50, currency: "USD", period_type: "weekly", start: "next" });
  assert.equal(later.start, addDays(thisMonday(), 7));
});

test("one weekly and one monthly budget on the same category are allowed; two weekly ones are not", () => {
  const rt = setup();
  addWeekly(rt);
  rt.api("addBudget", { category_id: "cat-wk", amount: 300, currency: "PEN", period_type: "monthly" });
  assert.throws(() => addWeekly(rt, { amount: 90 }), /weekly/);
});

test("the alert check measures a weekly budget against this week (its period is the Monday)", () => {
  const rt = setup();
  const b = addWeekly(rt);
  spend(rt, today(), 80);
  const p = rt.run(`computeBudgetProgressWithContext_(getAllRows('Budgets')[0], buildBudgetContext_())`);
  assert.equal(p.periodKey, thisMonday());
  assert.ok(p.percent > 100);
  assert.ok(b.id);
});

test("the chart of one week uses that week's spending", () => {
  const rt = setup();
  const b = addWeekly(rt);
  spend(rt, today(), 25);
  const c = rt.api("getBudgetChartSeries", { budgetId: b.id, startDate: thisMonday(), endDate: addDays(thisMonday(), 6) });
  assert.equal(c.currency, "PEN");
  assert.equal(JSON.stringify(c).includes("25"), true);
});

test("the Spending pace card in Week / Year / Custom views: each range's running spend, day by day, up to today", () => {
  const rt = setup();
  spend(rt, thisMonday(), 12);
  spend(rt, addDays(thisMonday(), -7), 5);
  const r = rt.api("getSpendingPace", { ranges: [{ start: thisMonday(), end: addDays(thisMonday(), 6) }, { start: addDays(thisMonday(), -7), end: addDays(thisMonday(), -1) }] });
  const [cur, ref] = r.ranges;
  assert.equal(cur.days, 7);
  assert.equal(cur.cum.length, Math.round((Date.parse(today()) - Date.parse(thisMonday())) / 86400000) + 1, "this week stops at today");
  assert.ok(cur.cum[0] >= 12);
  assert.equal(ref.cum.length, 7, "last week is whole");
  assert.ok(ref.expense >= 5);
  assert.equal(rt.api("getMeta", {}).capabilities.paceRanges, true);
});

test("a budget that starts later is listed apart (never invisible), and its start can still be moved", () => {
  const rt = setup();
  const [y, m] = today().split("-").map(Number);
  const k = (n) => { const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
  const b = rt.api("addBudget", { category_id: "cat-wk", amount: 80, currency: "PEN", period_type: "monthly", start: k(3) });
  const now = rt.api("listBudgets", { displayPeriodType: "month" });
  assert.equal(now.budgets.some((x) => x.id === b.id), false, "not in this month");
  const later = now.later.find((x) => x.id === b.id);
  assert.equal(later.start_later, k(3));
  rt.api("updateBudget", { id: b.id, amount: 90, start: k(1) });
  const moved = rt.api("listBudgets", { displayPeriodType: "month" }).later.find((x) => x.id === b.id);
  assert.equal(moved.start_later, k(1));
  rt.api("updateBudget", { id: b.id, start: k(0) });
  const started = rt.api("listBudgets", { displayPeriodType: "month" });
  assert.equal(started.budgets.find((x) => x.id === b.id).progress.effectiveAmount, 90, "it runs from this month, with the amount saved");
  assert.equal(started.later.length, 0);
});

test("a start Google Sheets turned into a date still counts (owner's real Sheet, 2026-11-08: 'Invalid Date', budget hidden)", () => {
  const rt = setup();
  const b = rt.api("addBudget", { category_id: "cat-wk", amount: 60, currency: "PEN", period_type: "monthly" });
  // What Sheets did: the text "2026-11" became a date cell (the 1st of that month).
  const [y, m] = today().split("-").map(Number);
  rt.run(`(function () {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Budget History');
    var data = sheet.getDataRange().getValues(); var col = data[0].indexOf('from_period');
    for (var i = 1; i < data.length; i++) if (String(data[i][data[0].indexOf('budget_id')]) === '${b.id}') sheet.getRange(i + 1, col + 1).setValue(new Date(${y}, ${m - 1}, 1));
  })()`);
  const list = rt.api("listBudgets", { displayPeriodType: "month" });
  assert.ok(list.budgets.some((x) => x.id === b.id), "listed this month");
  assert.equal(list.later.length, 0, "not 'starts later'");
  rt.api("updateBudget", { id: b.id, amount: 75 });
  assert.equal(rt.api("listBudgets", { displayPeriodType: "month" }).budgets.find((x) => x.id === b.id).progress.effectiveAmount, 75);
});
