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

// Year-to-date, always relative to today (never the period being
// browsed) — projections are inherently "as of right now," estimating
// forward, unlike a Budget's own period-relative rate lookups. Only
// COMPLETE months count (never the current, still-in-progress one), same
// reasoning as the old 3-month average this replaces.
function ytdRangeForProjection_() {
  var now = new Date();
  var y = now.getFullYear();
  var m = now.getMonth() + 1; // 1-12, current month
  var monthsElapsed = m - 1; // complete months before the current one
  if (monthsElapsed <= 0) return { ytdStart: null, ytdEnd: null, monthsElapsed: 0 };
  var lastCompleteMonth = m - 1;
  var lastDay = new Date(y, lastCompleteMonth, 0).getDate();
  return {
    ytdStart: y + '-01-01',
    ytdEnd: y + '-' + pad2_(lastCompleteMonth) + '-' + pad2_(lastDay),
    monthsElapsed: monthsElapsed
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

function computeAllCategoryProjections_(bounds) {
  ensureCategoryPeriodTypeColumn_();
  var periodMonths = bounds.periodType === 'yearly' ? 12 : 1;
  var ytd = ytdRangeForProjection_();

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
    return c.type === 'income' || c.type === 'expense' || c.type === 'investment';
  });
  var allEntries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  var entriesInPeriod = allEntries.filter(function (e) { return e.date >= bounds.startDate && e.date <= bounds.endDate; });
  var entriesInPeriodByCategory = {};
  entriesInPeriod.forEach(function (e) {
    if (!entriesInPeriodByCategory[e.category_id]) entriesInPeriodByCategory[e.category_id] = [];
    entriesInPeriodByCategory[e.category_id].push(e);
  });
  var entriesYtd = ytd.ytdStart
    ? allEntries.filter(function (e) { return e.date >= ytd.ytdStart && e.date <= ytd.ytdEnd; })
    : [];
  var allRecurring = getRecurringExpenseRows_().filter(function (r) { return String(r.active) !== 'false'; });
  var recurringSplitSums = getRecurringExpenseSplitSums_();

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = latestRateFromList_(ratesByCurrency[currency], String(dateStr).substring(0, 7));
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
        category_name: category.name,
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
        programmedRemainingPen: 0,
        expectedRemainingPen: 0,
        remainingTotalPen: 0,
        totalPen: 0,
        ratePerMonth: 0,
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
        var pen = toPen_(recurringOwnAmount_(r, recurringSplitSums), r.currency || 'PEN', occDate);
        if (pen != null) recurringAmountPen += pen;
      });
    });

    var baseAmountPen = 0;
    var ratePerMonth = 0;

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
    } else if (ytd.ytdStart) {
      // Matched against EVERY active recurring item (categoryRecurring),
      // not just recurringForPeriod — a yearly item excluded from the
      // period's own "programmed" line above must still have its matching
      // entries pulled out of the YTD pool below, or its one-a-year lump
      // payment gets smoothed into every month's "Expected" as if it were
      // genuine unexplained variable spend. A category whose only YTD
      // spend is that single yearly payment then correctly nets to 0 in a
      // monthly view instead of showing a misleading fraction of it.
      var matchedEntryIds = {};
      categoryRecurring.forEach(function (r) {
        var occYtd = recurringExpenseOccurrencesInRange_(r, ytd.ytdStart, ytd.ytdEnd);
        entriesYtd.forEach(function (e) {
          if (e.category_id !== category.id || matchedEntryIds[e.id]) return;
          if (entryMatchesRecurringOccurrence_(e, r, occYtd, splitSumByEntry, recurringSplitSums)) matchedEntryIds[e.id] = true;
        });
      });
      var ytdNonRecurringPen = 0;
      entriesYtd.forEach(function (e) {
        if (e.category_id !== category.id || e.type !== category.type || matchedEntryIds[e.id]) return;
        var pen = toPen_(ownAmount_(e), e.currency, e.date);
        if (pen != null) ytdNonRecurringPen += pen;
      });
      ratePerMonth = ytd.monthsElapsed > 0 ? ytdNonRecurringPen / ytd.monthsElapsed : 0;
      baseAmountPen = ratePerMonth * periodMonths;
    }

    var calculatedAmountPen = recurringAmountPen + baseAmountPen;
    var overrideKey = category.id + '|' + bounds.periodKey;
    var hasOverride = overridesByKey[overrideKey] !== undefined;
    var amountPen = hasOverride ? overridesByKey[overrideKey] : calculatedAmountPen;

    // "Actual" — confirmed spend/income already logged this period,
    // through today only (a period that hasn't fully elapsed can't have
    // "all" its actual figure yet — matches the drill-down chart's own
    // today-truncated solid line).
    var actualPen = 0;
    categoryEntriesInPeriod.forEach(function (e) {
      if (e.date > todayStr) return;
      var pen = toPen_(ownAmount_(e), e.currency, e.date);
      if (pen != null) actualPen += pen;
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
        var handled = categoryEntriesInPeriod.some(function (e) {
          return entryMatchesRecurringOccurrence_(e, r, [occDate], splitSumByEntry, recurringSplitSums);
        });
        if (handled) return;
        var pen = toPen_(recurringOwnAmount_(r, recurringSplitSums), r.currency || 'PEN', occDate);
        if (pen != null) programmedRemainingPen += pen;
      });
    });

    // "Expected remaining" — the YTD monthly rate pro-rated down to just
    // the days actually left in the period (daysLeft/30 "months"), not
    // the period's full month-equivalent count. Expense/investment only —
    // income has no YTD-rate concept to pro-rate (see the per-category
    // rule, above); its "Expected" line has never existed.
    var expectedRemainingPen = ratePerMonth * (daysLeft / 30);

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
      category_name: category.name,
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
      programmedRemainingPen: programmedRemainingPen,
      expectedRemainingPen: expectedRemainingPen,
      remainingTotalPen: remainingTotalPen,
      totalPen: totalPen,
      ratePerMonth: ratePerMonth,
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
  return { bounds: bounds, categories: computeAllCategoryProjections_(bounds) };
}

// One category's full detail for its drill-down: the chart's daily actual
// series (cumulative, built client-side the same way the Budget chart's
// is) plus its own projection breakdown.
function getCategoryProjectionDetail(payload) {
  var bounds = projectionPeriodBounds_(payload.displayPeriodType || 'month', payload.anchorDate);
  var all = computeAllCategoryProjections_(bounds);
  var match = all.filter(function (c) { return c.category_id === payload.categoryId; })[0];

  var categoryById = rowsById_(getAllRows('Categories'));
  var category = categoryById[payload.categoryId];
  if (!match) {
    // Not in the filtered list (e.g. genuinely nothing to show yet) —
    // still return a zeroed shape so the drill-down has something valid
    // to render rather than erroring.
    match = {
      category_id: payload.categoryId,
      category_name: category ? category.name : '(unknown category)',
      category_icon: category ? category.icon : '',
      category_color: category ? category.color : '',
      category_type: category ? category.type : 'expense',
      recurringAmountPen: 0, baseAmountPen: 0, calculatedAmountPen: 0,
      hasOverride: false, overrideAmountPen: null, amountPen: 0,
      actualPen: 0, programmedRemainingPen: 0, expectedRemainingPen: 0,
      remainingTotalPen: 0, totalPen: 0, ratePerMonth: 0, daysLeft: 0
    };
  }

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = latestRateFromList_(ratesByCurrency[currency], String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }

  var dailyActualPen = {};
  getAllRows('Entries')
    .filter(function (e) {
      return e.status === 'confirmed' && e.category_id === payload.categoryId &&
        e.date >= bounds.startDate && e.date <= bounds.endDate;
    })
    .forEach(function (e) {
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

  var entriesInPeriod = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === categoryId &&
      e.date >= bounds.startDate && e.date <= bounds.endDate;
  });

  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = latestRateFromList_(ratesByCurrency[currency], String(dateStr).substring(0, 7));
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
      var pen = toPen_(ownAmount, r.currency || 'PEN', occDate);
      if (pen != null) {
        amountPen += pen;
        dailyPen[occDate] = (dailyPen[occDate] || 0) + pen;
      }
    });
    return {
      id: r.id,
      description: r.description || '',
      amount: ownAmount,
      currency: r.currency || 'PEN',
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
function computeCategoryYtdBreakdown_(categoryId) {
  var ytd = ytdRangeForProjection_();
  if (!ytd.ytdStart) return { months: [], totalPen: 0, monthsElapsed: 0, ratePerMonth: 0 };

  var categoryRecurring = getRecurringExpenseRows_().filter(function (r) {
    return String(r.active) !== 'false' && r.category_id === categoryId;
  });
  var entriesYtd = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === categoryId &&
      e.date >= ytd.ytdStart && e.date <= ytd.ytdEnd;
  });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = latestRateFromList_(ratesByCurrency[currency], String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }

  var matchedEntryIds = {};
  categoryRecurring.forEach(function (r) {
    var occYtd = recurringExpenseOccurrencesInRange_(r, ytd.ytdStart, ytd.ytdEnd);
    entriesYtd.forEach(function (e) {
      if (matchedEntryIds[e.id]) return;
      if (entryMatchesRecurringOccurrence_(e, r, occYtd, splitSumByEntry, recurringSplitSums)) matchedEntryIds[e.id] = true;
    });
  });

  var monthlyTotals = {};
  var totalPen = 0;
  entriesYtd.forEach(function (e) {
    if (matchedEntryIds[e.id]) return;
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    var pen = toPen_(ownAmount, e.currency, e.date);
    if (pen == null) return;
    var monthKey = String(e.date).substring(0, 7);
    monthlyTotals[monthKey] = (monthlyTotals[monthKey] || 0) + pen;
    totalPen += pen;
  });

  var year = ytd.ytdStart.substring(0, 4);
  var months = [];
  for (var m = 1; m <= ytd.monthsElapsed; m++) {
    var monthKey = year + '-' + pad2_(m);
    months.push({ monthKey: monthKey, amountPen: monthlyTotals[monthKey] || 0 });
  }

  return {
    months: months,
    totalPen: totalPen,
    monthsElapsed: ytd.monthsElapsed,
    ratePerMonth: totalPen / ytd.monthsElapsed
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
    if (rowIndex !== -1) sheet.deleteRow(rowIndex);
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
