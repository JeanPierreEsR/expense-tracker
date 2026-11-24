/**
 * The Home tab's quick glance (2026-10-24). One request, one pass over the confirmed entries, so the
 * top of Home costs a single slow Apps Script round trip no matter how many cards it shows:
 *  - months: the last six months' income / expenses / investments / loans (the bars and the four boxes; What's left = Overview's),
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
  // Only those running this month: an ended budget, or one that starts later, is not part of it (Budgets.gs § Budget history).
  var budgetHist = budgetHistory_();
  var monthlyBudgets = getAllRows('Budgets').filter(function (b) {
    return budgetKind_(b.period_type) === 'monthly' && budgetActiveNow_(b, { budgetHistory: budgetHist });
  });
  var budgetIds = monthlyBudgets.map(function (b) { return parseBudgetCategoryIds_(b.category_id); });
  function insideBudgets_(categoryId) {
    return budgetIds.some(function (ids) { return categoryIdMatches_(ids, categoryId); });
  }
  var annual = monthlyBudgets.length ? annualMarkedIdSet_() : {};
  // A trip's "In my budgets" (Trips.gs): left out of every budget, or counted only in the budgets picked, whatever the category.
  var tripRoutes = monthlyBudgets.length ? tripBudgetRoutes_() : {};
  function countsInBudgets_(e) {
    var t = e.trip_id ? tripRoutes[e.trip_id] : null;
    if (!t) return insideBudgets_(e.category_id);
    return monthlyBudgets.some(function (b) { return t.route[String(b.id)] === true; });
  }
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
    var rate = getRateForTotals_(e.currency, e.date);
    if (rate == null) return;
    var own = Number(e.amount);
    if (e.type === 'expense') own -= (splitSum[e.id] || 0);
    var pen = own * rate;
    if (e.type === 'expense') {
      bucket.expense += pen;
      if (key === curKey || key === prevKey) dayExpense[e.date] = (dayExpense[e.date] || 0) + pen;
      if (key === curKey && monthlyBudgets.length && !annual[e.id] && countsInBudgets_(e)) budgetSpent += pen;
    } else if (e.type === 'income') {
      bucket.income += pen;
    } else if (e.type === 'investment') {
      bucket.investment += pen;
    }
  });

  // What's left works exactly like Overview's (owner, 2026-11-04): money borrowed and repaid in the month counts in it too
  // (loanFlowsForPeriod_, Reports.gs), so Home and Overview never show two different numbers for the same month.
  var months = keys.map(function (k) {
    var b = perMonth[k];
    var loans = loanFlowsForPeriod_(k + '-01', k + '-' + pad2_(homeDaysInMonth_(k)), 'all').netPen;
    return { month: k, income: b.income, expense: b.expense, investment: b.investment, loans: loans, net: b.income - b.expense - b.investment + loans };
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
    var listed = listBudgets({ monthProgrammed: { start: curKey + '-01', end: curKey + '-' + pad2_(pace.curDays) } });
    var totalPen = listed.summary.monthlyPen;
    // How many monthly budgets are already over (owner, 2026-11-07): "left" adds the budgets together on purpose (overspending in one
    // leaves less for the others), so the card says it in words instead of letting the overruns disappear into the total.
    var overCount = listed.budgets.filter(function (b) {
      var p = b.progress;
      return b.period_type === 'monthly' && p && p.spent != null && p.spent > p.effectiveAmount + 0.005;
    }).length;
    if (totalPen > 0) budget = { totalPen: totalPen, spentPen: budgetSpent, programmedPen: listed.summary.monthProgrammedPen || 0, daysLeft: pace.curDays - curDay, overCount: overCount };
  }

  return { months: months, pace: pace, budget: budget, trips: homeActiveTrips_(today), unreadable: unreadableSheetRows_(), charges: pendingChargesSummary_(),
    repeat: homeRepeatCandidate_(curKey, prevKey), budgetHint: homeBudgetHint_(prevKey), inboxNew: homeInboxNew_(), monthlyUncat: homeMonthlyUncategorized_(curKey, prevKey),
    exchangeLinks: exchangeLinkSuggestionCount_() };
}

// "Restaurants was your biggest spending last month: set a limit?" — only while the person has no budget at all, once their entries
// span 30 days or more: last month's biggest expense category (own share, main currency). Null otherwise.
function homeBudgetHint_(prevKey) {
  if (getAllRows('Budgets').length) return null;
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed' && e.type === 'expense'; });
  if (!entries.length) return null;
  var first = entries.reduce(function (m, e) { return String(e.date) < m ? String(e.date) : m; }, '9999');
  if (Math.abs(daysBetweenDates_(first, formatCalendarDate_(new Date()))) < 30) return null;
  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (sp) { splitSum[sp.entry_id] = (splitSum[sp.entry_id] || 0) + Number(sp.amount); });
  var byCat = {};
  entries.forEach(function (e) {
    if (String(e.date).substring(0, 7) !== prevKey || !e.category_id) return;
    var rate = getRateForTotals_(e.currency, e.date);
    if (rate == null) return;
    byCat[e.category_id] = (byCat[e.category_id] || 0) + (Number(e.amount) - (splitSum[e.id] || 0)) * rate;
  });
  var top = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; })[0];
  if (!top || !(byCat[top] > 0)) return null;
  return { category_id: top, amount: Math.round(byCat[top] * 100) / 100, month: prevKey };
}

// Statements the bank e-mailed that wait in the Statements Inbox (Carlos found five on day 150): how many, and the newest one's bank.
function homeInboxNew_() {
  try {
    ensureStatementInboxSheet_();
    var rows = getAllRows('Statement Inbox').filter(function (r) { return r.status === 'new'; });
    if (!rows.length) return null;
    rows.sort(function (a, b) { return String(a.received) < String(b.received) ? 1 : -1; });
    return { count: rows.length, bank: String(rows[0].bank_label || ''), newest: String(rows[0].received || '').substring(0, 10) };
  } catch (e) { return null; }
}

// The same amount arriving with NO category in two months running (Lucía's car payment and school fee): a likely monthly payment.
// The biggest such amount not already a Programmed item's. Null when none.
function homeMonthlyUncategorized_(curKey, prevKey) {
  var byAmt = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'expense' || e.category_id || e.recurring_expense_id || (e.status !== 'confirmed' && e.status !== 'pending')) return;
    var k = String(e.date).substring(0, 7);
    if (k !== curKey && k !== prevKey) return;
    var key = e.currency + '|' + Math.round(Math.abs(Number(e.amount)) * 100);
    var g = byAmt[key] = byAmt[key] || {};
    g[k === curKey ? 'cur' : 'prev'] = e;
  });
  var planned = getAllRows('Recurring Expenses').filter(function (r) { return String(r.active) !== 'false'; });
  var best = null;
  Object.keys(byAmt).forEach(function (key) {
    var g = byAmt[key];
    if (!g.cur || !g.prev) return;
    var a = Math.abs(Number(g.cur.amount));
    if (planned.some(function (r) { return r.currency === g.cur.currency && Math.abs(Math.abs(Number(r.amount)) - a) < 0.01; })) return;
    if (!best || a > Math.abs(Number(best.amount))) best = g.cur;
  });
  if (!best) return null;
  return { key: best.currency + '|' + Math.round(Math.abs(Number(best.amount)) * 100), description: String(best.description || ''), amount: Math.abs(Number(best.amount)),
    currency: best.currency, day: Number(String(best.date).substring(8, 10)) };
}

// Home's suggestion "You recorded X again this month: make it repeat?" (owner's plan, 2026-11-17, after the journeys run: six people
// typed their salary or a bill by hand month after month and nothing suggested a Programmed item). The same kind (expense / income),
// category and payee, confirmed last month AND this month, amounts within 20%, neither linked to a Programmed item, and no Programmed
// item of that category and a similar amount yet. The biggest such pair; null when none. Read only; part of getHomeGlance (no extra call).
function homeRepeatCandidate_(curKey, prevKey) {
  var payee = function (e) { return String(e.merchant || e.description || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  var groups = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || (e.type !== 'expense' && e.type !== 'income') || e.recurring_expense_id || !e.category_id) return;
    var k = String(e.date).substring(0, 7);
    if (k !== curKey && k !== prevKey) return;
    var who = payee(e);
    if (!who) return;
    var g = groups[e.type + '|' + e.category_id + '|' + who + '|' + e.currency] = groups[e.type + '|' + e.category_id + '|' + who + '|' + e.currency] || { cur: null, prev: null };
    var slot = k === curKey ? 'cur' : 'prev';
    if (!g[slot] || Number(e.amount) > Number(g[slot].amount)) g[slot] = e;
  });
  var planned = getAllRows('Recurring Expenses').filter(function (r) { return String(r.active) !== 'false' && (!r.end_date || String(r.end_date) >= curKey + '-01'); });
  var best = null;
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (!g.cur || !g.prev) return;
    var a = Math.abs(Number(g.cur.amount)), b = Math.abs(Number(g.prev.amount));
    if (!(a > 0) || !(b > 0) || Math.abs(a - b) > 0.2 * Math.max(a, b)) return;
    var already = planned.some(function (r) {
      var ra = Math.abs(Number(r.amount));
      return String(r.category_id) === String(g.cur.category_id) && r.currency === g.cur.currency && ra > 0 && Math.abs(ra - a) <= 0.2 * Math.max(ra, a);
    });
    if (already) return;
    if (!best || a > Math.abs(Number(best.amount))) best = g.cur;
  });
  if (!best) return null;
  return { key: best.type + '|' + best.category_id + '|' + payee(best), type: best.type, category_id: best.category_id, description: String(best.description || ''),
    amount: Math.abs(Number(best.amount)), currency: best.currency, day: Number(String(best.date).substring(8, 10)) };
}

// Every month from the first confirmed entry to today: the totals (the Overview's month-by-month bars)
// and each month's running expenses by day (the Overview's spending-pace graph, which steps back through
// earlier months as a reference line). Same rules as getHomeGlance. A separate request on purpose: only
// the Overview asks for it, so Home's single glance request stays light.
var HOME_HISTORY_MAX_MONTHS_ = 120;

function getMonthlyHistory(payload) {
  // The Spending pace screen (owner, 2026-11-07) can follow only some categories (one category, or one budget's): their expenses only.
  var onlyCats = payload && payload.categoryIds && payload.categoryIds.length ? payload.categoryIds.map(String) : null;
  var today = formatCalendarDate_(new Date());
  var curKey = today.substring(0, 7);
  var curDay = Number(today.substring(8, 10));

  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount);
  });

  var perMonth = {};
  var dayExpense = {};
  var firstKey = curKey;
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || e.type === 'transfer') return;
    if (onlyCats && (e.type !== 'expense' || onlyCats.indexOf(String(e.category_id)) < 0)) return;
    var key = String(e.date).substring(0, 7);
    if (key > curKey) return;
    var rate = getRateForTotals_(e.currency, e.date);
    if (rate == null) return;
    var own = Number(e.amount);
    if (e.type === 'expense') own -= (splitSum[e.id] || 0);
    var pen = own * rate;
    var bucket = perMonth[key] || (perMonth[key] = { income: 0, expense: 0, investment: 0 });
    if (key < firstKey) firstKey = key;
    if (e.type === 'expense') {
      bucket.expense += pen;
      dayExpense[e.date] = (dayExpense[e.date] || 0) + pen;
    } else if (e.type === 'income') {
      bucket.income += pen;
    } else if (e.type === 'investment') {
      bucket.investment += pen;
    }
  });

  var count = (Number(curKey.substring(0, 4)) - Number(firstKey.substring(0, 4))) * 12 +
    Number(curKey.substring(5, 7)) - Number(firstKey.substring(5, 7)) + 1;
  var keys = homeMonthKeys_(today, Math.min(count, HOME_HISTORY_MAX_MONTHS_));
  var months = keys.map(function (k) {
    var b = perMonth[k] || { income: 0, expense: 0, investment: 0 };
    var days = homeDaysInMonth_(k);
    return {
      month: k,
      income: b.income, expense: b.expense, investment: b.investment,
      net: b.income - b.expense - b.investment,
      days: days,
      cum: homeCumulativeByDay_(dayExpense, k, k === curKey ? curDay : days)
    };
  });
  return { months: months, curDay: curDay };
}

// The Spending pace card in the Week, Year and Custom views (owner, 2026-11-08): each range's running expenses, day by day, up to
// today (a range still running) or to its end; plus its whole total. Same rules as getMonthlyHistory (own share, confirmed, in PEN).
var PACE_RANGE_MAX_DAYS_ = 400;
function getSpendingPace(payload) {
  var ranges = ((payload && payload.ranges) || []).filter(function (r) {
    return r && /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end) && r.start <= r.end && isoDayCount_(r.start, r.end) <= PACE_RANGE_MAX_DAYS_;
  }).slice(0, 2);
  var today = formatCalendarDate_(new Date());
  var lo = null, hi = null;
  ranges.forEach(function (r) { if (!lo || r.start < lo) lo = r.start; if (!hi || r.end > hi) hi = r.end; });
  var splitSum = {};
  var dayExpense = {};
  if (ranges.length) {
    getAllRows('Entry Splits').forEach(function (s) { splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount); });
    getAllRows('Entries').forEach(function (e) {
      if (e.status !== 'confirmed' || e.type !== 'expense') return;
      var d = String(e.date).substring(0, 10);
      if (d < lo || d > hi) return;
      var rate = getRateForTotals_(e.currency, e.date);
      if (rate == null) return;
      dayExpense[d] = (dayExpense[d] || 0) + (Number(e.amount) - (splitSum[e.id] || 0)) * rate;
    });
  }
  return {
    today: today,
    ranges: ranges.map(function (r) {
      var days = isoDayCount_(r.start, r.end);
      var upTo = today < r.start ? 0 : today >= r.end ? days : isoDayCount_(r.start, today);
      var cum = [], running = 0, whole = 0;
      for (var i = 0; i < days; i++) {
        whole += dayExpense[isoAddDays_(r.start, i)] || 0;
        if (i < upTo) { running = whole; cum.push(Math.round(running * 100) / 100); }
      }
      return { start: r.start, end: r.end, days: days, cum: cum, expense: Math.round(whole * 100) / 100 };
    })
  };
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
