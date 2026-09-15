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
function computeAllCategoryProjections_(bounds) {
  var periodMonths = bounds.periodType === 'yearly' ? 12 : 1;
  var ytd = ytdRangeForProjection_();

  var categories = getAllRows('Categories').filter(function (c) {
    return c.type === 'income' || c.type === 'expense' || c.type === 'investment';
  });
  var allEntries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  var entriesInPeriod = allEntries.filter(function (e) { return e.date >= bounds.startDate && e.date <= bounds.endDate; });
  var entriesYtd = ytd.ytdStart
    ? allEntries.filter(function (e) { return e.date >= ytd.ytdStart && e.date <= ytd.ytdEnd; })
    : [];
  var allRecurring = getRecurringExpenseRows_().filter(function (r) { return String(r.active) !== 'false'; });

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var monthRateByKey = {};
  getAllRows('Exchange Rates').forEach(function (r) { monthRateByKey[r.currency + '|' + r.month] = Number(r.rate); });
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = monthRateByKey[currency + '|' + String(dateStr).substring(0, 7)];
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
    var categoryRecurring = recurringByCategory[category.id] || [];

    // A yearly-frequency recurring item, viewed monthly, would otherwise
    // dump its whole annual amount into whichever single month it happens
    // to land in — a misleading spike rather than a genuine monthly
    // figure. Left out of the recurring portion for a monthly view of an
    // expense/investment category (its real cost still surfaces smoothed
    // through the YTD rate below, since excluding it here also stops its
    // matching entries from being excluded there); reinstated for a
    // yearly view, where a once-a-year cost showing once a year is
    // exactly correct. Income is never filtered this way — it has no YTD
    // fallback to catch the amount instead, so excluding it would just
    // make a real, known, once-a-year payment disappear in its own month.
    var recurringForPeriod = (category.type === 'income' || bounds.periodType === 'yearly')
      ? categoryRecurring
      : categoryRecurring.filter(function (r) { return r.frequency !== 'yearly'; });

    // Recurring portion for the exact period being shown — each
    // occurrence converted at its own actual date's rate, since a yearly
    // period can span months with different rates on file.
    var recurringAmountPen = 0;
    recurringForPeriod.forEach(function (r) {
      recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate).forEach(function (occDate) {
        var pen = toPen_(Number(r.amount), r.currency || 'PEN', occDate);
        if (pen != null) recurringAmountPen += pen;
      });
    });

    var baseAmountPen = 0;

    if (category.type === 'income') {
      entriesInPeriod.forEach(function (e) {
        if (e.category_id !== category.id) return;
        var matchesRecurring = recurringForPeriod.some(function (r) {
          var occ = recurringExpenseOccurrencesInRange_(r, bounds.startDate, bounds.endDate);
          return entryMatchesRecurringOccurrence_(e, r, occ);
        });
        if (matchesRecurring) return;
        var pen = toPen_(ownAmount_(e), e.currency, e.date);
        if (pen != null) baseAmountPen += pen;
      });
    } else if (ytd.ytdStart) {
      var matchedEntryIds = {};
      recurringForPeriod.forEach(function (r) {
        var occYtd = recurringExpenseOccurrencesInRange_(r, ytd.ytdStart, ytd.ytdEnd);
        entriesYtd.forEach(function (e) {
          if (e.category_id !== category.id || matchedEntryIds[e.id]) return;
          if (entryMatchesRecurringOccurrence_(e, r, occYtd)) matchedEntryIds[e.id] = true;
        });
      });
      var ytdNonRecurringPen = 0;
      entriesYtd.forEach(function (e) {
        if (e.category_id !== category.id || e.type !== category.type || matchedEntryIds[e.id]) return;
        var pen = toPen_(ownAmount_(e), e.currency, e.date);
        if (pen != null) ytdNonRecurringPen += pen;
      });
      baseAmountPen = (ytdNonRecurringPen / ytd.monthsElapsed) * periodMonths;
    }

    var calculatedAmountPen = recurringAmountPen + baseAmountPen;
    var overrideKey = category.id + '|' + bounds.periodKey;
    var hasOverride = overridesByKey[overrideKey] !== undefined;
    var amountPen = hasOverride ? overridesByKey[overrideKey] : calculatedAmountPen;

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
      amountPen: amountPen
    };
  }).filter(function (c) {
    return c.amountPen > 0.005 || c.hasOverride;
  });

  results.sort(function (a, b) { return b.amountPen - a.amountPen; });
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
      hasOverride: false, overrideAmountPen: null, amountPen: 0
    };
  }

  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var monthRateByKey = {};
  getAllRows('Exchange Rates').forEach(function (r) { monthRateByKey[r.currency + '|' + r.month] = Number(r.rate); });
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = monthRateByKey[currency + '|' + String(dateStr).substring(0, 7)];
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

  return { bounds: bounds, projection: match, dailyActualPen: dailyActualPen };
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

  var income = sumByType_('income', 'amountPen');
  var expenses = sumByType_('expense', 'amountPen');
  var investments = sumByType_('investment', 'amountPen');

  return {
    monthLabel: periodLabel,
    periodType: bounds.periodType,
    income: income,
    incomeFromRecurring: sumByType_('income', 'recurringAmountPen'),
    incomeFromAverage: sumByType_('income', 'baseAmountPen'),
    expenses: expenses,
    expensesFromRecurring: sumByType_('expense', 'recurringAmountPen'),
    expensesFromAverage: sumByType_('expense', 'baseAmountPen'),
    investments: investments,
    investmentsFromRecurring: sumByType_('investment', 'recurringAmountPen'),
    investmentsFromAverage: sumByType_('investment', 'baseAmountPen'),
    net: income - expenses - investments
  };
}
