/**
 * Recurring expenses — known fixed costs (rent, subscriptions, gym) that
 * the owner enters once and the app can then account for ahead of time,
 * instead of only ever knowing about them after they've been logged as a
 * regular Entry. Used by the Budgets chart (Budgets.gs) and the
 * Projections tab (Projections.gs); managed from the More > Recurring
 * expenses screen.
 */

// This table was added after setupSpreadsheet() was last run for real, so
// unlike the tables from Phase 0 it can't assume its own tab already
// exists — self-heals by creating it (with headers) on first use instead
// of requiring a one-off admin step before the feature works at all.
function ensureRecurringExpensesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Recurring Expenses')) return;
  var sheet = ss.insertSheet('Recurring Expenses');
  var headers = TABLE_DEFINITIONS['Recurring Expenses'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function getRecurringExpenseRows_() {
  ensureRecurringExpensesSheet_();
  return getAllRows('Recurring Expenses');
}

function listRecurringExpenses() {
  var categoryById = rowsById_(getAllRows('Categories'));
  return getRecurringExpenseRows_().map(function (r) {
    return recurringExpenseForClient_(r, categoryById);
  }).sort(function (a, b) { return a.category_name.localeCompare(b.category_name); });
}

function recurringExpenseForClient_(r, categoryById) {
  var cat = categoryById[r.category_id];
  return {
    id: r.id,
    category_id: r.category_id,
    category_name: cat ? cat.name : '(unknown category)',
    category_icon: cat ? cat.icon : '',
    category_color: cat ? cat.color : '',
    description: r.description || '',
    amount: Number(r.amount),
    currency: r.currency || 'PEN',
    frequency: r.frequency === 'yearly' ? 'yearly' : 'monthly',
    day: r.day ? Number(r.day) : 1,
    month: r.month ? Number(r.month) : 1,
    active: String(r.active) !== 'false'
  };
}

function addRecurringExpense(payload) {
  ensureRecurringExpensesSheet_();
  var re = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    description: payload.description ? String(payload.description).trim() : '',
    amount: payload.amount,
    currency: payload.currency || 'PEN',
    frequency: payload.frequency === 'yearly' ? 'yearly' : 'monthly',
    day: payload.day || 1,
    month: payload.month || 1,
    active: payload.active === false ? 'false' : 'true'
  };
  appendRowObject('Recurring Expenses', re);
  var categoryById = rowsById_(getAllRows('Categories'));
  return recurringExpenseForClient_(re, categoryById);
}

function updateRecurringExpense(payload) {
  ensureRecurringExpensesSheet_();
  var sheet = getSheet('Recurring Expenses');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Recurring expense not found');

  ['category_id', 'description', 'amount', 'currency', 'frequency', 'day', 'month', 'active'].forEach(function (field) {
    if (payload[field] === undefined) return;
    var value = payload[field];
    if (field === 'description') value = String(value || '').trim();
    if (field === 'active') value = (value === false || value === 'false') ? 'false' : 'true';
    if (field === 'frequency') value = value === 'yearly' ? 'yearly' : 'monthly';
    setCellByRow_(sheet, headers, rowIndex, field, value);
  });
  return { done: true };
}

function deleteRecurringExpense(id) {
  ensureRecurringExpensesSheet_();
  var sheet = getSheet('Recurring Expenses');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);
  return { done: true };
}

// The calendar dates (YYYY-MM-DD) on which a recurring expense actually
// falls within [startDate, endDate] (inclusive). A monthly one occurs
// once per calendar month in range; a yearly one occurs once per calendar
// year, only in its own month. `day` is clamped to each month's real
// length (e.g. day 31 in February lands on the 28th/29th) rather than
// skipping short months entirely.
function recurringExpenseOccurrencesInRange_(re, startDate, endDate) {
  if (String(re.active) === 'false') return [];
  var start = new Date(startDate + 'T00:00:00');
  var end = new Date(endDate + 'T00:00:00');
  var day = re.day ? Number(re.day) : 1;
  var dates = [];

  if (re.frequency === 'yearly') {
    var month = re.month ? Number(re.month) : 1;
    for (var y = start.getFullYear(); y <= end.getFullYear(); y++) {
      var d = clampedCalendarDate_(y, month, day);
      if (d >= start && d <= end) dates.push(formatCalendarDate_(d));
    }
  } else {
    var cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
      var occ = clampedCalendarDate_(cursor.getFullYear(), cursor.getMonth() + 1, day);
      if (occ >= start && occ <= end) dates.push(formatCalendarDate_(occ));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }
  return dates;
}

function clampedCalendarDate_(year, month, day) {
  var lastDayOfMonth = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(day, lastDayOfMonth));
}

function formatCalendarDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
