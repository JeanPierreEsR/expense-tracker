/**
 * Phase 4: budgets per expense category, with Telegram alerts when spend
 * crosses a threshold. Progress reuses the same own_share/rate logic as
 * Reports.gs (getRateForEntryCurrency_, rowsById_), just scoped to one
 * category and one budget's own period instead of the whole Overview.
 */

var DEFAULT_BUDGET_THRESHOLDS = '50,75,100,110,125,150';

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

// Monthly budgets reset every calendar month, yearly ones every calendar
// year — periodKey is what Budget Alert Log dedupes alerts against, so a
// threshold already alerted this period never re-fires until the period
// rolls over.
function getBudgetPeriodBounds_(periodType, refDate) {
  var y = refDate.getFullYear();
  var m = refDate.getMonth();
  if (periodType === 'yearly') {
    return { startDate: y + '-01-01', endDate: y + '-12-31', periodKey: String(y) };
  }
  var lastDay = new Date(y, m + 1, 0).getDate();
  return {
    startDate: y + '-' + pad2_(m + 1) + '-01',
    endDate: y + '-' + pad2_(m + 1) + '-' + pad2_(lastDay),
    periodKey: y + '-' + pad2_(m + 1)
  };
}

// Progress for every budget needs the same underlying data (all confirmed
// expense entries, all splits, all exchange rates) — reading those sheets
// fresh per budget was the original approach, but with ~6,900+ Entries rows
// that meant one full sheet scan per budget (11 budgets measured at ~14s
// total). Building this context ONCE and computing every budget's progress
// from the in-memory result instead keeps it to a handful of sheet reads
// regardless of how many budgets exist.
function buildBudgetContext_() {
  var entries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.type === 'expense';
  });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  // Two lookups built from one Exchange Rates read: exact month (to convert
  // each entry to PEN, same as Reports.gs) and latest-on-file-so-far per
  // currency (to convert a PEN total into a budget's own currency — see
  // note on latestRateFor_ below).
  var monthRateByKey = {};
  var latestByCurrency = {};
  var currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  getAllRows('Exchange Rates').forEach(function (r) {
    monthRateByKey[r.currency + '|' + r.month] = Number(r.rate);
    if (r.month <= currentMonth) {
      var cur = latestByCurrency[r.currency];
      if (!cur || r.month > cur.month) latestByCurrency[r.currency] = { month: r.month, rate: Number(r.rate) };
    }
  });

  var spendEntries = entries.map(function (e) {
    var rate = e.currency === 'PEN' ? 1 : monthRateByKey[e.currency + '|' + String(e.date).substring(0, 7)];
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    return {
      category_id: e.category_id,
      date: e.date,
      ownAmountPen: rate != null ? ownAmount * rate : null
    };
  });

  return { spendEntries: spendEntries, latestByCurrency: latestByCurrency };
}

function categorySpendPenFromContext_(ctx, categoryId, startDate, endDate) {
  var total = 0;
  ctx.spendEntries.forEach(function (e) {
    if (e.category_id !== categoryId || e.ownAmountPen == null) return;
    if (e.date < startDate || e.date > endDate) return;
    total += e.ownAmountPen;
  });
  return total;
}

// A budget set in a foreign currency compares against today's best-known
// rate for it (the most recent month on file, at or before this month) —
// there's no single "right" rate for a period that can span many months
// (a yearly budget), so this reads as "what that spend is worth right now"
// rather than trying to re-derive a period-specific figure.
function latestRateFromContext_(ctx, currency) {
  if (currency === 'PEN') return 1;
  var entry = ctx.latestByCurrency[currency];
  return entry ? entry.rate : null;
}

function computeBudgetProgressWithContext_(budget, ctx) {
  var bounds = getBudgetPeriodBounds_(budget.period_type, new Date());
  var spentPen = categorySpendPenFromContext_(ctx, budget.category_id, bounds.startDate, bounds.endDate);
  var currency = budget.currency || 'PEN';
  var rate = latestRateFromContext_(ctx, currency);
  var spent = rate != null ? spentPen / rate : null;
  var percent = (rate != null && Number(budget.amount) > 0) ? (spent / Number(budget.amount)) * 100 : null;

  return {
    periodKey: bounds.periodKey,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    spentPen: spentPen,
    spent: spent,
    percent: percent,
    rateAvailable: rate != null
  };
}

function listBudgets() {
  var categoryById = rowsById_(getAllRows('Categories'));
  var ctx = buildBudgetContext_();
  return getAllRows('Budgets').map(function (b) {
    var cat = categoryById[b.category_id];
    return {
      id: b.id,
      category_id: b.category_id,
      category_name: cat ? cat.name : '(unknown category)',
      category_icon: cat ? cat.icon : '',
      category_color: cat ? cat.color : '',
      amount: Number(b.amount),
      currency: b.currency || 'PEN',
      period_type: b.period_type === 'yearly' ? 'yearly' : 'monthly',
      thresholds: b.thresholds || DEFAULT_BUDGET_THRESHOLDS,
      progress: computeBudgetProgressWithContext_(b, ctx)
    };
  });
}

function addBudget(payload) {
  var budget = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    amount: payload.amount,
    currency: payload.currency || 'PEN',
    period_type: payload.period_type === 'yearly' ? 'yearly' : 'monthly',
    thresholds: payload.thresholds || DEFAULT_BUDGET_THRESHOLDS
  };
  appendRowObject('Budgets', budget);
  return budget;
}

function updateBudget(payload) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Budget not found');

  ['category_id', 'amount', 'currency', 'period_type', 'thresholds'].forEach(function (field) {
    if (payload[field] !== undefined) {
      setCellByRow_(sheet, headers, rowIndex, field, payload[field]);
    }
  });
  return { done: true };
}

function deleteBudget(id) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);

  // Its alert history is meaningless once the budget is gone.
  var logSheet = getSheet('Budget Alert Log');
  var logHeaders = getHeaders(logSheet);
  var budgetIdCol = logHeaders.indexOf('budget_id');
  var lastRow = logSheet.getLastRow();
  if (lastRow > 1) {
    var data = logSheet.getRange(2, 1, lastRow - 1, logHeaders.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][budgetIdCol] === id) logSheet.deleteRow(i + 2);
    }
  }
  return { done: true };
}

// Runs on the same 15-minute automation cycle as the email scan. Each
// budget can cross several thresholds between runs (a big purchase can
// jump 40% -> 90% in one entry) — every newly-crossed threshold gets its
// own alert and its own Budget Alert Log row, so none are silently skipped.
function checkBudgets() {
  var budgets = getAllRows('Budgets');
  if (!budgets.length) return { checked: 0, alertsSent: 0 };

  var categoryById = rowsById_(getAllRows('Categories'));
  var ctx = buildBudgetContext_();
  var alertedSet = {};
  getAllRows('Budget Alert Log').forEach(function (a) {
    alertedSet[a.budget_id + '|' + a.period + '|' + a.threshold] = true;
  });

  var alertsSent = 0;
  budgets.forEach(function (budget) {
    var progress = computeBudgetProgressWithContext_(budget, ctx);
    if (progress.percent == null) return; // no exchange rate on file yet for this budget's currency

    var thresholds = String(budget.thresholds || DEFAULT_BUDGET_THRESHOLDS)
      .split(',')
      .map(function (t) { return Number(String(t).trim()); })
      .filter(function (t) { return !isNaN(t); })
      .sort(function (a, b) { return a - b; });

    thresholds.forEach(function (threshold) {
      if (progress.percent < threshold) return;
      var key = budget.id + '|' + progress.periodKey + '|' + threshold;
      if (alertedSet[key]) return;

      var sent = sendTelegramBudgetAlert_(budget, categoryById[budget.category_id], threshold, progress);
      if (!sent) return; // Telegram not configured — don't mark as alerted, try again next cycle

      appendRowObject('Budget Alert Log', {
        id: Utilities.getUuid(),
        budget_id: budget.id,
        threshold: threshold,
        period: progress.periodKey,
        sent_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
      });
      alertedSet[key] = true;
      alertsSent++;
    });
  });

  return { checked: budgets.length, alertsSent: alertsSent };
}

// One-off convenience: seed monthly budgets for the owner's biggest expense
// categories, valued at what they actually spend on average. Not exposed in
// the app UI — same pattern as the other one-time admin scripts in this
// project (mergeDuplicatePaymentMethods, addCreatedAtColumnToEntries).
// Window is the last N *complete* calendar months, excluding the current
// one in progress — a partial month would understate the average and skew
// which categories rank highest.
function computeCategoryMonthlyAverages_(startDate, endDate, monthCount) {
  var entries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.type === 'expense' && e.date >= startDate && e.date <= endDate;
  });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  var totals = {};
  entries.forEach(function (e) {
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    if (rate == null) return;
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    var key = e.category_id || '';
    totals[key] = (totals[key] || 0) + ownAmount * rate;
  });

  var averages = {};
  Object.keys(totals).forEach(function (catId) {
    averages[catId] = totals[catId] / monthCount;
  });
  return averages;
}

function generateTopCategoryBudgets(payload) {
  var topN = (payload && payload.topN) || 10;
  var monthCount = (payload && payload.monthCount) || 12;

  var today = new Date();
  var endMonthDate = new Date(today.getFullYear(), today.getMonth(), 0); // last day of the previous month
  var startMonthDate = new Date(endMonthDate.getFullYear(), endMonthDate.getMonth() - (monthCount - 1), 1);

  var startDate = startMonthDate.getFullYear() + '-' + pad2_(startMonthDate.getMonth() + 1) + '-01';
  var endLastDay = new Date(endMonthDate.getFullYear(), endMonthDate.getMonth() + 1, 0).getDate();
  var endDate = endMonthDate.getFullYear() + '-' + pad2_(endMonthDate.getMonth() + 1) + '-' + pad2_(endLastDay);

  var averages = computeCategoryMonthlyAverages_(startDate, endDate, monthCount);
  var categoryById = rowsById_(getAllRows('Categories'));

  var ranked = Object.keys(averages)
    .filter(function (catId) { return catId && categoryById[catId] && categoryById[catId].type === 'expense'; })
    .map(function (catId) { return { category_id: catId, avg: averages[catId] }; })
    .sort(function (a, b) { return b.avg - a.avg; })
    .slice(0, topN);

  var created = ranked.map(function (r) {
    var budget = addBudget({
      category_id: r.category_id,
      amount: Math.round(r.avg * 100) / 100,
      currency: 'PEN',
      period_type: 'monthly',
      thresholds: DEFAULT_BUDGET_THRESHOLDS
    });
    return {
      id: budget.id,
      category_id: r.category_id,
      category_name: categoryById[r.category_id].name,
      amount: budget.amount
    };
  });

  return { startDate: startDate, endDate: endDate, monthCount: monthCount, created: created };
}
