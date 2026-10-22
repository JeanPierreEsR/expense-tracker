/**
 * Projections: every category's own forward-looking estimate for whichever
 * period is being viewed (month or year, driven by the same shared period
 * selector Overview/Budgets use) — the Projections tab's top summary
 * (income/expenses/investments/net) is just these rolled up by type, not a
 * separate calculation, so the two can never disagree with each other.
 *
 * Per category:
 * - Income: recurring income for the period, PLUS any already-confirmed
 *   income entries in that period that aren't already explained by a
 *   recurring one (covers a bonus or one-off payment registered in
 *   advance). Never the past — a category with no recurring income and no
 *   entry already logged for the period projects as 0, rather than
 *   guessing from history.
 * - Expense / investment: recurring for the period, PLUS a year-to-date
 *   rate projected forward — total confirmed spend since Jan 1 in that
 *   category, MINUS whatever's already explained by a recurring item
 *   (the same entryMatchesRecurringOccurrence_ match used by "Expected
 *   this month"), divided by complete months elapsed this year, times
 *   the number of months the viewed period covers (1 for a month, 12 for
 *   a year).
 * A category's own manual override (Projection Overrides sheet), when
 * one exists for the exact period being viewed, replaces the calculated
 * total outright — see setProjectionOverride/deleteProjectionOverride.
 */

// pad2_ is defined in Budgets.gs (global scope across all .gs files).

// This table was added well after setupSpreadsheet() was last run for
// real — self-heals its own tab on first use, same reasoning and pattern
// as ensureRecurringExpensesSheet_.
function ensureProjectionOverridesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Projection Overrides')) return;
  var sheet = ss.insertSheet('Projection Overrides');
  var headers = TABLE_DEFINITIONS['Projection Overrides'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // period_key values ("2026-09", "2026") look enough like dates/numbers
  // that Sheets would otherwise silently convert them on write, breaking
  // every string comparison against them afterward — setupSpreadsheet()
  // applies this same '@' (plain text) format via DATE_LIKE_COLUMNS for
  // tables it creates itself, but this one self-heals outside that path.
  var periodKeyCol = headers.indexOf('period_key') + 1;
  if (periodKeyCol > 0) sheet.getRange(1, periodKeyCol, sheet.getMaxRows(), 1).setNumberFormat('@');
}

// One-off fix-up: deletes the tab so ensureProjectionOverridesSheet_
// recreates it (with the period_key column correctly forced to plain
// text) — needed once, since the very first self-heal ran before that
// formatting was added and Sheets had already silently mangled the one
// test row in it. Safe to run anytime the sheet only holds rows that are
// fine to lose; it does not run automatically.
function adminResetProjectionOverridesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Projection Overrides');
  if (sheet) ss.deleteSheet(sheet);
  ensureProjectionOverridesSheet_();
  return { done: true };
}

function adminDebugProjectionOverrides() {
  var sheet = getSheet('Projection Overrides');
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

function getProjectionOverrideRows_() {
  ensureProjectionOverridesSheet_();
  return getAllRows('Projection Overrides');
}

// { startDate, endDate, periodKey, periodType } for whichever period the
// shared selector is showing — Month and Year are the only ones that make
// sense for a projection (there's no such thing as an All-time or Custom
// projection), so anything else just falls back to the current month.
function projectionPeriodBounds_(displayPeriodType, anchorDate) {
  var usesAnchor = (displayPeriodType === 'month' || displayPeriodType === 'year') && anchorDate;
  var refDate = usesAnchor ? new Date(anchorDate + 'T00:00:00') : new Date();
  var y = refDate.getFullYear();
  if (displayPeriodType === 'year') {
    return { startDate: y + '-01-01', endDate: y + '-12-31', periodKey: String(y), periodType: 'yearly' };
  }
  var m = refDate.getMonth();
  var lastDay = new Date(y, m + 1, 0).getDate();
  return {
    startDate: y + '-' + pad2_(m + 1) + '-01',
    endDate: y + '-' + pad2_(m + 1) + '-' + pad2_(lastDay),
    periodKey: y + '-' + pad2_(m + 1),
    periodType: 'monthly'
  };
}

// The one place both the category list and the top summary compute a
// category's projection — see the file header for the actual rule.
// Returns one entry per category that has anything to show (a recurring
// item, an override, or any YTD/period history) — categories that have
// simply never been used stay out of the list rather than cluttering it
// with rows that are always PEN 0.00.
// Categories was already live with real data when the 'yearly-only'
// concept (below) was added — unlike a table created fresh via
// ensureXSheet_, an existing sheet's headers can't just be recreated, so
// this appends the one missing column in place, idempotently, the first
// time it's needed. Blank/missing on any existing row reads as 'monthly'
// (the default, unchanged behavior) — nothing needs backfilling.
function ensureCategoryPeriodTypeColumn_() {
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  if (headers.indexOf('period_type') !== -1) return;
  sheet.getRange(1, headers.length + 1).setValue('period_type');
}

// One-off, same spirit as the other admin_* routes: sets a category's
// period_type by hand via a scripted call, for cleanup/migration — the
// normal path is the owner typing 'yearly' directly into the Categories
// sheet when they create a category that belongs there (see CLAUDE.md's
// Categories section), not this route.
function adminSetCategoryPeriodType(categoryId, periodType) {
  ensureCategoryPeriodTypeColumn_();
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, categoryId);
  if (rowIndex === -1) throw new Error('Category not found');
  sheet.getRange(rowIndex, headers.indexOf('period_type') + 1).setValue(periodType || '');
  return { done: true };
}

// ---- Seasonality (2026-10-19) ----------------------------------------------
//
// The rules live in ProjectionMethods.gs (seasonIndexFromSeries_,
// predictCategoryBase_): a category's time-of-year index per calendar month,
// learned from complete past years. These constants are its clamp; the
// helpers below are the small surface the tests and older callers use.
var SEASON_MIN_INDEX = 0.3;
var SEASON_MAX_INDEX = 3;

function flatSeasonProfile_() {
  return { index: flatIndex_(), yearsUsed: 0, years: [] };
}

// Every requested expense/investment category's time-of-year profile under the
// "balanced" preset (3 past years); flat when there is nothing to learn from.
function computeSeasonalProfiles_(categoryIds) {
  var series = buildMonthlySeries_(categoryIds);
  var thisYear = new Date().getFullYear();
  var years = parseProjectionMethod_('balanced').seasonYears;
  var profiles = {};
  getAllRows('Categories').forEach(function (c) {
    if (c.type !== 'expense' && c.type !== 'investment') return;
    if (categoryIds && categoryIds.indexOf(c.id) === -1) return;
    var s = seasonIndexFromSeries_(series[c.id], thisYear, years);
    profiles[c.id] = { index: s.index, yearsUsed: s.years.length, years: s.years };
  });
  return profiles;
}

// How much of the period is still to come, in MONTHS (see remainingMonthShares_),
// and the same weighted by a profile's index.
function seasonalMonthsLeft_(profile, startDate, endDate) {
  var months = 0, weighted = 0;
  remainingMonthShares_(startDate, endDate).forEach(function (sh) {
    months += sh.share;
    weighted += sh.share * profile.index[sh.month - 1];
  });
  return { months: months, weighted: weighted };
}

// `onlyCategoryId` (optional) computes just that one category — the drill-down
// needs one row, so it skips the monthly history and per-category math of every
// other category. The one category's numbers are identical either way.
function computeAllCategoryProjections_(bounds, onlyCategoryId) {
  ensureCategoryPeriodTypeColumn_();
  var periodMonths = bounds.periodType === 'yearly' ? 12 : 1;
  ensureCategoryProjectionMethodColumn_();
  var asOfKey = formatCalendarDate_(new Date()).substring(0, 7);
  var seriesMap = buildMonthlySeries_(onlyCategoryId ? [onlyCategoryId] : null);   // each category's non-recurring spend per month
  var defaultMethodId = getProjectionDefaultMethod_();

  // "Remaining" figures (added 2026-09-16) — Actual/Programmed/Expected as
  // three things that sum to what's left in the period, rather than
  // Programmed+Expected being the period's FULL total and "remaining"
  // being a separate total-minus-actual subtraction elsewhere. today,
  // daysLeft: today itself is the last day already reflected in "actual"
  // (matches the chart's own truncation and its "N days left" caption —
  // renderProjectionChart_ in app.js), so daysLeft counts the days AFTER
  // today through period end, 0 before the period starts. Viewing a
  // period that hasn't started yet (reachable via the drill-down's own
  // period nav) treats the whole thing as remaining.
  var todayStr = formatCalendarDate_(new Date());
  var daysLeft = daysLeftInPeriod_(bounds.startDate, bounds.endDate);

  var categories = getAllRows('Categories').filter(function (c) {
    if (onlyCategoryId && c.id !== onlyCategoryId) return false;
    return c.type === 'income' || c.type === 'expense' || c.type === 'investment';
  });
  var allEntries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  var entriesInPeriod = allEntries.filter(function (e) { return e.date >= bounds.startDate && e.date <= bounds.endDate; });
  var entriesInPeriodByCategory = {};
  entriesInPeriod.forEach(function (e) {
    if (!entriesInPeriodByCategory[e.category_id]) entriesInPeriodByCategory[e.category_id] = [];
    entriesInPeriodByCategory[e.category_id].push(e);
  });
  // Every confirmed entry per category, any date: whether a programmed
  // occurrence is already paid is judged against entries around ITS date, which
  // for a custom item (a car service every ~5 months) can lie outside the
  // period being viewed.
  var entriesAllByCategory = {};
  allEntries.forEach(function (e) {
    if (!entriesAllByCategory[e.category_id]) entriesAllByCategory[e.category_id] = [];
    entriesAllByCategory[e.category_id].push(e);
  });
  var allRecurring = getRecurringExpenseRows_().filter(function (r) { return String(r.active) !== 'false'; });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  // Entries tagged Annual are one-off lumps, not part of the monthly rate
  // (see the YTD pool below). They still count as "actual" in their own month.
  var annualEntryIds = annualEntryIdSet_();

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }
  function ownAmount_(e) { return Number(e.amount) - (splitSumByEntry[e.id] || 0); }

  var overridesByKey = {};
  getProjectionOverrideRows_().forEach(function (o) {
    overridesByKey[o.category_id + '|' + String(o.period_key)] = Number(o.amount);
  });

  var recurringByCategory = {};
  allRecurring.forEach(function (r) {
    if (!recurringByCategory[r.category_id]) recurringByCategory[r.category_id] = [];
    recurringByCategory[r.category_id].push(r);
  });

  var results = categories.map(function (category) {
    // A category the owner has explicitly marked 'yearly' (period_type
    // column, set when the category itself was created — see CLAUDE.md's
    // Categories section) is for spend that's real but only meaningful as
    // a once-a-year total — a big irregular annual cost with no natural
    // recurring schedule of its own (unlike Recurring Expenses' yearly
    // frequency, which is one fixed, predictable amount on one known
    // date). It never contributes to a monthly view at all, not even a
    // YTD-smoothed fraction, and a manual override can't resurrect it
    // there either — it only ever shows up when actually viewing yearly,
    // where the normal YTD-rate calculation below applies unchanged.
    if (String(category.period_type || '').toLowerCase() === 'yearly' && bounds.periodType !== 'yearly') {
      return {
        category_id: category.id,
        category_name: categoryLabel_(category),
        category_icon: category.icon,
        category_color: category.color,
        category_type: category.type,
        recurringAmountPen: 0,
        baseAmountPen: 0,
        calculatedAmountPen: 0,
        hasOverride: false,
        overrideAmountPen: null,
        amountPen: 0,
        actualPen: 0,
        annualInPeriodPen: 0,
        programmedRemainingPen: 0,
        expectedRemainingPen: 0,
        remainingTotalPen: 0,
        totalPen: 0,
        ratePerMonth: 0,
        levelPerMonth: 0,
        seasonalFactor: 1,
        seasonalYears: 0,
        seasonalYearList: [],
        daysLeft: 0
      };
    }

    var categoryRecurring = recurringByCategory[category.id] || [];
    var categoryEntriesInPeriod = entriesInPeriodByCategory[category.id] || [];

    // A yearly-frequency recurring item, viewed monthly, would otherwise
    // dump its whole annual amount into whichever single month it happens
    // to land in — a misleading spike rather than a genuine monthly
    // figure. Left out of the recurring portion for a monthly view of an
    // expense/investment category; its matching entries are ALSO excluded
    // from the YTD pool below regardless of period (see categoryRecurring
    // used there instead of recurringForPeriod), so a category whose only
    // spend is that one yearly payment shows nothing at all in a monthly
    // view rather than a fraction of it smoothed across every month —
    // its cost only ever surfaces when actually viewing yearly, where a
    // once-a-year cost showing once a year is exactly correct. A category
    // with genuine OTHER variable spend alongside the yearly item (e.g. a
    // car's yearly insurance plus unpredictable gas) is unaffected: only
    // the insurance-matched entries are excluded, gas still feeds the
    // monthly rate normally. Income is never filtered this way — it has
    // no YTD fallback to catch the amount instead, so excluding it would
    // just make a real, known, once-a-year payment disappear in its own
    // month.
    var recurringForPeriod = (category.type === 'income' || bounds.periodType === 'yearly')
      ? categoryRecurring
      : categoryRecurring.filter(function (r) { return r.frequency !== 'yearly'; });

    // Recurring portion for the exact period being shown — each
    // occurrence converted at its own actual date's rate, since a yearly
    // period can span months with different rates on file.
    var recurringAmountPen = 0;
    recurringForPeriod.forEach(function (r) {
      recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate).forEach(function (occDate) {
        var pen = toPen_(recurringOwnAmount_(r, recurringSplitSums), r.currency || homeCurrency_(), occDate);
        if (pen != null) recurringAmountPen += pen;
      });
    });

    var baseAmountPen = 0;
    var ratePerMonth = 0;
    var levelPerMonth = 0;
    var methodId = '';
    var prediction = null;
    var forecast = null;

    if (category.type === 'income') {
      entriesInPeriod.forEach(function (e) {
        if (e.category_id !== category.id) return;
        var matchesRecurring = recurringForPeriod.some(function (r) {
          var occ = recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate);
          return entryMatchesRecurringOccurrence_(e, r, occ, splitSumByEntry, recurringSplitSums);
        });
        if (matchesRecurring) return;
        var pen = toPen_(ownAmount_(e), e.currency, e.date);
        if (pen != null) baseAmountPen += pen;
      });
    } else {
      // The category's own predictor (or the default) over its monthly series
      // — see ProjectionMethods.gs. Entries explained by a programmed item
      // (EVERY active one, even a yearly one left out of a monthly view's
      // Programmed line, or its lump payment would be smoothed into every
      // month's Expected) and entries tagged Annual are already out of the series.
      methodId = categoryMethodId_(category, defaultMethodId);
      prediction = predictCategoryBase_(seriesMap[category.id], parseProjectionMethod_(methodId), asOfKey);
      forecast = forecastForPeriod_(prediction, bounds.startDate, bounds.endDate);
      ratePerMonth = prediction.ratePerMonth;   // the plain average over the window (what the trace shows)
      levelPerMonth = prediction.level;         // the same with the time of year taken out
      baseAmountPen = forecast.base;
    }

    var calculatedAmountPen = recurringAmountPen + baseAmountPen;
    var overrideKey = category.id + '|' + bounds.periodKey;
    var hasOverride = overridesByKey[overrideKey] !== undefined;
    var amountPen = hasOverride ? overridesByKey[overrideKey] : calculatedAmountPen;

    // "Actual" — confirmed spend/income already logged this period,
    // through today only (a period that hasn't fully elapsed can't have
    // "all" its actual figure yet — matches the drill-down chart's own
    // today-truncated solid line).
    // A MONTH view leaves Annual-tagged expenses out of Actual (the owner's rule,
    // like a monthly budget): they are one-off lumps that would make the month look
    // far heavier than its running costs. They are reported aside
    // (`annualInPeriodPen`) and still show in Overview, the entry lists and a
    // Year view, where they count.
    var leaveAnnualOut = bounds.periodType === 'monthly' && category.type !== 'income';
    var actualPen = 0;
    var annualInPeriodPen = 0;
    categoryEntriesInPeriod.forEach(function (e) {
      if (e.date > todayStr) return;
      var pen = toPen_(ownAmount_(e), e.currency, e.date);
      if (pen == null) return;
      if (leaveAnnualOut && annualEntryIds[e.id]) { annualInPeriodPen += pen; return; }
      actualPen += pen;
    });

    // "Programmed remaining" — this period's recurring occurrences that
    // don't yet have a matching confirmed entry, checked per occurrence
    // (not per item) so a monthly item viewed across a full year with
    // some months already paid only counts the ones still outstanding.
    // Applies to every type, including income (recurring salary already
    // received this month no longer counts as "remaining" either).
    var programmedRemainingPen = 0;
    recurringForPeriod.forEach(function (r) {
      recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate).forEach(function (occDate) {
        var handled = (entriesAllByCategory[category.id] || []).some(function (e) {
          return entryMatchesRecurringOccurrence_(e, r, [occDate], splitSumByEntry, recurringSplitSums);
        });
        if (handled) return;
        var pen = toPen_(recurringOwnAmount_(r, recurringSplitSums), r.currency || homeCurrency_(), occDate);
        if (pen != null) programmedRemainingPen += pen;
      });
    });

    // "Expected remaining" — the YTD monthly rate pro-rated down to just
    // the days actually left in the period (daysLeft/30 "months"), not
    // the period's full month-equivalent count. Expense/investment only —
    // income has no YTD-rate concept to pro-rate (see the per-category
    // rule, above); its "Expected" line has never existed.
    // What is still to come = the predictor's months for the remaining part of
    // the period (income never has one).
    var expectedRemainingPen = forecast ? forecast.expected : 0;
    var monthsLeftValue = forecast ? forecast.monthsLeft : 0;
    var seasonalFactor = forecast ? forecast.factor : 1;

    var remainingTotalPen = hasOverride
      ? Math.max(0, overridesByKey[overrideKey] - actualPen)
      : programmedRemainingPen + expectedRemainingPen;

    // The canonical total, everywhere (added 2026-09-16, replacing
    // `amountPen` as what the row headline, the list's own sort order,
    // and the top summary all use) — actual so far plus what's genuinely
    // still left, so it's consistent by construction with the three
    // breakdown lines a category's own row shows (actual + programmed +
    // expected always equals this exactly, with an override folding into
    // it the same way it folds into remainingTotalPen above). `amountPen`
    // (the old flat full-period figure) is kept only for
    // openProjectionOverrideModal_'s own pre-fill — an override still
    // targets "what I think the FULL period will total," a genuinely
    // different question than "what's happened plus what's left."
    var totalPen = actualPen + remainingTotalPen;

    return {
      category_id: category.id,
      category_name: categoryLabel_(category),
      category_icon: category.icon,
      category_color: category.color,
      category_type: category.type,
      recurringAmountPen: recurringAmountPen,
      baseAmountPen: baseAmountPen,
      calculatedAmountPen: calculatedAmountPen,
      hasOverride: hasOverride,
      overrideAmountPen: hasOverride ? overridesByKey[overrideKey] : null,
      amountPen: amountPen,
      actualPen: actualPen,
      annualInPeriodPen: annualInPeriodPen,
      programmedRemainingPen: programmedRemainingPen,
      expectedRemainingPen: expectedRemainingPen,
      remainingTotalPen: remainingTotalPen,
      totalPen: totalPen,
      ratePerMonth: ratePerMonth,
      // Seasonality (see the block above): the year-to-date spend with the time
      // of year taken out, the index of the days still to come, and how many
      // past years it was learned from (0 = flat, nothing changes).
      levelPerMonth: levelPerMonth,
      seasonalFactor: seasonalFactor,
      monthsLeft: monthsLeftValue,
      seasonalYears: prediction ? prediction.seasonalYears : 0,
      seasonalYearList: prediction ? prediction.seasonalYearList : [],
      // The predictor in use (a preset name or custom:<window>:<years>), whether it
      // is the category's own choice, what was actually applied when it had to
      // fall back, and the year copied in "same month last year".
      method: methodId,
      methodIsOwn: !!(category.projection_method && String(category.projection_method).trim() && isValidProjectionMethod_(category.projection_method)),
      methodUsed: prediction ? prediction.methodUsed : '',
      methodFallback: prediction ? prediction.fallback : '',
      lastYearYear: prediction && prediction.lastYear ? prediction.lastYear.year : null,
      daysLeft: daysLeft
    };
  }).filter(function (c) {
    // totalPen already incorporates both actual spend and what's still
    // projected, so a single check covers what used to need three
    // (amountPen > 0, hasOverride, or actualPen > 0 on its own).
    return c.totalPen > 0.005 || c.hasOverride;
  });

  results.sort(function (a, b) { return b.totalPen - a.totalPen; });
  return results;
}

// The category-by-category list (Projections tab, below the summary) —
// mirrors listBudgets' own {displayPeriodType, anchorDate} payload shape
// so it can share the exact same period selector.
function listCategoryProjections(payload) {
  var bounds = projectionPeriodBounds_((payload && payload.displayPeriodType) || 'month', payload && payload.anchorDate);
  return { bounds: bounds, categories: computeAllCategoryProjections_(bounds), defaultMethod: getProjectionDefaultMethod_() };
}

// One category's full detail for its drill-down: the chart's daily actual
// series (cumulative, built client-side the same way the Budget chart's
// is) plus its own projection breakdown.
function getCategoryProjectionDetail(payload) {
  var bounds = projectionPeriodBounds_(payload.displayPeriodType || 'month', payload.anchorDate);
  var match = computeAllCategoryProjections_(bounds, payload.categoryId)[0];

  var categoryById = rowsById_(getAllRows('Categories'));
  var category = categoryById[payload.categoryId];
  if (!match) {
    // Not in the filtered list (e.g. genuinely nothing to show yet) —
    // still return a zeroed shape so the drill-down has something valid
    // to render rather than erroring.
    match = {
      category_id: payload.categoryId,
      category_name: category ? categoryLabel_(category) : tr_('label.unknownCategory'),
      category_icon: category ? category.icon : '',
      category_color: category ? category.color : '',
      category_type: category ? category.type : 'expense',
      recurringAmountPen: 0, baseAmountPen: 0, calculatedAmountPen: 0,
      hasOverride: false, overrideAmountPen: null, amountPen: 0,
      actualPen: 0, annualInPeriodPen: 0, programmedRemainingPen: 0, expectedRemainingPen: 0,
      remainingTotalPen: 0, totalPen: 0, ratePerMonth: 0, levelPerMonth: 0, seasonalFactor: 1, seasonalYears: 0, seasonalYearList: [], daysLeft: 0
    };
  }

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }

  var dailyActualPen = {};
  var annualLeftOut = bounds.periodType === 'monthly' && category && category.type !== 'income';
  var annualIdsInDetail = annualLeftOut ? annualEntryIdSet_() : {};
  getAllRows('Entries')
    .filter(function (e) {
      return e.status === 'confirmed' && e.category_id === payload.categoryId &&
        e.date >= bounds.startDate && e.date <= bounds.endDate;
    })
    .forEach(function (e) {
      // Same rule as Actual: a Month view leaves Annual-tagged expenses out.
      if (annualLeftOut && annualIdsInDetail[e.id]) return;
      var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
      var pen = toPen_(ownAmount, e.currency, e.date);
      if (pen == null) return;
      dailyActualPen[e.date] = (dailyActualPen[e.date] || 0) + pen;
    });

  // "Expected" (the YTD-rate portion) only exists for expense/investment
  // — income's non-recurring portion is just already-confirmed entries in
  // the period itself, already fully visible in the transaction list
  // above, so there's no estimate to trace back for it.
  var ytdBreakdown = (category && (category.type === 'expense' || category.type === 'investment'))
    ? computeCategoryYtdBreakdown_(payload.categoryId)
    : null;

  var programmedBreakdown = match.programmedRemainingPen > 0
    ? computeCategoryProgrammedBreakdown_(payload.categoryId, bounds, category)
    : null;

  return {
    bounds: bounds,
    projection: match,
    dailyActualPen: dailyActualPen,
    ytdBreakdown: ytdBreakdown,
    programmedBreakdown: programmedBreakdown
  };
}

// Traces back the "programmed remaining" figure for one category: which
// actual recurring items contributed, and how much each one added within
// the period being viewed — same recurringForPeriod filter
// computeAllCategoryProjections_ itself applies (a yearly-frequency item
// excluded from a monthly view has nothing to list here either, since it
// isn't part of the programmed total being explained). Only occurrences
// WITHOUT a matching confirmed entry count (fixed 2026-09-16, same as
// programmedRemainingPen above) — an item already paid this period no
// longer traces here even before its own "due date" arrives. `occurrences`
// is usually 1 (one still-outstanding billing date within the period) but
// can be more — a monthly item viewed across a full year, with several
// of its 12 occurrences still unpaid, shows the count of THOSE, each
// contributing its own converted amount to the item's total.
function computeCategoryProgrammedBreakdown_(categoryId, bounds, category) {
  var categoryRecurring = getRecurringExpenseRows_().filter(function (r) {
    return String(r.active) !== 'false' && r.category_id === categoryId;
  });
  var recurringForPeriod = (category && category.type === 'income') || bounds.periodType === 'yearly'
    ? categoryRecurring
    : categoryRecurring.filter(function (r) { return r.frequency !== 'yearly'; });

  // Entries of ANY date in this category: "is this occurrence already paid"
  // looks around the occurrence's own date (see computeAllCategoryProjections_).
  var entriesInPeriod = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === categoryId;
  });

  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  // dailyPen: date -> summed PEN across every still-outstanding occurrence
  // that lands on it (more than one recurring item can share a day) — feeds
  // the drill-down chart's "bump" at each real calendar date, separate
  // from `items` below (grouped by recurring ITEM instead of by date, for
  // the trace-back list). Both are built from the same occDates/toPen_
  // pass so they can never disagree with each other or with the summed
  // totalPen below.
  var dailyPen = {};
  var items = recurringForPeriod.map(function (r) {
    var occDates = recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate)
      .filter(function (occDate) {
        return !entriesInPeriod.some(function (e) { return entryMatchesRecurringOccurrence_(e, r, [occDate], splitSumByEntry, recurringSplitSums); });
      });
    var ownAmount = recurringOwnAmount_(r, recurringSplitSums);
    var amountPen = 0;
    occDates.forEach(function (occDate) {
      var pen = toPen_(ownAmount, r.currency || homeCurrency_(), occDate);
      if (pen != null) {
        amountPen += pen;
        dailyPen[occDate] = (dailyPen[occDate] || 0) + pen;
      }
    });
    return {
      id: r.id,
      description: r.description || '',
      amount: ownAmount,
      currency: r.currency || homeCurrency_(),
      occurrences: occDates.length,
      amountPen: amountPen
    };
  }).filter(function (item) { return item.occurrences > 0; });

  items.sort(function (a, b) { return b.amountPen - a.amountPen; });

  var occurrences = Object.keys(dailyPen).sort().map(function (date) {
    return { date: date, amountPen: dailyPen[date] };
  });

  return {
    items: items,
    occurrences: occurrences,
    totalPen: items.reduce(function (sum, item) { return sum + item.amountPen; }, 0)
  };
}

// Traces back the "expected" figure for one category: its non-recurring
// spend for each complete month so far this year (the same exclusion as
// computeAllCategoryProjections_'s YTD rate — an entry already explained
// by a recurring item doesn't count here either), so a spike in one
// particular month is visible rather than hidden inside a single blended
// average. Every elapsed month gets a row even at 0 — a silent gap is as
// informative as a number when eyeballing whether the rate makes sense.
// The months the category's predictor learned from, for the Expected trace: one
// row per month of its window (even at 0), the plain average and the level, the
// time-of-year shape, and the Annual-tagged spend left out. methodId defaults to
// the category's own choice (or the default). The function keeps its old name.
function computeCategoryYtdBreakdown_(categoryId, methodId) {
  ensureCategoryProjectionMethodColumn_();
  var series = buildMonthlySeries_([categoryId])[categoryId];
  var asOfKey = formatCalendarDate_(new Date()).substring(0, 7);
  var id = methodId || categoryMethodId_(rowsById_(getAllRows('Categories'))[categoryId], getProjectionDefaultMethod_());
  var prediction = predictCategoryBase_(series, parseProjectionMethod_(id), asOfKey);
  var totalPen = 0, annualExcludedPen = 0, annualExcludedCount = 0;
  var months = prediction.windowMonths.map(function (k) {
    var amount = series ? (series.totals[k] || 0) : 0;
    totalPen += amount;
    var a = series && series.annual[k];
    if (a) { annualExcludedPen += a.pen; annualExcludedCount += a.count; }
    return { monthKey: k, amountPen: amount };
  });
  return {
    months: months,
    totalPen: totalPen,
    monthsElapsed: months.length,   // months in the window (the old name, kept)
    ratePerMonth: prediction.ratePerMonth,
    levelPerMonth: prediction.level,
    seasonalYears: prediction.seasonalYears,
    seasonalYearList: prediction.seasonalYearList,
    annualExcludedPen: annualExcludedPen,
    annualExcludedCount: annualExcludedCount,
    method: id,
    methodUsed: prediction.methodUsed,
    methodFallback: prediction.fallback
  };
}

function setProjectionOverride(payload) {
  ensureProjectionOverridesSheet_();
  var sheet = getSheet('Projection Overrides');
  var headers = getHeaders(sheet);
  var existingRows = getAllRows('Projection Overrides');
  var existing = existingRows.filter(function (o) {
    return o.category_id === payload.categoryId && String(o.period_key) === payload.periodKey;
  })[0];

  if (existing) {
    var rowIndex = findRowIndexById(sheet, headers, existing.id);
    sheet.getRange(rowIndex, headers.indexOf('amount') + 1).setValue(payload.amount);
    return { id: existing.id, category_id: payload.categoryId, period_key: payload.periodKey, amount: payload.amount };
  }

  // appendRow (via appendRowObject elsewhere) doesn't reliably respect a
  // number format set on the column back when the sheet was created —
  // "2026-09" still landed as an actual Date value even with '@' format
  // pre-applied. Setting the format on this exact cell immediately before
  // writing its value, in the same call, is what actually sticks.
  var newRowIndex = sheet.getLastRow() + 1;
  var id = Utilities.getUuid();
  sheet.getRange(newRowIndex, headers.indexOf('id') + 1).setValue(id);
  sheet.getRange(newRowIndex, headers.indexOf('category_id') + 1).setValue(payload.categoryId);
  var periodCell = sheet.getRange(newRowIndex, headers.indexOf('period_key') + 1);
  periodCell.setNumberFormat('@');
  periodCell.setValue(payload.periodKey);
  sheet.getRange(newRowIndex, headers.indexOf('amount') + 1).setValue(payload.amount);
  return { id: id, category_id: payload.categoryId, period_key: payload.periodKey, amount: payload.amount };
}

// "Reset to calculated" — deleting the override row IS the reset; there's
// no separate flag, a missing row always means "use the calculation."
function deleteProjectionOverride(payload) {
  ensureProjectionOverridesSheet_();
  var sheet = getSheet('Projection Overrides');
  var headers = getHeaders(sheet);
  var rows = getAllRows('Projection Overrides');
  var existing = rows.filter(function (o) {
    return o.category_id === payload.categoryId && String(o.period_key) === payload.periodKey;
  })[0];
  if (existing) {
    var rowIndex = findRowIndexById(sheet, headers, existing.id);
    if (rowIndex !== -1) deleteSheetRows_(sheet, rowIndex, 1);
  }
  return { done: true };
}

// Top summary — income/expenses/investments/net for the SAME period the
// category list is showing, rolled up by type from the exact same
// per-category figures (never computed separately, so the two can't
// disagree). Defaults to the current month when no period is given, same
// as always.
function getProjections(payload) {
  var displayPeriodType = (payload && payload.displayPeriodType) || 'month';
  var bounds = projectionPeriodBounds_(displayPeriodType, payload && payload.anchorDate);
  var all = computeAllCategoryProjections_(bounds);

  var periodLabel = bounds.periodType === 'yearly'
    ? bounds.periodKey
    : Utilities.formatDate(new Date(bounds.startDate + 'T00:00:00'), Session.getScriptTimeZone(), 'MMMM yyyy');

  function sumByType_(type, field) {
    return all.reduce(function (sum, c) { return c.category_type === type ? sum + c[field] : sum; }, 0);
  }

  // Rolled up from `totalPen` (added 2026-09-16, replacing `amountPen`) —
  // actual so far plus what's genuinely still left for every category of
  // that type, the same reality-aware figure the "By category" list and
  // each category's own drill-down now use, rather than a flat
  // full-period estimate that ignores how the period's actually going.
  var income = sumByType_('income', 'totalPen');
  var expenses = sumByType_('expense', 'totalPen');
  var investments = sumByType_('investment', 'totalPen');

  return {
    monthLabel: periodLabel,
    defaultMethod: getProjectionDefaultMethod_(),   // the predictor categories use unless they chose their own
    periodType: bounds.periodType,
    income: income,
    incomeActual: sumByType_('income', 'actualPen'),
    incomeProgrammed: sumByType_('income', 'programmedRemainingPen'),
    expenses: expenses,
    expensesActual: sumByType_('expense', 'actualPen'),
    expensesProgrammed: sumByType_('expense', 'programmedRemainingPen'),
    expensesExpected: sumByType_('expense', 'expectedRemainingPen'),
    investments: investments,
    investmentsActual: sumByType_('investment', 'actualPen'),
    investmentsProgrammed: sumByType_('investment', 'programmedRemainingPen'),
    investmentsExpected: sumByType_('investment', 'expectedRemainingPen'),
    net: income - expenses - investments
  };
}
