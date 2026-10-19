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

// The window "Expected" learns its LEVEL from (2026-10-19; it used to be the
// year to date): the 12 COMPLETE calendar months before the current one, always
// relative to today (never the period being browsed) — projections are
// inherently "as of right now". Twelve full months means every calendar month
// appears once, so a category's seasonal indexes (which sum to 12) cancel out
// and the level is simply the 12-month average; and it is never thin in
// January or February the way "the year so far" was. The function keeps its old
// name and field names (ytdStart/ytdEnd/monthsElapsed) so its many callers
// didn't have to change: read them as "the window". A category that is younger
// than 12 months uses only the complete months since its first entry
// (categoryWindowMonths_).
function ytdRangeForProjection_() {
  var now = new Date();
  var monthKeys = [];
  for (var i = 12; i >= 1; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(d.getFullYear() + '-' + pad2_(d.getMonth() + 1));
  }
  var last = monthKeys[11];
  var lastDay = new Date(Number(last.substring(0, 4)), Number(last.substring(5, 7)), 0).getDate();
  return { ytdStart: monthKeys[0] + '-01', ytdEnd: last + '-' + pad2_(lastDay), monthKeys: monthKeys, monthsElapsed: 12 };
}

// The window months a category can use: those strictly AFTER the month of its
// first confirmed entry (that month is usually partial). Nothing before it
// existed, so zero spend there says nothing.
function categoryWindowMonths_(ytd, firstEntryMonthKey) {
  if (!firstEntryMonthKey) return [];
  return ytd.monthKeys.filter(function (k) { return k > firstEntryMonthKey; });
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
// The year-to-date rate treats every month alike. A category can have a real
// yearly shape (December gifts, January school costs), so "Expected" is now
//   level  x  the time-of-year index of the days still to come
// where
//   index[m]  = how much this category usually spends in calendar month m,
//               relative to its own average month (1.0 = average), learned
//               from up to the last 3 COMPLETE past years;
//   level     = this year's spend so far ÷ the sum of the indexes of the months
//               that produced it (the average month with the seasonality taken
//               out); in January, with no month elapsed yet, last year's
//               monthly average.
// Everything explainable, nothing fitted: per year, a month's ratio = that
// month's spend ÷ the year's monthly average; across years the MEDIAN ratio
// (3 years; the mean of 2; the one value of 1 year), pulled toward 1 the less
// history there is (weight n/(n+1)), clamped to 0.3-3, then rescaled so the 12
// indexes average exactly 1 — the yearly total never changes, only its shape.
// The same pool as the rate: own share, PEN at each entry's month rate, entries
// explained by a programmed item and entries tagged Annual left out. A year only
// counts if the category already existed on its January 1st (a habit that began
// in September says nothing about March). With no usable year every index is 1,
// which makes "Expected" exactly what it was before this existed.
var SEASON_MAX_YEARS = 3;
var SEASON_MIN_INDEX = 0.3;
var SEASON_MAX_INDEX = 3;

function flatSeasonProfile_() {
  var index = [];
  for (var i = 0; i < 12; i++) index.push(1);
  return { index: index, yearsUsed: 0, years: [] };
}

function medianOfNumbers_(numbers) {
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// categoryIds: array of ids, or null for every expense/investment category.
// Returns { categoryId: profile } — a profile for every requested category (flat
// when there is nothing to learn from).
function computeSeasonalProfiles_(categoryIds) {
  var thisYear = new Date().getFullYear();
  var firstYear = thisYear - SEASON_MAX_YEARS;
  var rangeStart = firstYear + '-01-01', rangeEnd = (thisYear - 1) + '-12-31';

  var wanted = {};
  getAllRows('Categories').forEach(function (c) {
    if (c.type !== 'expense' && c.type !== 'investment') return;
    if (categoryIds && categoryIds.indexOf(c.id) === -1) return;
    wanted[c.id] = c;
  });
  var profiles = {};
  Object.keys(wanted).forEach(function (id) { profiles[id] = flatSeasonProfile_(); });

  var firstEntryYear = {};
  var pool = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || !wanted[e.category_id]) return;
    var y = Number(String(e.date).substring(0, 4));
    if (!firstEntryYear[e.category_id] || y < firstEntryYear[e.category_id]) firstEntryYear[e.category_id] = y;
    if (e.date >= rangeStart && e.date <= rangeEnd && e.type === wanted[e.category_id].type) {
      (pool[e.category_id] = pool[e.category_id] || []).push(e);
    }
  });
  if (!Object.keys(pool).length) return profiles;

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var recurringByCategory = {};
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false' || !wanted[r.category_id]) return;
    (recurringByCategory[r.category_id] = recurringByCategory[r.category_id] || []).push(r);
  });
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }
  var annualEntryIds = annualEntryIdSet_();

  Object.keys(pool).forEach(function (categoryId) {
    var entries = pool[categoryId];
    var matched = {};
    (recurringByCategory[categoryId] || []).forEach(function (r) {
      var occ = recurringExpenseOccurrencesInRange_(r, rangeStart, rangeEnd);
      if (!occ.length) return;
      entries.forEach(function (e) {
        if (matched[e.id]) return;
        if (entryMatchesRecurringOccurrence_(e, r, occ, splitSumByEntry, recurringSplitSums)) matched[e.id] = true;
      });
    });
    var byYear = {};   // year -> [12 monthly PEN sums]
    entries.forEach(function (e) {
      if (matched[e.id] || annualEntryIds[e.id]) return;
      var pen = toPen_(Number(e.amount) - (splitSumByEntry[e.id] || 0), e.currency, e.date);
      if (pen == null) return;
      var y = Number(String(e.date).substring(0, 4));
      var m = Number(String(e.date).substring(5, 7)) - 1;
      (byYear[y] = byYear[y] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])[m] += pen;
    });

    // Usable years, newest first: the category existed on that January 1st and
    // spent something that year.
    var ratiosByMonth = [[], [], [], [], [], [], [], [], [], [], [], []];
    var years = [];
    for (var y = thisYear - 1; y >= firstYear && years.length < SEASON_MAX_YEARS; y--) {
      var months = byYear[y];
      if (!months || !(firstEntryYear[categoryId] < y)) continue;
      var total = months.reduce(function (a, b) { return a + b; }, 0);
      if (!(total > 0)) continue;
      var mean = total / 12;
      years.push(y);
      months.forEach(function (v, i) { ratiosByMonth[i].push(v / mean); });
    }
    if (!years.length) return;

    var n = years.length;
    var weight = n / (n + 1);
    var index = ratiosByMonth.map(function (ratios) {
      var typical = n >= 3 ? medianOfNumbers_(ratios) : ratios.reduce(function (a, b) { return a + b; }, 0) / ratios.length;
      var s = 1 + weight * (typical - 1);
      return Math.min(SEASON_MAX_INDEX, Math.max(SEASON_MIN_INDEX, s));
    });
    var sum = index.reduce(function (a, b) { return a + b; }, 0);
    index = index.map(function (s) { return s * 12 / sum; });
    profiles[categoryId] = { index: index, yearsUsed: n, years: years };
  });
  return profiles;
}

// Sum of the indexes of every calendar month the period touches (a Month view
// is one month, a Year view all twelve = 12).
function seasonalIndexSum_(profile, startDate, endDate) {
  var sum = 0;
  var y = Number(startDate.substring(0, 4)), m = Number(startDate.substring(5, 7));
  var endKey = endDate.substring(0, 7);
  for (var guard = 0; guard < 600; guard++) {
    var key = y + '-' + pad2_(m);
    if (key > endKey) break;
    sum += profile.index[m - 1];
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return sum;
}

// How much of the period is still to come, in MONTHS — each remaining day counts
// 1 / (the number of days in ITS month), so a month always weighs exactly 1 and
// February is no lighter than July (it was "days left / 30", which gave a 28-day
// month 93%). Returns { months, weighted } where `weighted` multiplies each
// month's share by that month's seasonal index. Month view = days left ÷ days
// in that month; a Year view in October = (Oct's remaining days ÷ 31) + Nov + Dec,
// each weighted by its index. A period that hasn't started counts whole.
function seasonalMonthsLeft_(profile, startDate, endDate) {
  var todayStr = formatCalendarDate_(new Date());
  if (todayStr > endDate) return { months: 0, weighted: 0 };
  var from;
  if (todayStr < startDate) {
    from = startDate;
  } else {
    var t = new Date(todayStr + 'T00:00:00');
    from = formatCalendarDate_(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
  }
  if (from > endDate) return { months: 0, weighted: 0 };
  var months = 0, weighted = 0;
  var y = Number(from.substring(0, 4)), m = Number(from.substring(5, 7));
  for (var guard = 0; guard < 600; guard++) {
    var monthStart = y + '-' + pad2_(m) + '-01';
    var lastDay = new Date(y, m, 0).getDate();
    var monthEnd = y + '-' + pad2_(m) + '-' + pad2_(lastDay);
    if (monthStart > endDate) break;
    var lo = from > monthStart ? from : monthStart;
    var hi = endDate < monthEnd ? endDate : monthEnd;
    var count = daysBetweenDates_(hi, lo) + 1;
    if (count > 0) {
      var share = count / lastDay;
      months += share;
      weighted += share * profile.index[m - 1];
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return { months: months, weighted: weighted };
}

function computeAllCategoryProjections_(bounds) {
  ensureCategoryPeriodTypeColumn_();
  var periodMonths = bounds.periodType === 'yearly' ? 12 : 1;
  var ytd = ytdRangeForProjection_();
  var seasonal = computeSeasonalProfiles_(null);

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
  // Every confirmed entry per category, any date: whether a programmed
  // occurrence is already paid is judged against entries around ITS date, which
  // for a custom item (a car service every ~5 months) can lie outside the
  // period being viewed.
  var entriesAllByCategory = {};
  allEntries.forEach(function (e) {
    if (!entriesAllByCategory[e.category_id]) entriesAllByCategory[e.category_id] = [];
    entriesAllByCategory[e.category_id].push(e);
  });
  var entriesYtd = allEntries.filter(function (e) { return e.date >= ytd.ytdStart && e.date <= ytd.ytdEnd; });
  var firstMonthByCategory = {};
  allEntries.forEach(function (e) {
    var k = String(e.date).substring(0, 7);
    if (!firstMonthByCategory[e.category_id] || k < firstMonthByCategory[e.category_id]) firstMonthByCategory[e.category_id] = k;
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
    var profile = seasonal[category.id] || flatSeasonProfile_();

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
      var windowMonths = categoryWindowMonths_(ytd, firstMonthByCategory[category.id]);
      var inWindow = {};
      windowMonths.forEach(function (k) { inWindow[k] = true; });
      entriesYtd.forEach(function (e) {
        if (e.category_id !== category.id || e.type !== category.type || matchedEntryIds[e.id]) return;
        if (!inWindow[String(e.date).substring(0, 7)]) return;   // before the category existed
        // Tagged Annual: a lump that happens once in a while (car maintenance,
        // a yearly fee) — left out of the monthly rate so it doesn't inflate
        // every month's "Expected". Nothing is projected in its place: only
        // Programmed (recurring) items are projected.
        if (annualEntryIds[e.id]) return;
        var pen = toPen_(ownAmount_(e), e.currency, e.date);
        if (pen != null) ytdNonRecurringPen += pen;
      });
      // ratePerMonth is the plain average over the window (what the trace shows);
      // the level is the same spend with the time of year taken out — see the
      // Seasonality block above. With 12 full months the indexes sum to 12 and
      // level == ratePerMonth; with fewer (a young category) the months'
      // indexes are summed. A flat profile makes them equal either way.
      ratePerMonth = windowMonths.length > 0 ? ytdNonRecurringPen / windowMonths.length : 0;
      var windowIndexSum = 0;
      windowMonths.forEach(function (k) { windowIndexSum += profile.index[Number(k.substring(5, 7)) - 1]; });
      levelPerMonth = windowIndexSum > 0 ? ytdNonRecurringPen / windowIndexSum : 0;
      baseAmountPen = levelPerMonth * seasonalIndexSum_(profile, bounds.startDate, bounds.endDate);
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
    var monthsLeft = seasonalMonthsLeft_(profile, bounds.startDate, bounds.endDate);
    var seasonalFactor = monthsLeft.months > 0 ? monthsLeft.weighted / monthsLeft.months : 1;
    var expectedRemainingPen = levelPerMonth * monthsLeft.weighted;

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
      monthsLeft: monthsLeft.months,
      seasonalYears: profile.yearsUsed,
      seasonalYearList: profile.years,
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
      category_name: category ? categoryLabel_(category) : tr_('label.unknownCategory'),
      category_icon: category ? category.icon : '',
      category_color: category ? category.color : '',
      category_type: category ? category.type : 'expense',
      recurringAmountPen: 0, baseAmountPen: 0, calculatedAmountPen: 0,
      hasOverride: false, overrideAmountPen: null, amountPen: 0,
      actualPen: 0, programmedRemainingPen: 0, expectedRemainingPen: 0,
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
// profile: the category's seasonal profile (computeSeasonalProfiles_), passed by
// a caller that already has it (Budgets does, for every category at once);
// omitted = computed here for this one category.
function computeCategoryYtdBreakdown_(categoryId, profile) {
  var ytd = ytdRangeForProjection_();
  if (!profile) profile = computeSeasonalProfiles_([categoryId])[categoryId] || flatSeasonProfile_();

  var categoryRecurring = getRecurringExpenseRows_().filter(function (r) {
    return String(r.active) !== 'false' && r.category_id === categoryId;
  });
  var categoryEntries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === categoryId;
  });
  var firstMonth = '';
  categoryEntries.forEach(function (e) {
    var k = String(e.date).substring(0, 7);
    if (!firstMonth || k < firstMonth) firstMonth = k;
  });
  var windowMonths = categoryWindowMonths_(ytd, firstMonth);
  var inWindow = {};
  windowMonths.forEach(function (k) { inWindow[k] = true; });
  var entriesYtd = categoryEntries.filter(function (e) { return inWindow[String(e.date).substring(0, 7)]; });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var ratesByCurrency = buildRatesByCurrency_();
  function toPen_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
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

  var annualEntryIds = annualEntryIdSet_();
  var monthlyTotals = {};
  var totalPen = 0;
  var annualExcludedPen = 0;
  var annualExcludedCount = 0;
  entriesYtd.forEach(function (e) {
    if (matchedEntryIds[e.id]) return;
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    var pen = toPen_(ownAmount, e.currency, e.date);
    if (pen == null) return;
    // Same exclusion computeAllCategoryProjections_ applies to the rate; the
    // amount left out is reported so the trace can say so.
    if (annualEntryIds[e.id]) { annualExcludedPen += pen; annualExcludedCount++; return; }
    var monthKey = String(e.date).substring(0, 7);
    monthlyTotals[monthKey] = (monthlyTotals[monthKey] || 0) + pen;
    totalPen += pen;
  });

  // One row per window month (even at 0): a month with nothing is as telling as
  // a month with something.
  var months = windowMonths.map(function (monthKey) { return { monthKey: monthKey, amountPen: monthlyTotals[monthKey] || 0 }; });
  var windowIndexSum = 0;
  windowMonths.forEach(function (k) { windowIndexSum += profile.index[Number(k.substring(5, 7)) - 1]; });
  return {
    months: months,
    totalPen: totalPen,
    monthsElapsed: windowMonths.length,   // months in the window (<= 12): the old name, kept
    ratePerMonth: windowMonths.length > 0 ? totalPen / windowMonths.length : 0,
    // The same spend with the time of year taken out (== ratePerMonth when the
    // profile is flat or the window is 12 full months): what "Expected" is built from.
    levelPerMonth: windowIndexSum > 0 ? totalPen / windowIndexSum : 0,
    seasonalYears: profile.yearsUsed,
    seasonalYearList: profile.years,
    annualExcludedPen: annualExcludedPen,
    annualExcludedCount: annualExcludedCount
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
