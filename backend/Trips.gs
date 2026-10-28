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
var tripsColumnsChecked_ = false;   // per execution: the column check reads the header row once

function ensureTripsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Trips')) {
    if (!tripsColumnsChecked_) {
      tripsColumnsChecked_ = true;
      ensureColumn_('Trips', 'alert_thresholds');   // a tab made before the alerts existed
      ensureColumn_('Trips', 'currency');           // ... and before each trip had its own currency
    }
    return;
  }
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

// A Programmed item may carry a trip only when the trip exists and the item is an
// expense (an income category never belongs to a trip). Anything else = none.
function tripIdForProgrammed_(tripId, categoryId) {
  var id = validTripIdOrBlank_(tripId);
  if (!id) return '';
  var cat = rowsById_(getAllRows('Categories'))[categoryId];
  return cat && cat.type === 'expense' ? id : '';
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
  // The trip's own currency (3 letters). Blank = follow budget_currency (older callers) or the main currency.
  var currencyRaw = String(p.currency || p.budget_currency || '').trim().toUpperCase();
  if (currencyRaw && !/^[A-Z]{3}$/.test(currencyRaw)) throw new Error(tr_('err.currencyCode'));
  var amountRaw = p.budget_amount;
  var amount = '';
  if (amountRaw !== undefined && amountRaw !== null && String(amountRaw).trim() !== '') {
    var n = Number(amountRaw);
    if (!isFinite(n) || n <= 0) throw new Error(tr_('trip.errBudget'));
    amount = n;
  }
  // A budget is always in the trip's currency.
  var currency = currencyRaw || (amount !== '' ? homeCurrency_() : '');
  // Alert percentages (only meaningful with a budget). Blank = the usual budget ones; anything else is checked.
  var thresholdsRaw = String(p.alert_thresholds === undefined || p.alert_thresholds === null ? '' : p.alert_thresholds).trim();
  var thresholds = amount !== '' && thresholdsRaw !== '' ? normalizeBudgetThresholds_(thresholdsRaw) : '';
  return {
    name: name, kind: kind, start_date: start, end_date: end,
    emoji: String(p.emoji || '').trim(), budget_amount: amount, budget_currency: amount !== '' ? currency : '',
    alert_thresholds: thresholds, currency: currency
  };
}

function addTrip(payload) {
  ensureTripsSheet_();
  var trip = cleanTripInput_(payload || {});
  trip.id = Utilities.getUuid();
  appendRowObject('Trips', trip);
  ensureTripGroupFriend_(trip);
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
  renameTripGroupFriend_(clean, payload.id);
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
    // Estimates (one-time Programmed items) in this trip stay, just unlinked.
    ensureRecurringExpensesSheet_();
    var recSheet = getSheet('Recurring Expenses');
    var recHeaders = getHeaders(recSheet);
    var recCol = recHeaders.indexOf('trip_id');
    if (recCol !== -1 && recSheet.getLastRow() >= 2) {
      recSheet.getRange(2, recCol + 1, recSheet.getLastRow() - 1, 1).getValues().forEach(function (row, i) {
        if (String(row[0]) === id) setCellByRow_(recSheet, recHeaders, i + 2, 'trip_id', '');
      });
    }
    releaseTripGroupFriend_(id);
    deleteRowsWhere_('Trips', function (row) { return row.id === id; });
    deleteRowsWhere_('Budget Alert Log', function (r) { return r.budget_id === id && r.period === TRIP_ALERT_PERIOD_; });
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
      ownMain: rate == null ? null : own * rate,
      full: Number(e.amount), fullMain: rate == null ? null : Number(e.amount) * rate
    });
  });
  return rows;
}

// ESTIMATES: the one-time Programmed items linked to trips that nothing has paid yet,
// each at the owner's own share. An item stops being an estimate as soon as a real
// confirmed entry pays it by the usual rule (same category, ~10% of the share, within
// the day window — or an explicit "Mark as paid" link; entryMatchesRecurringOccurrence_).
// `paidBy` is that entry, so the trip screen can offer to add it to the trip when it is
// not part of it yet (nothing is linked without the owner's tap).
function tripEstimateRows_(onlyTripId) {
  ensureRecurringExpensesSheet_();
  var items = getRecurringExpenseRows_().filter(function (r) {
    return r.trip_id && normalizeRecurringFrequency_(r.frequency) === 'once' && String(r.active) !== 'false' &&
      r.date && (!onlyTripId || r.trip_id === onlyTripId);
  });
  if (!items.length) return [];

  var splitSums = getRecurringExpenseSplitSums_();
  var entrySplitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSum[s.entry_id] = (entrySplitSum[s.entry_id] || 0) + Number(s.amount);
  });
  var confirmed = getAllRows('Entries').filter(function (e) { return e.status === 'confirmed' && e.type === 'expense'; });
  var categoryById = rowsById_(getAllRows('Categories'));

  return items.map(function (r) {
    var paidBy = null;
    confirmed.some(function (e) {
      if (e.recurring_expense_id && e.recurring_expense_id !== r.id) return false;
      if (e.category_id !== r.category_id && e.recurring_expense_id !== r.id) return false;
      if (!entryMatchesRecurringOccurrence_(e, r, [r.date], entrySplitSum, splitSums)) return false;
      paidBy = e;
      return true;
    });
    var currency = r.currency || homeCurrency_();
    var own = recurringOwnAmount_(r, splitSums);
    var rate = getRateForEntryCurrency_(currency, r.date);
    var cat = categoryById[r.category_id];
    return {
      item: r, paidBy: paidBy, own: own, currency: currency, date: r.date,
      ownMain: rate == null ? null : own * rate,
      category: cat || null
    };
  });
}

// The currency a trip is shown in: its own, else the one its budget was set in (older trips), else the main one.
// All the "...Main" fields below (spentMain, totalMain, amount_main…) are in THIS currency, kept under their
// old names so nothing that reads them had to change.
function tripCurrency_(t) {
  return String(t.currency || t.budget_currency || '').toUpperCase() || homeCurrency_();
}

// A row's owner's-share in `cur`: exactly what was paid when it is already in `cur` (no rate needed),
// otherwise through the main currency at the rates on file around that row's own month. Null when a
// needed rate is missing (the row is then counted in `missingRate`, never silently dropped).
function tripAmountIn_(cur, r) {
  if (r.currency === cur) return r.own;
  if (r.ownMain == null) return null;
  if (cur === homeCurrency_()) return r.ownMain;
  var rate = rateToMain_(buildRatesByCurrency_(), cur, String(tripRowDate_(r)).substring(0, 7));
  return rate == null || !(rate > 0) ? null : r.ownMain / rate;
}

// The exchange rate a row is waiting for, as { currency, month } — or null when it needs none. Mirrors
// tripAmountIn_: first the row's own currency into the main one, then the main one into the trip's currency.
function tripRateNeed_(cur, r) {
  if (r.currency === cur) return null;
  var month = String(tripRowDate_(r)).substring(0, 7);
  if (r.ownMain == null) return { currency: r.currency, month: month };
  if (cur === homeCurrency_()) return null;
  var rate = rateToMain_(buildRatesByCurrency_(), cur, month);
  return rate == null || !(rate > 0) ? { currency: cur, month: month } : null;
}

// Rows of both kinds share what the totals need: when (date), which category, and the
// owner's share in its own currency and in the main currency.
function tripRowDate_(r) { return r.entry ? r.entry.date : r.date; }
function tripRowCategory_(r) { return r.entry ? r.entry.category_id : r.item.category_id; }

// Real payments plus the estimates nothing has paid yet. Estimates whose payment exists but
// is not part of the trip are NOT counted (the payment would be, once the owner adds it).
function tripAllRows_(onlyTripId) {
  var real = tripExpenseRows_(onlyTripId);
  var estimates = tripEstimateRows_(onlyTripId).filter(function (e) { return !e.paidBy; });
  return real.concat(estimates.map(function (e) { e.isEstimate = true; return e; }));
}

// For the Trips & events list: every trip with its running total (real + estimated), in its own currency.
function listTrips() {
  var trips = getTripRows_().map(function (t) { return Object.assign({}, t); });
  var byTrip = {};
  tripAllRows_(null).forEach(function (r) {
    var id = r.entry ? r.entry.trip_id : r.item.trip_id;
    (byTrip[id] = byTrip[id] || []).push(r);
  });
  trips.forEach(function (t) {
    var cur = tripCurrency_(t);
    var rows = byTrip[t.id] || [];
    var total = 0, estimated = 0;
    rows.forEach(function (r) {
      var amount = tripAmountIn_(cur, r);
      if (amount == null) return;
      total += amount;
      if (r.isEstimate) estimated += amount;
    });
    t.cur = cur;
    t.entryCount = rows.filter(function (r) { return !r.isEstimate; }).length;
    t.estimateCount = rows.filter(function (r) { return r.isEstimate; }).length;
    t.spentMain = total;
    t.estimatedMain = estimated;
    t.budgetSpent = Number(t.budget_amount) > 0 ? total : null;
  });
  return trips;
}

// One trip's full picture, in the trip's own currency: totals before / during / after, by category, by day,
// the estimates still waiting, and payments that settled an estimate but are not in the trip.
function getTripDetail(payload) {
  ensureTripsSheet_();
  var trip = tripById_(String(payload.id || ''));
  if (!trip) throw new Error(tr_('trip.notFound'));
  var cur = tripCurrency_(trip);
  var rows = tripAllRows_(trip.id);
  var categoryById = rowsById_(getAllRows('Categories'));

  var phases = { before: 0, during: 0, after: 0 };
  var total = 0, estimated = 0, missingRate = 0, realCount = 0;
  var needs = {};   // currency -> { currency, month (earliest), count }
  var byCategory = {};
  var byDay = {};
  var estimates = [];
  var today = formatCalendarDate_(new Date());
  rows.forEach(function (r) {
    if (!r.isEstimate) realCount++;
    var amount = tripAmountIn_(cur, r);
    if (r.isEstimate) {
      var cat = r.category;
      estimates.push({
        id: r.item.id, description: r.item.description || '', date: r.date,
        category_name: cat ? categoryLabel_(cat) : tr_('label.unknownCategory'), category_icon: cat ? cat.icon : '',
        amount: r.own, currency: r.currency, own_main: amount, overdue: r.date < today
      });
    }
    if (amount == null) {
      missingRate++;
      var need = tripRateNeed_(cur, r);
      if (need) {
        var n = needs[need.currency] || (needs[need.currency] = { currency: need.currency, month: need.month, count: 0 });
        n.count++;
        if (need.month < n.month) n.month = need.month;
      }
      return;
    }
    var d = tripRowDate_(r);
    var phase = d < trip.start_date ? 'before' : (d > trip.end_date ? 'after' : 'during');
    phases[phase] += amount;
    total += amount;
    if (r.isEstimate) estimated += amount;
    addToBucket_(byCategory, tripRowCategory_(r), amount, categoryById);
    byDay[d] = (byDay[d] || 0) + amount;
  });
  estimates.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });

  // An estimate settled by a payment that is not part of this trip yet: offer it, never link on its own.
  var unlinkedPayments = [];
  tripEstimateRows_(trip.id).forEach(function (e) {
    if (!e.paidBy || e.paidBy.trip_id) return;
    unlinkedPayments.push({
      item_description: e.item.description || '',
      entry: {
        id: e.paidBy.id, date: e.paidBy.date, description: e.paidBy.description || '',
        amount: Number(e.paidBy.amount), currency: e.paidBy.currency
      }
    });
  });

  return {
    trip: trip,
    currency: cur,
    totalMain: total,
    estimatedMain: estimated,
    before: phases.before, during: phases.during, after: phases.after,
    entryCount: realCount,
    missingRate: missingRate,
    // One line per currency, at its EARLIEST month: a rate set there covers every later month, so the
    // list shrinks as the person fills it in (never one prompt per expense).
    missingRates: Object.keys(needs).sort().map(function (c) { return needs[c]; }),
    budgetSpent: Number(trip.budget_amount) > 0 ? total : null,
    byCategory: bucketToList_(byCategory, total, tr_('report.uncategorized')),
    byDay: Object.keys(byDay).sort().map(function (d) { return { date: d, amount_main: byDay[d] }; }),
    estimates: estimates,
    unlinkedPayments: unlinkedPayments,
    group: tripGroupBalance_(trip, cur)
  };
}

// ---- Suggestions by date (always confirmed by the owner; nothing links on its own) ----

// The trips/events whose dates include `date` (YYYY-MM-DD).
function tripsCoveringDate_(date, trips) {
  var d = String(date || '');
  return (trips || getTripRows_()).filter(function (t) { return d >= t.start_date && d <= t.end_date; });
}

// The one trip a date points to — or '' when none or SEVERAL cover it (never guess between two).
function suggestedTripIdForDate_(date, trips) {
  var found = tripsCoveringDate_(date, trips);
  return found.length === 1 ? found[0].id : '';
}

// "Find expenses in these dates": confirmed expenses that fall inside the trip's dates and
// belong to no trip yet. Only a list — the owner ticks which ones to add (linkEntriesToTrip).
var TRIP_CANDIDATE_LIMIT_ = 300;

function findTripCandidates(payload) {
  ensureTripsSheet_();
  var trip = tripById_(String(payload.id || ''));
  if (!trip) throw new Error(tr_('trip.notFound'));
  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount);
  });
  var categoryById = rowsById_(getAllRows('Categories'));
  // `lookBack` (months, up to 24): also list expenses paid before the trip starts — a flight bought months
  // ahead is dated the day it was paid (see the dating rule), which is outside the trip's own dates.
  var lookBack = Math.max(0, Math.min(24, Math.floor(Number(payload.lookBack) || 0)));
  var from = trip.start_date;
  if (lookBack) {
    var y = Number(from.substring(0, 4)), m = Number(from.substring(5, 7)) - lookBack;
    while (m < 1) { m += 12; y--; }
    from = y + '-' + (m < 10 ? '0' : '') + m + '-' + from.substring(8, 10);
  }
  var found = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.type === 'expense' && !e.trip_id &&
      e.date >= from && e.date <= trip.end_date;
  }).sort(function (a, b) {
    // The trip's own dates first (oldest first); then, only when looking back, the nearest earlier ones first,
    // so the 300-row cap never cuts off the expenses inside the trip.
    var aBefore = a.date < trip.start_date, bBefore = b.date < trip.start_date;
    if (aBefore !== bBefore) return aBefore ? 1 : -1;
    if (aBefore) return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0);
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });
  var rows = found.slice(0, TRIP_CANDIDATE_LIMIT_).map(function (e) {
    var cat = categoryById[e.category_id];
    return {
      id: e.id, date: e.date, description: e.description || '', currency: e.currency,
      amount: Number(e.amount), own_share: Number(e.amount) - (splitSum[e.id] || 0),
      category_name: cat ? categoryLabel_(cat) : '', category_icon: cat ? cat.icon : ''
    };
  });
  return { total: found.length, entries: rows };
}

// Links the ticked expenses to the trip. Only a confirmed expense with no trip is touched
// (never one already in another trip), so a stale list can't overwrite anything.
function linkEntriesToTrip(payload) {
  ensureTripsSheet_();
  var trip = tripById_(String(payload.id || ''));
  if (!trip) throw new Error(tr_('trip.notFound'));
  var wanted = {};
  (payload.entryIds || []).forEach(function (id) { wanted[String(id)] = true; });
  var eligible = {};
  getAllRows('Entries').forEach(function (e) {
    if (wanted[e.id] && e.status === 'confirmed' && e.type === 'expense' && !e.trip_id) eligible[e.id] = true;
  });
  if (!Object.keys(eligible).length) return { linked: 0 };
  ensureEntriesTripColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var idCol = headers.indexOf('id');
  var idValues = sheet.getRange(2, idCol + 1, sheet.getLastRow() - 1, 1).getValues();
  var linked = 0;
  withWriteBatch_(function () {
    idValues.forEach(function (row, i) {
      if (eligible[String(row[0])]) {
        setCellByRow_(sheet, headers, i + 2, 'trip_id', trip.id);
        linked++;
      }
    });
  });
  return { linked: linked };
}

// ---- Budget alerts through Telegram (same idea and cycle as category budgets) ----
// A trip with a budget warns when what it counts (paid + estimates, the same figure as its budget bar)
// first crosses each alert percentage. Dedup is by the shared Budget Alert Log with the trip's id as
// `budget_id` and period 'trip'; falling back below a percentage forgets it, so crossing again warns
// again — exactly the category-budget rules. One message per trip per run, quoting the live percentage.
// Only trips that have not ended more than 30 days ago are looked at.
var TRIP_ALERT_PERIOD_ = 'trip';
var TRIP_ALERT_GRACE_DAYS_ = 30;

function tripDisplayName_(t) {
  return (t.emoji || (t.kind === 'event' ? '🎉' : '✈️')) + ' ' + t.name;
}

function checkTripBudgets() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return checkTripBudgetsLocked_();
  } finally {
    lock.releaseLock();
  }
}

function checkTripBudgetsLocked_() {
  var cutoff = formatCalendarDate_(new Date(Date.now() - TRIP_ALERT_GRACE_DAYS_ * 24 * 3600 * 1000));
  var trips = listTrips().filter(function (t) {
    return Number(t.budget_amount) > 0 && t.budgetSpent != null && t.end_date >= cutoff;
  });
  // The first run on an existing copy only writes down what is already over a limit, without alerting (Notices.gs § Alerts only from now on).
  var baseline = alertBaselinePending_('trips');
  if (!trips.length) {
    if (baseline) markAlertBaselineDone_('trips');
    return { checked: 0, alertsSent: 0 };
  }

  var alertedSet = {};
  getAllRows('Budget Alert Log').forEach(function (a) {
    if (a.period === TRIP_ALERT_PERIOD_) alertedSet[a.budget_id + '|' + a.threshold] = true;
  });

  var alertsSent = 0;
  var staleKeys = {};
  trips.forEach(function (t) {
    var percent = Number(t.budgetSpent) / Number(t.budget_amount) * 100;
    var thresholds = String(t.alert_thresholds || DEFAULT_BUDGET_THRESHOLDS)
      .split(',')
      .map(function (x) { return Number(String(x).trim()); })
      .filter(function (x) { return !isNaN(x); })
      .sort(function (a, b) { return a - b; });

    thresholds.forEach(function (threshold) {
      if (percent < threshold) {
        var staleKey = t.id + '|' + threshold;
        if (alertedSet[staleKey]) { staleKeys[staleKey] = true; delete alertedSet[staleKey]; }
      }
    });
    var newlyCrossed = thresholds.filter(function (threshold) {
      return percent >= threshold && !alertedSet[t.id + '|' + threshold];
    });
    if (!newlyCrossed.length) return;

    if (!baseline && !deliverNotice_('trip', 'trip|' + t.id, tripBudgetAlertText_(t, percent))) return;   // a linked Telegram refused: try again next cycle (Notices.gs)
    newlyCrossed.forEach(function (threshold) {
      appendRowObject('Budget Alert Log', {
        id: Utilities.getUuid(), budget_id: t.id, threshold: threshold, period: TRIP_ALERT_PERIOD_,
        sent_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
      });
      alertedSet[t.id + '|' + threshold] = true;
    });
    if (!baseline) alertsSent++;
  });

  if (Object.keys(staleKeys).length) {
    deleteRowsWhere_('Budget Alert Log', function (r) {
      return r.period === TRIP_ALERT_PERIOD_ && staleKeys[r.budget_id + '|' + r.threshold] === true;
    });
  }
  if (baseline) markAlertBaselineDone_('trips');
  return { checked: trips.length, alertsSent: alertsSent };
}

// ---- Telegram's Confirm links the suggested trip by default ----
// In Telegram a pending entry is confirmed by the Confirm button OR by its first successful reply, so both
// go through linkSuggestedTripOnTelegramConfirm_ just before confirming. The card says beforehand which
// trip it will be linked to ("trip none" skips it). "trip none" on a pending entry stores TRIP_DECLINED_ in
// trip_id (no real trip has that id) so the skip survives until the confirmation; confirmEntryWithLearning_
// clears it, so it never stays on a confirmed entry. The app's own Confirm is NOT affected: its card sends
// the picker's value (including None) explicitly.
var TRIP_DECLINED_ = '-none-';

function linkSuggestedTripOnTelegramConfirm_(entryId) {
  var entry = getEntryById_(entryId);
  if (!entry || entry.type !== 'expense' || entry.status !== 'pending') return;
  if (entry.trip_id === TRIP_DECLINED_) { setEntryField_(entryId, 'trip_id', ''); return; }
  if (entry.trip_id) return;                       // already chosen (by reply or in the app)
  var suggested = suggestedTripIdForDate_(entry.date);
  if (!suggested) return;                          // no trip, or two cover the date: no guess
  ensureEntriesTripColumn_();
  setEntryField_(entryId, 'trip_id', suggested);
}


// ---- Group settlement (Splitwise-style trips) ----
// A trip has ONE hidden "group" friend (Friends.trip_id = the trip's id). What the owner fronted for the
// group is split with that friend, so it becomes an ordinary loan and the trip still counts only the owner's
// share. Money moving between the owner and the group is a normal repayment (never income or expense);
// only what goes beyond any debt becomes a real expense (the owner paid the group more than was owed) —
// linked to the trip — or income (the group paid more than was owed). See specs/trips-events.md.

function ensureFriendsTripColumn_() {
  ensureColumn_('Friends', 'trip_id');
}

function tripGroupName_(trip) {
  return tr_('trip.groupName', { trip: trip.name });
}

// The group friend of a trip, created on first use. Reads the sheet uncached so a repeat call can't make a second.
function ensureTripGroupFriend_(trip) {
  ensureFriendsTripColumn_();
  var found = getAllRows('Friends').find(function (f) { return f.trip_id === trip.id; });
  if (found) return found;
  var friend = { id: Utilities.getUuid(), name: tripGroupName_(trip), notes: '', trip_id: trip.id };
  appendRowObject('Friends', friend);
  return friend;
}

function ensureAllTripGroupFriends_() {
  getTripRows_().forEach(function (t) { ensureTripGroupFriend_(t); });
}

function tripGroupFriend_(tripId) {
  var sheet = getSheet('Friends');
  if (getHeaders(sheet).indexOf('trip_id') === -1) return null;
  return getAllRows('Friends').find(function (f) { return f.trip_id === tripId; }) || null;
}

function renameTripGroupFriend_(trip, tripId) {
  var friend = tripGroupFriend_(tripId);
  if (friend) updateRowFields_('Friends', friend.id, { name: tripGroupName_(trip) });
}

// Deleting a trip: a group friend with no loans goes away; one that still has a balance stays as an ordinary friend.
function releaseTripGroupFriend_(tripId) {
  var friend = tripGroupFriend_(tripId);
  if (!friend) return;
  var hasLoans = getAllRows('Loans').some(function (l) { return l.friend_id === friend.id; });
  if (hasLoans) updateRowFields_('Friends', friend.id, { trip_id: '' });
  else deleteRowsWhere_('Friends', function (row) { return row.id === friend.id; });
}

// The balance check: per currency what the group owes the owner (positive pending) or the owner owes it
// (negative), from the group friend's loans. Plus, in the trip's currency, what the owner paid out of pocket.
function tripGroupBalance_(trip, cur) {
  var friend = tripGroupFriend_(trip.id);
  var paidOut = 0, paidOutKnown = true;
  tripExpenseRows_(trip.id).forEach(function (r) {
    if (r.entry.paid_by !== 'me') return;
    var amount = tripAmountIn_(cur, { currency: r.currency, own: r.full, ownMain: r.fullMain, entry: r.entry });
    if (amount == null) paidOutKnown = false; else paidOut += amount;
  });
  var out = { friend_id: friend ? friend.id : '', paidOut: paidOut, paidOutKnown: paidOutKnown, rows: [] };
  if (!friend) return out;
  var settled = buildSettlementTotalsByLoan_();
  var byCur = {};
  getAllRows('Loans').forEach(function (l) {
    if (l.friend_id !== friend.id || l.status === 'forgiven') return;
    var c = byCur[l.currency] || (byCur[l.currency] = { currency: l.currency, fronted: 0, borrowed: 0, pending: 0 });
    var remaining = Number(l.amount) - (settled[l.id] || 0);
    if (l.direction === 'they_owe_me') { c.fronted += Number(l.amount); c.pending += remaining; }
    else { c.borrowed += Number(l.amount); c.pending -= remaining; }
  });
  out.rows = Object.keys(byCur).sort().map(function (k) {
    byCur[k].pending = Math.round(byCur[k].pending * 100) / 100;
    return byCur[k];
  });
  return out;
}

// "Group settlement": money that moved between the owner and the trip's group. direction 'borrowed' / 'lent' = cash
// loaned inside the group (a new loan); 'received' = the
// group paid the owner, 'paid' = the owner paid the group. It is a normal repayment with the group friend
// (same engine, same linked transfer), so it never counts as income/expense — except the part beyond any debt:
// an expense when the owner paid more than was owed (the share of what others paid), linked to this trip.
function recordTripSettlement(payload) {
  ensureTripsSheet_();
  var trip = tripById_(String(payload.trip_id || ''));
  if (!trip) throw new Error(tr_('trip.notFound'));
  var friend = ensureTripGroupFriend_(trip);
  // Cash that changed hands INSIDE the group (borrowed from / lent to it) is a loan, not a repayment: the
  // balance block then shows it, and the final settlement nets it like any other debt.
  if (payload.direction === 'borrowed' || payload.direction === 'lent') {
    var lent = payload.direction === 'lent';
    return addLoan({
      friend_id: friend.id,
      direction: lent ? 'they_owe_me' : 'i_owe_them',
      amount: payload.amount,
      date: payload.date,
      currency: payload.currency || tripCurrency_(trip),
      payment_method_id: payload.payment_method_id,
      description: tr_(lent ? 'trip.cashLent' : 'trip.cashBorrowed', { trip: tripDisplayName_(trip) })
    });
  }
  var received = payload.direction === 'received';
  if (!received && payload.direction !== 'paid') throw new Error(tr_('err.invalidDirection'));
  var result = recordRepayment({
    friend_id: friend.id,
    direction: received ? 'they_owe_me' : 'i_owe_them',
    amount: payload.amount,
    date: payload.date,
    currency: payload.currency || tripCurrency_(trip),
    payment_method_id: payload.payment_method_id,
    overpay_category_id: payload.overpay_category_id,
    description: tr_(received ? 'trip.settlementReceived' : 'trip.settlementPaid', { trip: tripDisplayName_(trip) })
  });
  return result;   // recordRepayment links a "paid more than owed" leftover to the trip itself
}
