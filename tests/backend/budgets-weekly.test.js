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
