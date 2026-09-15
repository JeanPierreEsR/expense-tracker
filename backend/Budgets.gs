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

  // monthRateByKey converts each entry to PEN (exact month, same as
  // Reports.gs). ratesByCurrency keeps every rate on file per currency,
  // sorted — unlike a single "latest as of today" cutoff, viewing a past
  // period (Overview-style navigation, see resolveEffectivePeriodType_)
  // needs "latest as of THAT period", so the cutoff is resolved per-lookup
  // rather than baked in here.
  var monthRateByKey = {};
  var ratesByCurrency = {};
  getAllRows('Exchange Rates').forEach(function (r) {
    monthRateByKey[r.currency + '|' + r.month] = Number(r.rate);
    if (!ratesByCurrency[r.currency]) ratesByCurrency[r.currency] = [];
    ratesByCurrency[r.currency].push({ month: r.month, rate: Number(r.rate) });
  });
  Object.keys(ratesByCurrency).forEach(function (c) {
    ratesByCurrency[c].sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  });

  var spendEntries = entries.map(function (e) {
    var rate = e.currency === 'PEN' ? 1 : monthRateByKey[e.currency + '|' + String(e.date).substring(0, 7)];
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    return {
      category_id: e.category_id,
      date: e.date,
      currency: e.currency,
      ownAmount: ownAmount, // in the entry's own original currency
      ownAmountPen: rate != null ? ownAmount * rate : null
    };
  });

  return { spendEntries: spendEntries, ratesByCurrency: ratesByCurrency };
}

// A budget's `category_id` column holds either a single id, a
// comma-separated list of ids (several categories), or the literal string
// 'ALL' (every expense category) — null return means "no filter, match
// anything", an array means "match only these". Existing budgets already
// hold exactly one id, which is just a one-item list under this reading,
// so no migration was needed to support this.
function parseBudgetCategoryIds_(raw) {
  if (raw === 'ALL') return null;
  return String(raw || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function categoryIdMatches_(categoryIds, entryCategoryId) {
  return categoryIds === null || categoryIds.indexOf(entryCategoryId) !== -1;
}

function categorySpendPenFromContext_(ctx, categoryIds, startDate, endDate) {
  var total = 0;
  ctx.spendEntries.forEach(function (e) {
    if (!categoryIdMatches_(categoryIds, e.category_id) || e.ownAmountPen == null) return;
    if (e.date < startDate || e.date > endDate) return;
    total += e.ownAmountPen;
  });
  return total;
}

// Sums a category's spend directly in a target currency (a budget's own
// currency) rather than always going PEN total -> re-divide by a rate.
// An entry already recorded in the target currency contributes exactly
// what was paid, no conversion at all — the most accurate figure there
// is, and the whole reason this exists: for a USD budget, USD entries
// (the common case) no longer get converted PEN -> USD through today's
// rate only to drift from what was actually paid whenever that differs
// from the rate used when the entry itself was saved. Anything in a
// different currency still goes through PEN, same as everywhere else.
function categorySpendInCurrencyFromContext_(ctx, categoryIds, startDate, endDate, targetCurrency, cutoffMonth) {
  var rate = null;
  if (targetCurrency !== 'PEN') {
    rate = latestRateAtOrBefore_(ctx, targetCurrency, cutoffMonth);
    if (rate == null) return null; // no rate for the budget's own currency at all — can't produce a figure
  }

  var total = 0;
  ctx.spendEntries.forEach(function (e) {
    if (!categoryIdMatches_(categoryIds, e.category_id)) return;
    if (e.date < startDate || e.date > endDate) return;

    if (e.currency === targetCurrency) {
      total += e.ownAmount;
    } else if (e.ownAmountPen != null) {
      total += targetCurrency === 'PEN' ? e.ownAmountPen : e.ownAmountPen / rate;
    }
    // else: no rate on file for THIS entry's own month — silently
    // excluded, same as the plain-PEN sum above has always done.
  });
  return total;
}

// Display name/icon/color for a budget's category set — a real category's
// own icon/color for one category, a generic "combined budget" marker for
// several or ALL (a joined name list gets long, and the row's own CSS
// already ellipsizes long names — see budget-row-name in style.css).
function resolveBudgetCategoryDisplay_(categoryIds, categoryById) {
  if (categoryIds === null) {
    return { name: 'All expense categories', icon: '🗂️', color: '' };
  }
  if (categoryIds.length === 1) {
    var cat = categoryById[categoryIds[0]];
    return {
      name: cat ? cat.name : '(unknown category)',
      icon: cat ? cat.icon : '',
      color: cat ? cat.color : ''
    };
  }
  var names = categoryIds.map(function (id) {
    var c = categoryById[id];
    return c ? c.name : '(unknown category)';
  });
  return { name: names.join(', '), icon: '🗂️', color: '' };
}

// A budget set in a foreign currency compares against the best-known rate
// for it as of the period being shown (the most recent month on file, at
// or before that period's own end month) — there's no single "right" rate
// for a period that can span many months (a yearly budget), so this reads
// as "what that spend was worth around then" rather than a re-derived
// period-specific figure. cutoffMonth is the effective period's own end
// month, per CLAUDE.md's "rates are always keyed to calendar months, even
// when viewing custom periods" — using today's rate to judge a past period
// would be inconsistent with how every other rate lookup in the app works.
function latestRateAtOrBefore_(ctx, currency, cutoffMonth) {
  if (currency === 'PEN') return 1;
  var list = ctx.ratesByCurrency[currency];
  if (!list) return null;
  var best = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i].month <= cutoffMonth) best = list[i];
  }
  return best ? best.rate : null;
}

// The viewing period (Overview-style Month/Year/All-time/Custom) can widen
// what a budget is measured over, but never narrow it — a yearly budget
// always reflects the whole year regardless of what's being browsed, and a
// monthly budget viewed at yearly granularity shows its progress across
// the whole year instead of vanishing back to just the current month.
// All-time/Custom have no month/year size to compare against, so a budget
// just shows its own native period in that case (same as before periods
// were browsable here at all).
function resolveEffectivePeriodType_(budgetPeriodType, displayPeriodType) {
  if (displayPeriodType === 'year') return 'yearly';
  return budgetPeriodType;
}

function computeBudgetProgressWithContext_(budget, ctx, displayPeriodType, anchorDate) {
  var effectivePeriodType = resolveEffectivePeriodType_(budget.period_type, displayPeriodType);
  var usesAnchor = (displayPeriodType === 'month' || displayPeriodType === 'year') && anchorDate;
  var refDate = usesAnchor ? new Date(anchorDate + 'T00:00:00') : new Date();

  var categoryIds = parseBudgetCategoryIds_(budget.category_id);
  var bounds = getBudgetPeriodBounds_(effectivePeriodType, refDate);
  var spentPen = categorySpendPenFromContext_(ctx, categoryIds, bounds.startDate, bounds.endDate);

  // A monthly budget's amount is a per-month figure — shown across a full
  // year, its natural yearly equivalent is that figure times 12. (Never
  // the other way around: a yearly budget's amount already IS the whole
  // year's figure, so it's never divided down for a monthly view — see
  // resolveEffectivePeriodType_.)
  var annualized = effectivePeriodType === 'yearly' && budget.period_type === 'monthly';
  var effectiveAmount = Number(budget.amount) * (annualized ? 12 : 1);

  var currency = budget.currency || 'PEN';
  var cutoffMonth = bounds.endDate.substring(0, 7);
  var spent = categorySpendInCurrencyFromContext_(ctx, categoryIds, bounds.startDate, bounds.endDate, currency, cutoffMonth);
  var percent = (spent != null && effectiveAmount > 0) ? (spent / effectiveAmount) * 100 : null;

  // The actual rate behind spent/percent above, surfaced so a foreign-
  // currency budget can show what it's using rather than leaving the
  // conversion invisible — see categorySpendInCurrencyFromContext_ for how
  // it's applied (only entries NOT already in this currency go through it).
  var rate = latestRateAtOrBefore_(ctx, currency, cutoffMonth);

  return {
    effectivePeriodType: effectivePeriodType,
    annualized: annualized,
    periodKey: bounds.periodKey,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    spentPen: spentPen,
    spent: spent,
    effectiveAmount: effectiveAmount,
    percent: percent,
    rateAvailable: spent != null,
    rate: rate
  };
}

// displayPeriodType/anchorDate come from the app's shared period selector
// (the same one Overview uses) — omitted, budgets fall back to their own
// native period as of right now, e.g. for the automation trigger (see
// checkBudgets) where "what's being browsed" doesn't apply.
function listBudgets(payload) {
  var displayPeriodType = payload && payload.displayPeriodType;
  var anchorDate = payload && payload.anchorDate;

  var categoryById = rowsById_(getAllRows('Categories'));
  var ctx = buildBudgetContext_();
  var rawBudgets = getAllRows('Budgets');

  // "Today's" rate, not the browsed period's — amount_pen and the summary
  // totals below describe standing budget commitments, not spend against a
  // specific past period, so there's no period to key the rate to.
  var currentMonth = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');

  var budgets = rawBudgets.map(function (b) {
    var categoryIds = parseBudgetCategoryIds_(b.category_id);
    var display = resolveBudgetCategoryDisplay_(categoryIds, categoryById);
    var currency = b.currency || 'PEN';
    var rate = latestRateAtOrBefore_(ctx, currency, currentMonth);
    return {
      id: b.id,
      category_id: b.category_id,
      category_ids: categoryIds, // array of specific ids, or null for "ALL"
      all_categories: categoryIds === null,
      category_name: display.name,
      category_icon: display.icon,
      category_color: display.color,
      amount: Number(b.amount),
      amount_pen: rate != null ? Number(b.amount) * rate : null,
      currency: currency,
      period_type: b.period_type === 'yearly' ? 'yearly' : 'monthly',
      thresholds: b.thresholds || DEFAULT_BUDGET_THRESHOLDS,
      progress: computeBudgetProgressWithContext_(b, ctx, displayPeriodType, anchorDate)
    };
  });

  // Yearly budgets first, largest first; monthly budgets after, largest
  // first — grouped by the budget's own definition, not by whatever's
  // currently displayed, so the order doesn't reshuffle as you browse
  // periods. amount_pen makes "largest" comparable across currencies;
  // budgets with no rate on file (amount_pen null) sort last within their
  // group.
  budgets.sort(function (a, b) {
    var orderA = a.period_type === 'yearly' ? 0 : 1;
    var orderB = b.period_type === 'yearly' ? 0 : 1;
    if (orderA !== orderB) return orderA - orderB;
    var pa = a.amount_pen == null ? -1 : a.amount_pen;
    var pb = b.amount_pen == null ? -1 : b.amount_pen;
    return pb - pa;
  });

  // Two views of the same total: a yearly budget's amount already IS a
  // yearly figure (divide by 12 for its monthly-equivalent share); a
  // monthly budget's amount times 12 gives its yearly-equivalent. The
  // yearly total is always exactly 12x the monthly one by construction —
  // shown as two numbers anyway since "per month" and "per year" are both
  // useful at a glance without doing the math.
  var monthlyPen = 0, yearlyPen = 0, excludedCount = 0;
  rawBudgets.forEach(function (b) {
    var currency = b.currency || 'PEN';
    var rate = latestRateAtOrBefore_(ctx, currency, currentMonth);
    if (rate == null) { excludedCount++; return; }
    var amount = Number(b.amount);
    var monthlyAmount = b.period_type === 'yearly' ? amount / 12 : amount;
    var yearlyAmount = b.period_type === 'yearly' ? amount : amount * 12;
    monthlyPen += monthlyAmount * rate;
    yearlyPen += yearlyAmount * rate;
  });

  return {
    budgets: budgets,
    summary: { monthlyPen: monthlyPen, yearlyPen: yearlyPen, excludedCount: excludedCount }
  };
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

      var display = resolveBudgetCategoryDisplay_(parseBudgetCategoryIds_(budget.category_id), categoryById);
      var sent = sendTelegramBudgetAlert_(budget, display.name, threshold, progress);
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
