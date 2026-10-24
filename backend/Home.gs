/**
 * The Home tab's quick glance (2026-10-24). One request, one pass over the confirmed entries, so the
 * top of Home costs a single slow Apps Script round trip no matter how many cards it shows:
 *  - months: the last six months' income / expenses / investments (the bars and the four boxes),
 *  - pace:   this month's running expenses day by day, next to last month's (the pace card),
 *  - budget: the monthly budgets added up against what was spent inside their categories,
 *  - trips:  every trip or event running today with what it has cost so far.
 * Same rules as getPeriodSummary: owner's share only, transfers never count, an entry with no
 * usable rate is left out. Everything is in the main currency. See specs/home-tab.md.
 */

var HOME_GLANCE_MONTHS_ = 6;

function homeMonthKeys_(todayStr, count) {
  var y = Number(todayStr.substring(0, 4));
  var m = Number(todayStr.substring(5, 7));
  var keys = [];
  for (var i = count - 1; i >= 0; i--) {
    var d = new Date(y, m - 1 - i, 1);
    keys.push(d.getFullYear() + '-' + pad2_(d.getMonth() + 1));
  }
  return keys;
}

function homeDaysInMonth_(monthKey) {
  return new Date(Number(monthKey.substring(0, 4)), Number(monthKey.substring(5, 7)), 0).getDate();
}

// Running total per day of the month: index 0 = day 1. `upTo` stops a month still in progress at today.
function homeCumulativeByDay_(dayTotals, monthKey, upTo) {
  var out = [];
  var running = 0;
  for (var day = 1; day <= upTo; day++) {
    running += dayTotals[monthKey + '-' + pad2_(day)] || 0;
    out.push(Math.round(running * 100) / 100);
  }
  return out;
}

function getHomeGlance() {
  var today = formatCalendarDate_(new Date());
  var keys = homeMonthKeys_(today, HOME_GLANCE_MONTHS_);
  var curKey = keys[keys.length - 1];
  var prevKey = keys[keys.length - 2];
  var firstDate = keys[0] + '-01';

  var perMonth = {};
  keys.forEach(function (k) { perMonth[k] = { month: k, income: 0, expense: 0, investment: 0 }; });

  // Budgets: only the monthly ones count toward "this month" (a yearly one is a different promise).
  var monthlyBudgets = getAllRows('Budgets').filter(function (b) { return b.period_type !== 'yearly'; });
  var budgetIds = monthlyBudgets.map(function (b) { return parseBudgetCategoryIds_(b.category_id); });
  function insideBudgets_(categoryId) {
    return budgetIds.some(function (ids) { return categoryIdMatches_(ids, categoryId); });
  }
  var annual = monthlyBudgets.length ? annualEntryIdSet_() : {};
  var budgetSpent = 0;

  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount);
  });

  var dayExpense = {};   // 'yyyy-mm-dd' -> expenses, this month and last month only
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || e.type === 'transfer' || e.date < firstDate) return;
    var key = String(e.date).substring(0, 7);
    var bucket = perMonth[key];
    if (!bucket) return;
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    if (rate == null) return;
    var own = Number(e.amount);
    if (e.type === 'expense') own -= (splitSum[e.id] || 0);
    var pen = own * rate;
    if (e.type === 'expense') {
      bucket.expense += pen;
      if (key === curKey || key === prevKey) dayExpense[e.date] = (dayExpense[e.date] || 0) + pen;
      if (key === curKey && monthlyBudgets.length && !annual[e.id] && insideBudgets_(e.category_id)) budgetSpent += pen;
    } else if (e.type === 'income') {
      bucket.income += pen;
    } else if (e.type === 'investment') {
      bucket.investment += pen;
    }
  });

  var months = keys.map(function (k) {
    var b = perMonth[k];
    return { month: k, income: b.income, expense: b.expense, investment: b.investment, net: b.income - b.expense - b.investment };
  });

  var curDay = Number(today.substring(8, 10));
  var pace = {
    curDay: curDay,
    curDays: homeDaysInMonth_(curKey),
    prevDays: homeDaysInMonth_(prevKey),
    cur: homeCumulativeByDay_(dayExpense, curKey, curDay),
    prev: homeCumulativeByDay_(dayExpense, prevKey, homeDaysInMonth_(prevKey))
  };

  var budget = null;
  if (monthlyBudgets.length) {
    var totalPen = listBudgets({}).summary.monthlyPen;
    if (totalPen > 0) budget = { totalPen: totalPen, spentPen: budgetSpent, daysLeft: pace.curDays - curDay };
  }

  return { months: months, pace: pace, budget: budget, trips: homeActiveTrips_(today) };
}

// Trips and events whose dates include today, newest start first, each with what it has cost so far
// (real payments plus estimates nothing has paid yet — the same total the Trips screen shows).
function homeActiveTrips_(today) {
  var running = getTripRows_().filter(function (t) {
    return t.start_date && t.end_date && t.start_date <= today && today <= t.end_date;
  });
  running.sort(function (a, b) { return a.start_date < b.start_date ? 1 : -1; });
  return running.map(function (t) {
    var cur = tripCurrency_(t);
    var spent = 0;
    tripAllRows_(t.id).forEach(function (r) {
      var amount = tripAmountIn_(cur, r);
      if (amount != null) spent += amount;
    });
    var dayOf = Math.round((new Date(today + 'T00:00:00Z') - new Date(t.start_date + 'T00:00:00Z')) / 86400000) + 1;
    var days = Math.round((new Date(t.end_date + 'T00:00:00Z') - new Date(t.start_date + 'T00:00:00Z')) / 86400000) + 1;
    return {
      id: t.id, name: t.name, kind: t.kind, emoji: t.emoji || '',
      start_date: t.start_date, end_date: t.end_date, day: dayOf, days: days,
      currency: cur, spent: spent, budget: Number(t.budget_amount) > 0 ? Number(t.budget_amount) : null
    };
  });
}
