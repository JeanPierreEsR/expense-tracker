// The Home tab's quick glance (getHomeGlance): six months of totals, this month's pace against last month's,
// the monthly budgets against what was spent inside them, and the trips running today.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-a', name: 'Glance A', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-b', name: 'Glance B', type: 'expense', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`appendRowObject('Categories', { id: 'cat-i', name: 'Glance pay', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  // Start from an empty ledger so every number below is exactly what the test put in.
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Budgets', function () { return true; });`);
  return rt;
}
let n = 0;
function entry(rt, over = {}) {
  const e = { id: "g" + ++n, type: "expense", date: today(), amount: 100, currency: "PEN", category_id: "cat-a", description: "x", paid_by: "me", status: "confirmed", source: "manual", ...over };
  rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
  return e;
}
const monthsAgo = (k) => {
  const [y, m] = today().split("-").map(Number);
  const d = new Date(y, m - 1 - k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

test("six months, oldest first, ending with this month; each month adds its own entries only", () => {
  const rt = setup();
  entry(rt, { amount: 80 });
  entry(rt, { type: "income", category_id: "cat-i", amount: 500 });
  entry(rt, { type: "investment", amount: 50 });
  entry(rt, { date: monthsAgo(2) + "-10", amount: 30 });
  entry(rt, { date: monthsAgo(7) + "-10", amount: 999 });   // outside the window
  const g = rt.api("getHomeGlance", {});
  assert.equal(g.months.length, 6);
  assert.equal(g.months[5].month, today().slice(0, 7));
  assert.equal(g.months[0].month, monthsAgo(5));
  assert.deepEqual([g.months[5].expense, g.months[5].income, g.months[5].investment], [80, 500, 50]);
  assert.equal(g.months[5].net, 500 - 80 - 50);
  assert.equal(g.months[3].expense, 30);
  assert.equal(g.months.reduce((s, m) => s + m.expense, 0), 110, "nothing from outside the window");
});

test("the owner's share only; transfers and unconfirmed entries never count", () => {
  const rt = setup();
  const e = entry(rt, { amount: 100 });
  rt.run(`appendRowObject('Entry Splits', { id: 'gs1', entry_id: '${e.id}', friend_id: 'f1', amount: 40 });`);
  entry(rt, { type: "transfer", amount: 700 });
  entry(rt, { status: "pending", amount: 300 });
  assert.equal(rt.api("getHomeGlance", {}).months[5].expense, 60);
});

test("a foreign-currency entry with no rate on file is left out, never counted as zero-rate nonsense", () => {
  const rt = setup();
  entry(rt, { amount: 10, currency: "ZZZ" });
  entry(rt, { amount: 25 });
  assert.equal(rt.api("getHomeGlance", {}).months[5].expense, 25);
});

test("pace: running totals per day for this month (up to today) and for the whole of last month", () => {
  const rt = setup();
  const [y, m] = today().split("-").map(Number);
  const day = Number(today().slice(8, 10));
  entry(rt, { date: `${today().slice(0, 7)}-01`, amount: 10 });
  entry(rt, { date: today(), amount: 5 });
  entry(rt, { date: monthsAgo(1) + "-02", amount: 7 });
  const g = rt.api("getHomeGlance", {});
  assert.equal(g.pace.curDay, day);
  assert.equal(g.pace.cur.length, day);
  assert.equal(g.pace.cur[0], 10);
  assert.equal(g.pace.cur[day - 1], 15, "ends at this month's total");
  assert.equal(g.pace.prevDays, new Date(y, m - 1, 0).getDate());
  assert.equal(g.pace.prev.length, g.pace.prevDays);
  assert.deepEqual([g.pace.prev[0], g.pace.prev[1], g.pace.prev[g.pace.prevDays - 1]], [0, 7, 7]);
});

test("budget: no monthly budget = no card; otherwise the total against spend inside its categories only", () => {
  const rt = setup();
  entry(rt, { amount: 40, category_id: "cat-a" });
  entry(rt, { amount: 90, category_id: "cat-b" });
  assert.equal(rt.api("getHomeGlance", {}).budget, null);
  rt.api("addBudget", { category_id: "cat-a", amount: 400, currency: "PEN", period_type: "monthly" });
  const b = rt.api("getHomeGlance", {}).budget;
  assert.equal(b.totalPen, 400);
  assert.equal(b.spentPen, 40, "cat-b has no budget, so it is not part of this bar");
  assert.ok(b.daysLeft >= 0);
});

test("trips: only those running today, with their cost so far and budget", () => {
  const rt = setup();
  const t = rt.api("addTrip", { name: "Now trip", kind: "trip", start_date: monthsAgo(0) + "-01", end_date: "2099-12-31", budget_amount: 1000, emoji: "🏔️" });
  rt.api("addTrip", { name: "Past trip", kind: "trip", start_date: "2020-01-01", end_date: "2020-01-05" });
  rt.api("addTrip", { name: "Future trip", kind: "event", start_date: "2098-01-01", end_date: "2098-01-02" });
  const e = entry(rt, { amount: 120 });
  rt.run(`ensureEntriesTripColumn_(); setEntryField_('${e.id}', 'trip_id', '${t.id}');`);
  const g = rt.api("getHomeGlance", {});
  assert.deepEqual(g.trips.map((x) => x.name), ["Now trip"]);
  assert.equal(g.trips[0].spent, 120);
  assert.equal(g.trips[0].budget, 1000);
  assert.ok(g.trips[0].day >= 1 && g.trips[0].day <= g.trips[0].days);
});

test("one request stays cheap: sheet reads do not grow with the number of entries", () => {
  const small = freshApp({ entries: 1000 });
  const big = freshApp({ entries: 7000 });
  const reads = (rt) => { rt.resetStats(); rt.api("getHomeGlance", {}); return rt.stats.reads; };
  const a = reads(small.rt);
  const b = reads(big.rt);
  assert.ok(a < 80, `getHomeGlance made ${a} sheet reads`);
  assert.ok(b <= a + 5, `reads grew from ${a} to ${b} with 7x the entries`);
});
