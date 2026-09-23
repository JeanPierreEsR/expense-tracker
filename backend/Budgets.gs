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

  // ratesByCurrency keeps every rate on file per currency, sorted — each
  // entry converts at the most recent rate on file at or before its own
  // month (see getLatestRateOnOrBefore_/latestRateAtOrBefore_ — the
  // general fallback rule, since an entry's own PEN figure here is a
  // derived report value, not the act of saving the entry). Unlike a
  // single "latest as of today" cutoff, viewing a past period
  // (Overview-style navigation, see resolveEffectivePeriodType_) needs
  // "latest as of THAT period" for the budget's OWN currency lookups
  // below, so the cutoff is resolved per-lookup rather than baked in here.
  var ratesByCurrency = {};
  getAllRows('Exchange Rates').forEach(function (r) {
    if (!ratesByCurrency[r.currency]) ratesByCurrency[r.currency] = [];
    ratesByCurrency[r.currency].push({ month: r.month, rate: Number(r.rate) });
  });
  Object.keys(ratesByCurrency).forEach(function (c) {
    ratesByCurrency[c].sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  });
  var ctxForEntryRates = { ratesByCurrency: ratesByCurrency };

  var spendEntries = entries.map(function (e) {
    var entryMonth = String(e.date).substring(0, 7);
    var rate = latestRateAtOrBefore_(ctxForEntryRates, e.currency, entryMonth);
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

// An optional custom name overrides the category-derived one everywhere a
// budget's name is shown (its row, drill-down title, Telegram alerts) —
// blank/whitespace-only falls back to the category name, same as before
// this field existed.
function resolveBudgetDisplayName_(budget, categoryDisplayName) {
  var custom = String(budget.name || '').trim();
  return custom || categoryDisplayName;
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
  return latestRateFromList_(ctx.ratesByCurrency[currency], cutoffMonth);
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
      name: b.name || '', // raw, for the edit form's own input
      category_name: resolveBudgetDisplayName_(b, display.name), // custom name if set, else the category name
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

  // ---- Dedup categories before totaling, so an "all categories" budget
  // plus narrower budgets inside it don't get added on top of each other —
  // only the total possible spend matters here, and a budget whose
  // categories are entirely covered by another budget doesn't raise that
  // ceiling any further. Applies regardless of period_type: a monthly and
  // a yearly budget on the very same category are the same case (two caps
  // on one spend pool), not two independent amounts to add together.
  var allExpenseCategoryIds = Object.keys(categoryById).filter(function (id) {
    return categoryById[id].type === 'expense';
  });
  function idSetFor_(categoryIds) {
    var ids = categoryIds === null ? allExpenseCategoryIds : categoryIds;
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    return set;
  }
  function isSubset_(small, big) {
    for (var id in small) { if (!big[id]) return false; }
    return true;
  }
  function setSize_(set) { return Object.keys(set).length; }

  var budgetSets = budgets.map(function (b) { return idSetFor_(b.category_ids); });

  // dominated[i] === true means budget i's categories are already fully
  // covered by some other budget j, so i is left out of the total. When
  // two budgets cover the exact same categories, only one survives (the
  // larger PEN amount, tie-broken by id) — otherwise an identical pair
  // would each "contain" the other and both would vanish.
  var dominated = budgets.map(function () { return false; });
  for (var i = 0; i < budgets.length; i++) {
    for (var j = 0; j < budgets.length; j++) {
      if (i === j || !isSubset_(budgetSets[i], budgetSets[j])) continue;
      var equalSets = setSize_(budgetSets[i]) === setSize_(budgetSets[j]);
      if (!equalSets) { dominated[i] = true; break; }
      var pi = budgets[i].amount_pen == null ? -1 : budgets[i].amount_pen;
      var pj = budgets[j].amount_pen == null ? -1 : budgets[j].amount_pen;
      if (pj > pi || (pj === pi && String(budgets[j].id) > String(budgets[i].id))) {
        dominated[i] = true;
        break;
      }
    }
  }

  // Total per month only counts budgets that are actually monthly — a
  // yearly budget's own amount ÷ 12 is just an average, and folding that
  // average into "this month's" total implies a per-month cap that isn't
  // real (a yearly budget lets spending run uneven across months as long
  // as the year-end total holds). Total per year has no such mismatch, so
  // it still counts every surviving budget, converting monthly ones ×12.
  var monthlyPen = 0, yearlyPen = 0, excludedCount = 0;
  budgets.forEach(function (b, idx) {
    if (dominated[idx]) return;
    if (b.amount_pen == null) { excludedCount++; return; }
    if (b.period_type !== 'yearly') monthlyPen += b.amount_pen;
    yearlyPen += b.period_type === 'yearly' ? b.amount_pen : b.amount_pen * 12;
  });

  // Budgets that survive the dedup above (none fully contains the other)
  // can still partly overlap — e.g. "Car" and "Monthly essentials" both
  // including Transport. Unlike full containment, there's no single
  // correct total then, so this just surfaces it rather than guessing.
  var overlapNotes = [];
  for (var a = 0; a < budgets.length; a++) {
    if (dominated[a]) continue;
    for (var c = a + 1; c < budgets.length; c++) {
      if (dominated[c]) continue;
      var shared = [];
      for (var sid in budgetSets[a]) {
        if (budgetSets[c][sid]) shared.push(sid);
      }
      if (shared.length === 0) continue;
      var sharedNames = shared.map(function (id) {
        return categoryById[id] ? categoryById[id].name : id;
      }).join(', ');
      overlapNotes.push(
        '"' + budgets[a].category_name + '" and "' + budgets[c].category_name +
        '" both include ' + sharedNames + ' — total may overstate your real ceiling.'
      );
    }
  }

  return {
    budgets: budgets,
    summary: {
      monthlyPen: monthlyPen,
      yearlyPen: yearlyPen,
      excludedCount: excludedCount,
      overlapNotes: overlapNotes
    }
  };
}

// Feeds the drill-down's line chart: actual spend per day, still-outstanding
// recurring expenses attributed to their actual calendar day within the
// period, and the same year-to-date "Expected" rate Projections uses,
// summed across every category this budget covers — all in the budget's
// own currency, same conversion rule as everywhere else in this file (an
// entry/recurring item already in the budget's currency contributes
// exactly its own amount, no conversion). startDate/endDate come from the
// budget's already-computed progress (see computeBudgetProgressWithContext_),
// so this doesn't re-derive period bounds on its own; periodType (monthly/
// yearly) is needed separately for the same "skip a yearly-only category"
// rule Projections applies.
function getBudgetChartSeries(payload) {
  var startDate = payload.startDate;
  var endDate = payload.endDate;
  var rawBudget = getAllRows('Budgets').filter(function (b) { return b.id === payload.budgetId; })[0];
  if (!rawBudget) throw new Error('Budget not found');

  var categoryIds = parseBudgetCategoryIds_(rawBudget.category_id);
  var currency = rawBudget.currency || 'PEN';
  var ctx = buildBudgetContext_();
  var cutoffMonth = endDate.substring(0, 7);
  var rate = latestRateAtOrBefore_(ctx, currency, cutoffMonth);

  var dailySpend = {};
  ctx.spendEntries.forEach(function (e) {
    if (!categoryIdMatches_(categoryIds, e.category_id)) return;
    if (e.date < startDate || e.date > endDate) return;
    var amt = null;
    if (e.currency === currency) {
      amt = e.ownAmount;
    } else if (e.ownAmountPen != null) {
      amt = currency === 'PEN' ? e.ownAmountPen : (rate != null ? e.ownAmountPen / rate : null);
    }
    if (amt == null) return;
    dailySpend[e.date] = (dailySpend[e.date] || 0) + amt;
  });

  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var entrySplitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSumByEntry[s.entry_id] = (entrySplitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  // Raw (unshaped) confirmed entries in range — buildBudgetContext_'s own
  // spendEntries strip fields (id, full amount, recurring_expense_id) that
  // entryMatchesRecurringOccurrence_ needs, so this reads them separately
  // rather than reshaping that shared context.
  var entriesInRange = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.date >= startDate && e.date <= endDate &&
      categoryIdMatches_(categoryIds, e.category_id);
  });

  // Only occurrences WITHOUT a matching confirmed entry become a bump —
  // same "Programmed" rule Projections uses (fixed 2026-09-22 here too:
  // this used to include every occurrence in range regardless of whether
  // it was already paid, so an already-recorded rent payment could still
  // show as a phantom future bump on top of its own real entry already
  // sitting in the actual line).
  var recurringOccurrences = [];
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false' || !categoryIdMatches_(categoryIds, r.category_id)) return;
    var reCurrency = r.currency || 'PEN';
    var ownAmount = recurringOwnAmount_(r, recurringSplitSums);
    var amt = null;
    if (reCurrency === currency) {
      amt = ownAmount;
    } else {
      var rePen = null;
      if (reCurrency === 'PEN') {
        rePen = ownAmount;
      } else {
        var reRate = latestRateAtOrBefore_(ctx, reCurrency, cutoffMonth);
        rePen = reRate != null ? ownAmount * reRate : null;
      }
      if (rePen != null) amt = currency === 'PEN' ? rePen : (rate != null ? rePen / rate : null);
    }
    if (amt == null) return;
    recurringExpenseOccurrencesInRange_(r, startDate, endDate)
      .filter(function (date) {
        return !entriesInRange.some(function (e) {
          return entryMatchesRecurringOccurrence_(e, r, [date], entrySplitSumByEntry, recurringSplitSums);
        });
      })
      .forEach(function (date) {
        recurringOccurrences.push({ date: date, amount: amt, description: r.description || '' });
      });
  });

  // "Expected" — the exact same year-to-date rate Projections computes
  // per category (computeCategoryYtdBreakdown_, Projections.gs), pro-rated
  // to the days actually left (daysLeftInPeriod_, the same "N days left"
  // convention the Projections chart's own caption uses) and summed across
  // every category this budget covers, converted into the budget's own
  // currency the same way a recurring item's amount is above. A category
  // the owner has flagged `period_type: yearly` is skipped in anything but
  // a yearly view, same rule Projections applies — no smoothed monthly
  // guess for a cost that's only ever meaningful once a year.
  var daysLeft = daysLeftInPeriod_(startDate, endDate);
  var allExpenseCategories = getAllRows('Categories').filter(function (c) { return c.type === 'expense'; });
  var budgetCategories = categoryIds === null
    ? allExpenseCategories
    : allExpenseCategories.filter(function (c) { return categoryIds.indexOf(c.id) !== -1; });
  var expectedRemainingPen = 0;
  budgetCategories.forEach(function (cat) {
    if (String(cat.period_type || '').toLowerCase() === 'yearly' && payload.periodType !== 'yearly') return;
    var ytd = computeCategoryYtdBreakdown_(cat.id);
    expectedRemainingPen += ytd.ratePerMonth * (daysLeft / 30);
  });
  var expectedRemaining = currency === 'PEN' ? expectedRemainingPen : (rate != null ? expectedRemainingPen / rate : null);

  return {
    currency: currency,
    dailySpend: dailySpend,
    recurringOccurrences: recurringOccurrences,
    expectedRemaining: expectedRemaining || 0,
    daysLeft: daysLeft
  };
}

function addBudget(payload) {
  var budget = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    amount: payload.amount,
    currency: payload.currency || 'PEN',
    period_type: payload.period_type === 'yearly' ? 'yearly' : 'monthly',
    thresholds: payload.thresholds || DEFAULT_BUDGET_THRESHOLDS,
    name: payload.name ? String(payload.name).trim() : ''
  };
  appendRowObject('Budgets', budget);
  return budget;
}

function updateBudget(payload) {
  var sheet = getSheet('Budgets');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Budget not found');

  ['category_id', 'amount', 'currency', 'period_type', 'thresholds', 'name'].forEach(function (field) {
    if (payload[field] !== undefined) {
      var value = field === 'name' ? String(payload[field] || '').trim() : payload[field];
      setCellByRow_(sheet, headers, rowIndex, field, value);
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

// Same shape as adminDebugProjectionOverrides (Projections.gs) — a raw
// dump for diagnosing why an alert fired (or didn't), same
// diagnostic-only spirit.
function adminDebugBudgetAlertLog() {
  var sheet = getSheet('Budget Alert Log');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { rows: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return {
    headers: headers,
    rows: values.map(function (row) {
      return row.map(function (cell) { return { value: cell, jsType: typeof cell, str: String(cell) }; });
    })
  };
}

// Runs on the same 15-minute automation cycle as the email scan. A
// budget can cross several thresholds between runs (a big purchase, or —
// a real incident, see CHANGELOG.md § Budgets — a miscategorized entry
// that temporarily inflated a category — can jump 40% straight to
// 1900%+ in one check). Every newly-crossed threshold still gets its own
// Budget Alert Log row, so the per-threshold dedup stays exactly as
// precise as before and nothing is silently skipped — but only ONE
// Telegram message goes out per budget per run (fixed 2026-09-22, after
// the owner asked why they got 6 near-identical alerts in a row for one
// run that had legitimately crossed all 6 thresholds at once): the
// message already reports the current live percentage, not the specific
// threshold, so 6 messages in a row never said anything a single one
// didn't already cover.
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

    var newlyCrossed = thresholds.filter(function (threshold) {
      if (progress.percent < threshold) return false;
      return !alertedSet[budget.id + '|' + progress.periodKey + '|' + threshold];
    });
    if (!newlyCrossed.length) return;

    var display = resolveBudgetCategoryDisplay_(parseBudgetCategoryIds_(budget.category_id), categoryById);
    var highestThreshold = newlyCrossed[newlyCrossed.length - 1];
    var sent = sendTelegramBudgetAlert_(budget, resolveBudgetDisplayName_(budget, display.name), highestThreshold, progress);
    if (!sent) return; // Telegram not configured — don't mark any as alerted, try again next cycle

    newlyCrossed.forEach(function (threshold) {
      var key = budget.id + '|' + progress.periodKey + '|' + threshold;
      appendRowObject('Budget Alert Log', {
        id: Utilities.getUuid(),
        budget_id: budget.id,
        threshold: threshold,
        period: progress.periodKey,
        sent_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
      });
      alertedSet[key] = true;
    });
    alertsSent++;
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
