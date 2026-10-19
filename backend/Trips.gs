/**
 * Trips & events (2026-10-19) — a named period (a trip to Cusco, a friend's
 * birthday) that expenses can be linked to, so the whole cost can be seen in one
 * place: before, during and after. See specs/trips-events.md.
 *
 * It is only a lens. An expense keeps its own date (the day it was paid), its
 * category, tags, budgets and account balance exactly as before; linking it to a
 * trip adds a `trip_id` on the entry and nothing else changes. One trip per entry.
 * Only the owner's share of an EXPENSE counts (principles 1, 2 and 4) — loans,
 * settlements, transfers, investments and income never do.
 */

var TRIP_KINDS_ = { trip: true, event: true };

// The tab is newer than setupSpreadsheet() — it creates itself on first use,
// same pattern as ensurePayorsSheet_. The date columns are plain text so Sheets
// never turns "2026-12-01" into a Date (see DATE_LIKE_COLUMNS in Setup.gs).
function ensureTripsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Trips')) return;
  var sheet = ss.insertSheet('Trips');
  var headers = TABLE_DEFINITIONS['Trips'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  DATE_LIKE_COLUMNS['Trips'].forEach(function (colName) {
    sheet.getRange(1, headers.indexOf(colName) + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

// Entries from before this feature have no trip_id column; it is appended the
// first time a link is written (same self-heal as merchant / to_payment_method_id).
function ensureEntriesTripColumn_() {
  ensureColumn_('Entries', 'trip_id');
}

function getTripRows_() {
  ensureTripsSheet_();
  return getAllRowsCached_('Trips');
}

function tripById_(id) {
  var found = null;
  getTripRows_().forEach(function (t) { if (t.id === id) found = t; });
  return found;
}

// A trip id the owner may link an entry to — an unknown or blank one means "none".
function validTripIdOrBlank_(id) {
  id = String(id || '');
  return id && tripById_(id) ? id : '';
}

function isIsoDate_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// Checks and tidies what the form sent; throws a plain-language error.
function cleanTripInput_(p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error(tr_('err.enterName'));
  var kind = TRIP_KINDS_[p.kind] ? p.kind : 'trip';
  var start = String(p.start_date || '').trim();
  var end = String(p.end_date || '').trim() || start;
  if (!isIsoDate_(start) || !isIsoDate_(end)) throw new Error(tr_('trip.errDates'));
  if (end < start) throw new Error(tr_('trip.errEndBeforeStart'));
  var amountRaw = p.budget_amount;
  var amount = '';
  var currency = '';
  if (amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== '') {
    var n = Number(amountRaw);
    if (!isFinite(n) || n <= 0) throw new Error(tr_('trip.errBudget'));
    amount = n;
    currency = String(p.budget_currency || homeCurrency_()).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  }
  return {
    name: name, kind: kind, start_date: start, end_date: end,
    emoji: String(p.emoji || '').trim(), budget_amount: amount, budget_currency: currency
  };
}

function addTrip(payload) {
  ensureTripsSheet_();
  var trip = cleanTripInput_(payload || {});
  trip.id = Utilities.getUuid();
  appendRowObject('Trips', trip);
  return trip;
}

function updateTrip(payload) {
  ensureTripsSheet_();
  var sheet = getSheet('Trips');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error(tr_('trip.notFound'));
  var clean = cleanTripInput_(payload);
  withWriteBatch_(function () {
    Object.keys(clean).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, clean[key]); });
  });
  clean.id = payload.id;
  return clean;
}

// Deleting a trip never deletes expenses: they just stop belonging to it.
function deleteTrip(payload) {
  ensureTripsSheet_();
  var id = String(payload.id || '');
  var trip = tripById_(id);
  if (!trip) throw new Error(tr_('trip.notFound'));
  var entrySheet = getSheet('Entries');
  var entryHeaders = getHeaders(entrySheet);
  var col = entryHeaders.indexOf('trip_id');
  withWriteBatch_(function () {
    if (col !== -1 && entrySheet.getLastRow() >= 2) {
      var values = entrySheet.getRange(2, col + 1, entrySheet.getLastRow() - 1, 1).getValues();
      values.forEach(function (row, i) {
        if (String(row[0]) === id) setCellByRow_(entrySheet, entryHeaders, i + 2, 'trip_id', '');
      });
    }
    deleteRowsWhere_('Trips', function (row) { return row.id === id; });
  });
  return { done: true };
}

// The confirmed expenses linked to trips (all trips, or one), each with the
// owner's share in the main currency. Entries with no usable rate are counted
// in `missingRate` instead of silently dropped.
function tripExpenseRows_(onlyTripId) {
  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount);
  });
  var rows = [];
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || e.type !== 'expense' || !e.trip_id) return;
    if (onlyTripId && e.trip_id !== onlyTripId) return;
    var own = Number(e.amount) - (splitSum[e.id] || 0);
    var rate = getRateForEntryCurrency_(e.currency, e.date);
    rows.push({
      entry: e, own: own, currency: e.currency,
      ownMain: rate == null ? null : own * rate
    });
  });
  return rows;
}

// What the trip's budget is measured in: an entry already in the budget's own
// currency counts exactly what was paid; any other goes through the main
// currency at the budget currency's latest rate (same rule as category budgets).
function tripBudgetSpent_(trip, rows) {
  if (!(Number(trip.budget_amount) > 0)) return null;
  var cur = trip.budget_currency || homeCurrency_();
  var rate = null;
  if (cur !== homeCurrency_()) {
    rate = rateToMain_(buildRatesByCurrency_(), cur, String(trip.end_date).substring(0, 7));
    if (rate == null) return null;
  }
  var total = 0;
  rows.forEach(function (r) {
    if (r.currency === cur) total += r.own;
    else if (r.ownMain != null) total += rate == null ? r.ownMain : r.ownMain / rate;
  });
  return total;
}

// For the Trips & events list: every trip with its running total.
function listTrips() {
  var trips = getTripRows_().map(function (t) { return Object.assign({}, t); });
  var byTrip = {};
  tripExpenseRows_(null).forEach(function (r) {
    (byTrip[r.entry.trip_id] = byTrip[r.entry.trip_id] || []).push(r);
  });
  trips.forEach(function (t) {
    var rows = byTrip[t.id] || [];
    t.entryCount = rows.length;
    t.spentMain = rows.reduce(function (sum, r) { return sum + (r.ownMain || 0); }, 0);
    t.budgetSpent = tripBudgetSpent_(t, rows);
  });
  return trips;
}

// One trip's full picture: totals before / during / after, by category, by day.
function getTripDetail(payload) {
  ensureTripsSheet_();
  var trip = tripById_(String(payload.id || ''));
  if (!trip) throw new Error(tr_('trip.notFound'));
  var rows = tripExpenseRows_(trip.id);
  var categoryById = rowsById_(getAllRows('Categories'));

  var phases = { before: 0, during: 0, after: 0 };
  var total = 0, missingRate = 0;
  var byCategory = {};
  var byDay = {};
  rows.forEach(function (r) {
    if (r.ownMain == null) { missingRate++; return; }
    var d = r.entry.date;
    var phase = d < trip.start_date ? 'before' : (d > trip.end_date ? 'after' : 'during');
    phases[phase] += r.ownMain;
    total += r.ownMain;
    addToBucket_(byCategory, r.entry.category_id, r.ownMain, categoryById);
    byDay[d] = (byDay[d] || 0) + r.ownMain;
  });

  return {
    trip: trip,
    totalMain: total,
    before: phases.before, during: phases.during, after: phases.after,
    entryCount: rows.length,
    missingRate: missingRate,
    budgetSpent: tripBudgetSpent_(trip, rows),
    byCategory: bucketToList_(byCategory, total, tr_('report.uncategorized')),
    byDay: Object.keys(byDay).sort().map(function (d) { return { date: d, amount_main: byDay[d] }; })
  };
}
