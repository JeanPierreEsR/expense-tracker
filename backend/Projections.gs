/**
 * Projections tab: a forward-looking estimate for the current calendar
 * month, combining two sources so nothing gets counted twice —
 * - Expense categories with at least one active recurring expense (see
 *   RecurringExpenses.gs) use that known figure, since it's a real
 *   commitment, not a guess.
 * - Every other category (and all of income/investments, which have no
 *   recurring concept) is projected from the average of the last 3
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

  // Recurring expenses due this month — certain figures, summed per
  // category so the categories they cover can be excluded from the
  // average-based estimate below.
  var recurringPenByCategory = {};
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false') return;
    var occurrences = recurringExpenseOccurrencesInRange_(r, monthStart, monthEnd);
    if (!occurrences.length) return;
    var pen = toPen_(Number(r.amount) * occurrences.length, r.currency || 'PEN', monthStart);
    if (pen == null) return;
    recurringPenByCategory[r.category_id] = (recurringPenByCategory[r.category_id] || 0) + pen;
  });
  var expensesFromRecurring = 0;
  Object.keys(recurringPenByCategory).forEach(function (id) { expensesFromRecurring += recurringPenByCategory[id]; });

  // Average expense total, for categories with NO recurring expense of
  // their own — the ones that do rely solely on the figure above, so nothing
  // here counts a second time.
  var avgExpensePenByCategory = {};
  entries.forEach(function (e) {
    if (e.type !== 'expense' || recurringPenByCategory[e.category_id] !== undefined) return;
    if (avgMonthKeys.indexOf(String(e.date).substring(0, 7)) === -1) return;
    var pen = ownAmountPen_(e);
    if (pen == null) return;
    avgExpensePenByCategory[e.category_id] = (avgExpensePenByCategory[e.category_id] || 0) + pen;
  });
  var expensesFromAverage = 0;
  Object.keys(avgExpensePenByCategory).forEach(function (id) {
    expensesFromAverage += avgExpensePenByCategory[id] / PROJECTION_AVERAGE_MONTHS;
  });

  // Income and investments have no recurring concept (only expenses do,
  // per the app's own scope) — purely averaged from recent months.
  function averageMonthlyTotal_(type) {
    var total = 0;
    entries.forEach(function (e) {
      if (e.type !== type) return;
      if (avgMonthKeys.indexOf(String(e.date).substring(0, 7)) === -1) return;
      var pen = ownAmountPen_(e);
      if (pen != null) total += pen;
    });
    return total / PROJECTION_AVERAGE_MONTHS;
  }

  var income = averageMonthlyTotal_('income');
  var investments = averageMonthlyTotal_('investment');
  var expenses = expensesFromRecurring + expensesFromAverage;

  return {
    monthLabel: monthLabel,
    averageMonths: PROJECTION_AVERAGE_MONTHS,
    income: income,
    expenses: expenses,
    expensesFromRecurring: expensesFromRecurring,
    expensesFromAverage: expensesFromAverage,
    investments: investments,
    net: income - expenses - investments
  };
}
