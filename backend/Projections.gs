/**
 * Projections tab: a forward-looking estimate for the current calendar
 * month, combining two sources so nothing gets counted twice —
 * - A category with at least one active recurring item (see
 *   RecurringExpenses.gs — despite the file/table name, a recurring item
 *   can be income or investment too, not only an expense; see "Recurring
 *   income/expenses" in CLAUDE.md) uses that known figure, since it's a
 *   real commitment, not a guess.
 * - Every other category is projected from the average of the last 3
 *   COMPLETE calendar months' actual entries.
 * A category can't land in both buckets, so the two never double-count
 * the same spend.
 */

var PROJECTION_AVERAGE_MONTHS = 3;

function getProjections() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var monthStart = year + '-' + pad2_(month) + '-01';
  var monthEnd = year + '-' + pad2_(month) + '-' + pad2_(new Date(year, month, 0).getDate());
  var monthLabel = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMMM yyyy');

  var categoryById = rowsById_(getAllRows('Categories'));
  var entries = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var monthRateByKey = {};
  getAllRows('Exchange Rates').forEach(function (r) {
    monthRateByKey[r.currency + '|' + r.month] = Number(r.rate);
  });
  function toPen_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = monthRateByKey[currency + '|' + String(dateStr).substring(0, 7)];
    return rate != null ? amount * rate : null;
  }
  function ownAmountPen_(e) {
    var ownAmount = Number(e.amount) - (splitSumByEntry[e.id] || 0);
    return toPen_(ownAmount, e.currency, e.date);
  }

  // The 3 most recent COMPLETE calendar months — never the current one,
  // which is still in progress and would understate a "typical" month.
  var avgMonthKeys = [];
  for (var i = 1; i <= PROJECTION_AVERAGE_MONTHS; i++) {
    var d = new Date(year, month - 1 - i, 1);
    avgMonthKeys.push(d.getFullYear() + '-' + pad2_(d.getMonth() + 1));
  }

  // Recurring items due this month — certain figures, summed per category
  // (regardless of whether that category is income, expense, or
  // investment) so those categories can be excluded from the
  // average-based estimate below, then split by type for the 3 totals.
  var recurringPenByCategory = {};
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false') return;
    var occurrences = recurringExpenseOccurrencesInRange_(r, monthStart, monthEnd);
    if (!occurrences.length) return;
    var pen = toPen_(Number(r.amount) * occurrences.length, r.currency || 'PEN', monthStart);
    if (pen == null) return;
    recurringPenByCategory[r.category_id] = (recurringPenByCategory[r.category_id] || 0) + pen;
  });

  function recurringTotalForType_(type) {
    var total = 0;
    Object.keys(recurringPenByCategory).forEach(function (id) {
      var cat = categoryById[id];
      var catType = cat ? cat.type : 'expense';
      if (catType === type) total += recurringPenByCategory[id];
    });
    return total;
  }

  // Average total for `type`, for categories with NO recurring item of
  // their own — the ones that do rely solely on the recurring figure
  // above, so nothing here counts a second time.
  function averageTotalForType_(type) {
    var sumByCategory = {};
    entries.forEach(function (e) {
      if (e.type !== type || recurringPenByCategory[e.category_id] !== undefined) return;
      if (avgMonthKeys.indexOf(String(e.date).substring(0, 7)) === -1) return;
      var pen = ownAmountPen_(e);
      if (pen == null) return;
      sumByCategory[e.category_id] = (sumByCategory[e.category_id] || 0) + pen;
    });
    var total = 0;
    Object.keys(sumByCategory).forEach(function (id) { total += sumByCategory[id] / PROJECTION_AVERAGE_MONTHS; });
    return total;
  }

  var incomeFromRecurring = recurringTotalForType_('income');
  var incomeFromAverage = averageTotalForType_('income');
  var expensesFromRecurring = recurringTotalForType_('expense');
  var expensesFromAverage = averageTotalForType_('expense');
  var investmentsFromRecurring = recurringTotalForType_('investment');
  var investmentsFromAverage = averageTotalForType_('investment');

  var income = incomeFromRecurring + incomeFromAverage;
  var expenses = expensesFromRecurring + expensesFromAverage;
  var investments = investmentsFromRecurring + investmentsFromAverage;

  return {
    monthLabel: monthLabel,
    averageMonths: PROJECTION_AVERAGE_MONTHS,
    income: income,
    incomeFromRecurring: incomeFromRecurring,
    incomeFromAverage: incomeFromAverage,
    expenses: expenses,
    expensesFromRecurring: expensesFromRecurring,
    expensesFromAverage: expensesFromAverage,
    investments: investments,
    investmentsFromRecurring: investmentsFromRecurring,
    investmentsFromAverage: investmentsFromAverage,
    net: income - expenses - investments
  };
}
