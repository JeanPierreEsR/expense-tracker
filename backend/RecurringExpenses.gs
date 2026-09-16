/**
 * Programmed income/expenses — known fixed amounts the owner enters once
 * and the app can then account for ahead of time, instead of only ever
 * knowing about them after they've been logged as a regular Entry. Two
 * kinds, both rows in the same sheet/table (kept as "Recurring Expenses"
 * on purpose so an already-created sheet tab isn't orphaned by a rename —
 * see CLAUDE.md): **recurring** (`frequency` monthly/yearly, repeats
 * forever on a `day`/`month`) — rent, subscriptions, gym, salary — and
 * **one-time** (`frequency` 'once', a single real calendar `date`,
 * added 2026-09-16) — a known future payment you don't want cluttering
 * "Recent entries" the way a pre-dated Entry would (see CLAUDE.md's
 * Recurring Expenses section). A one-time item naturally stops mattering
 * after its own date, with no separate expiry logic needed — see
 * recurringExpenseOccurrencesInRange_ below. An item's own category
 * decides whether it's income, expense, or investment; nothing here is
 * expense-only. Used by the Budgets chart (Budgets.gs, expense categories
 * only, since budgets themselves are expense-only) and the Projections
 * tab (Projections.gs, all types); managed from the More > Programmed
 * income/expenses screen.
 */

// This table was added after setupSpreadsheet() was last run for real, so
// unlike the tables from Phase 0 it can't assume its own tab already
// exists — self-heals by creating it (with headers) on first use instead
// of requiring a one-off admin step before the feature works at all.
// 'date' (the one-time-item column) came later still, after this sheet
// already held real data — self-heals by appending the missing column in
// place, same pattern as Categories' period_type in Projections.gs.
function ensureRecurringExpensesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Recurring Expenses');
  if (!sheet) {
    sheet = ss.insertSheet('Recurring Expenses');
    var headers = TABLE_DEFINITIONS['Recurring Expenses'];
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }
  var existingHeaders = getHeaders(sheet);
  if (existingHeaders.indexOf('date') === -1) {
    sheet.getRange(1, existingHeaders.length + 1).setValue('date');
  }
}

function getRecurringExpenseRows_() {
  ensureRecurringExpensesSheet_();
  ensureEntriesRecurringLinkColumn_();
  return getAllRows('Recurring Expenses');
}

// Entries already existed (Phase 0) when this column was added, so unlike
// Recurring Expenses' own self-heal above, there's no "create the sheet"
// branch here — just append the one missing column in place, same pattern.
// See entryMatchesRecurringOccurrence_'s explicit-link check, below, for
// why this exists: a true-up where the owner corrected a recurring item's
// day/currency/amount back to what they actually intend going forward
// left older Entries — logged under the old, different convention —
// unable to match by the normal heuristic (exact currency, ~10% amount,
// within a few days of the item's day) without permanently loosening it
// for everyone. This lets specific historical Entries be pointed at the
// recurring item they actually represent instead.
function ensureEntriesRecurringLinkColumn_() {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  if (headers.indexOf('recurring_expense_id') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('recurring_expense_id');
  }
}

function listRecurringExpenses() {
  var categoryById = rowsById_(getAllRows('Categories'));
  return getRecurringExpenseRows_().map(function (r) {
    return recurringExpenseForClient_(r, categoryById);
  }).sort(function (a, b) {
    var aOnce = a.frequency === 'once', bOnce = b.frequency === 'once';
    if (aOnce !== bOnce) return aOnce ? 1 : -1; // one-time items sort after recurring ones
    if (aOnce) return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
    if (a.day !== b.day) return a.day - b.day;
    return a.category_name.localeCompare(b.category_name);
  });
}

function normalizeRecurringFrequency_(freq) {
  if (freq === 'yearly') return 'yearly';
  if (freq === 'once') return 'once';
  return 'monthly';
}

function recurringExpenseForClient_(r, categoryById) {
  var cat = categoryById[r.category_id];
  var frequency = normalizeRecurringFrequency_(r.frequency);
  return {
    id: r.id,
    category_id: r.category_id,
    category_name: cat ? cat.name : '(unknown category)',
    category_icon: cat ? cat.icon : '',
    category_color: cat ? cat.color : '',
    category_type: cat ? cat.type : 'expense',
    description: r.description || '',
    amount: Number(r.amount),
    currency: r.currency || 'PEN',
    frequency: frequency,
    day: r.day ? Number(r.day) : 1,
    month: r.month ? Number(r.month) : 1,
    date: r.date || '',
    active: String(r.active) !== 'false'
  };
}

function addRecurringExpense(payload) {
  ensureRecurringExpensesSheet_();
  var frequency = normalizeRecurringFrequency_(payload.frequency);
  var re = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    description: payload.description ? String(payload.description).trim() : '',
    amount: payload.amount,
    currency: payload.currency || 'PEN',
    frequency: frequency,
    day: frequency === 'once' ? '' : (payload.day || 1),
    month: frequency === 'once' ? '' : (payload.month || 1),
    date: frequency === 'once' ? (payload.date || '') : '',
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

  ['category_id', 'description', 'amount', 'currency', 'frequency', 'day', 'month', 'date', 'active'].forEach(function (field) {
    if (payload[field] === undefined) return;
    var value = payload[field];
    if (field === 'description') value = String(value || '').trim();
    if (field === 'active') value = (value === false || value === 'false') ? 'false' : 'true';
    if (field === 'frequency') value = normalizeRecurringFrequency_(value);
    setCellByRow_(sheet, headers, rowIndex, field, value);
  });
  return { done: true };
}

// One-off admin action, same spirit as adminSetCategoryPeriodType — points
// a specific historical Entry at the Recurring Expense item it actually
// represents (see entryMatchesRecurringOccurrence_'s explicit-link check,
// above). Pass recurringExpenseId: '' to unlink. Self-heals the Entries
// column here too, rather than depending on some other call having
// already gone through getRecurringExpenseRows_() first.
function adminLinkEntryToRecurring(entryId, recurringExpenseId) {
  ensureEntriesRecurringLinkColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, entryId);
  if (rowIndex === -1) throw new Error('Entry not found');
  setCellByRow_(sheet, headers, rowIndex, 'recurring_expense_id', recurringExpenseId || '');
  return { done: true };
}

// Connector words in French/Spanish/English that show up constantly in
// these entry descriptions regardless of what the entry actually is —
// filtered out so they can't drive a false "shared word" signal below.
var RECURRING_MATCH_STOPWORDS_ = {
  de: 1, du: 1, des: 1, le: 1, la: 1, les: 1, un: 1, une: 1, et: 1, en: 1,
  sur: 1, pour: 1, avec: 1, dans: 1, au: 1, aux: 1, ce: 1, cette: 1,
  tous: 1, que: 1, qui: 1, se: 1, pas: 1, plus: 1, sans: 1, the: 1, of: 1,
  and: 1, for: 1, mois: 1, mes: 1, moi: 1, me: 1, mi: 1, el: 1, los: 1,
  las: 1, por: 1, con: 1, paye: 1, payee: 1, paiement: 1, debut: 1
};

// Words of 4+ letters, accents stripped and lowercased, minus the
// stoplist above — a real (if blunt) signal that two descriptions are
// talking about the same thing ("Amazon Prime" / "Amazon Prime (paiement
// tous les 15)"), without needing anything AI/fuzzy.
function significantWords_(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(function (w) { return w.length >= 4 && !RECURRING_MATCH_STOPWORDS_[w]; });
}

// Suggests past confirmed Entries in this item's own category that might
// be its history but the day/currency/amount heuristic
// (entryMatchesRecurringOccurrence_) doesn't — and structurally can't be
// expected to — catch, e.g. logged under an old habit from before this
// was ever set up as "recurring." Deliberately not AI: a plain,
// explainable score from (a) how close the amount is, converted to PEN
// when currencies differ using the same latest-rate fallback as
// everywhere else, and (b) whether the entry's own description shares a
// real word with the recurring item's (see significantWords_). Nothing
// here gets linked automatically — this only ranks candidates for the
// owner to review in linkEntriesToRecurring, below. An entry already
// linked to some recurring item, or one the heuristic already matches
// against any active item in this category, is left out — nothing to
// fix there.
function findRecurringLinkCandidates(payload) {
  var re = getRecurringExpenseRows_().filter(function (r) { return r.id === payload.recurringExpenseId; })[0];
  if (!re) throw new Error('Recurring item not found');

  var categoryRecurring = getRecurringExpenseRows_().filter(function (r) {
    return r.category_id === re.category_id && String(r.active) !== 'false';
  });
  var allEntries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === re.category_id;
  });

  var ratesByCurrency = buildRatesByCurrency_();
  function toPenAmount_(amount, currency, dateStr) {
    if (currency === 'PEN') return amount;
    var rate = latestRateFromList_(ratesByCurrency[currency], String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }

  var todayStr = formatCalendarDate_(new Date());
  var reAmountPen = toPenAmount_(Number(re.amount), re.currency || 'PEN', todayStr);
  var reWords = significantWords_(re.description);

  var candidates = [];
  allEntries.forEach(function (e) {
    if (e.recurring_expense_id) return;

    var d = new Date(e.date + 'T00:00:00');
    var winStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - RECURRING_MATCH_DAY_WINDOW);
    var winEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + RECURRING_MATCH_DAY_WINDOW);
    var winStartStr = formatCalendarDate_(winStart), winEndStr = formatCalendarDate_(winEnd);
    var alreadyMatched = categoryRecurring.some(function (r) {
      var occ = recurringExpenseOccurrencesInRange_(r, winStartStr, winEndStr);
      return entryMatchesRecurringOccurrence_(e, r, occ);
    });
    if (alreadyMatched) return;

    var entryAmountPen = toPenAmount_(Number(e.amount), e.currency, e.date);
    if (entryAmountPen == null || reAmountPen == null) return;
    var amountScore = 1 - Math.abs(entryAmountPen - reAmountPen) / Math.max(entryAmountPen, reAmountPen, 1);
    if (amountScore < 0.6) return; // more than ~40% off — not worth surfacing

    var wordScore = significantWords_(e.description).some(function (w) { return reWords.indexOf(w) !== -1; }) ? 0.5 : 0;

    candidates.push({
      id: e.id,
      date: e.date,
      amount: Number(e.amount),
      currency: e.currency,
      description: e.description || '',
      score: amountScore + wordScore
    });
  });

  // Rounded to the nearest 0.05 before comparing — two candidates whose
  // raw scores differ by, say, 0.006 (a PEN 2 difference in amount
  // closeness) aren't meaningfully "more likely" than each other, but
  // full-precision comparison here always treated them as strictly
  // ordered, so within a whole tier of similarly-priced-but-unrelated
  // candidates (several gas fill-ups near a car insurance payment's own
  // amount, say) the list read as shuffled rather than sorted by
  // anything a person could see. Rounding first means genuinely
  // similar-confidence candidates actually tie, falling through to the
  // date tiebreaker — most recent first, since a recent entry is the one
  // most likely to be what the owner is currently trying to reconcile.
  candidates.sort(function (a, b) {
    var aTier = Math.round(a.score * 20) / 20;
    var bTier = Math.round(b.score * 20) / 20;
    if (bTier !== aTier) return bTier - aTier;
    return a.date < b.date ? 1 : -1;
  });

  return { candidates: candidates.slice(0, 60) };
}

// Applies the owner's picks from findRecurringLinkCandidates — plain
// batch version of adminLinkEntryToRecurring, used by the in-app "Link
// selected" flow rather than a scripted one-off.
function linkEntriesToRecurring(payload) {
  ensureEntriesRecurringLinkColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var entryIds = payload.entryIds || [];
  entryIds.forEach(function (entryId) {
    var rowIndex = findRowIndexById(sheet, headers, entryId);
    if (rowIndex !== -1) setCellByRow_(sheet, headers, rowIndex, 'recurring_expense_id', payload.recurringExpenseId);
  });
  return { linked: entryIds.length };
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
// year, only in its own month; a one-time ('once') item occurs exactly
// once, ever, on its own stored `date` — this naturally makes it stop
// appearing in any future period on its own, with no separate "mark as
// done" or expiry step needed once it's past. `day` is clamped to each
// month's real length (e.g. day 31 in February lands on the 28th/29th)
// rather than skipping short months entirely.
function recurringExpenseOccurrencesInRange_(re, startDate, endDate) {
  if (String(re.active) === 'false') return [];
  var start = new Date(startDate + 'T00:00:00');
  var end = new Date(endDate + 'T00:00:00');
  var day = re.day ? Number(re.day) : 1;
  var dates = [];

  if (re.frequency === 'once') {
    if (!re.date) return [];
    var onceDate = new Date(re.date + 'T00:00:00');
    if (onceDate >= start && onceDate <= end) dates.push(String(re.date));
    return dates;
  }

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

// Same ~10% tolerance the app already uses elsewhere to flag a notable
// change (an exchange rate jumping month to month) — reused here as the
// cutoff for "close enough to call this the same payment."
var RECURRING_MATCH_TOLERANCE = 0.10;
var RECURRING_MATCH_DAY_WINDOW = 5;

// Shared by listExpectedRecurringItems (below) and Projections.gs's YTD
// estimate (which needs to exclude entries already "explained by" a
// recurring item, so the same spend never counts in both the recurring
// portion and the YTD-averaged portion of a category's projection).
// occurrenceDates is that recurring item's actual billing dates within
// whatever range the caller cares about.
//
// An explicit link (entry.recurring_expense_id, see
// ensureEntriesRecurringLinkColumn_ above) always wins outright, skipping
// every heuristic check below it — set on specific historical Entries via
// admin_linkEntryToRecurring when a recurring item's day/currency/amount
// gets corrected to the owner's real, going-forward intent (a "true-up")
// and older Entries were logged under a different convention that will
// never satisfy the heuristic again. The caller has already filtered its
// own entry list to the date range being queried, so an explicitly-linked
// entry only ever gets considered by a call whose range genuinely
// contains its date — no risk of it "matching" some unrelated period.
function entryMatchesRecurringOccurrence_(entry, recurring, occurrenceDates) {
  if (entry.recurring_expense_id && entry.recurring_expense_id === recurring.id) return true;
  if (entry.category_id !== recurring.category_id || entry.currency !== (recurring.currency || 'PEN')) return false;
  var amt = Number(recurring.amount);
  if (Math.abs(Number(entry.amount) - amt) > amt * RECURRING_MATCH_TOLERANCE) return false;
  return occurrenceDates.some(function (occDate) {
    return Math.abs(daysBetweenDates_(entry.date, occDate)) <= RECURRING_MATCH_DAY_WINDOW;
  });
}

// What's expected this month, minus whatever already has a matching real
// entry — for the Entries tab's collapsed "Programmed this month" line. A
// recurring item counts as already handled if some confirmed entry this
// month shares its category and currency, lands within ~10% of its
// amount, AND falls within a few days of its actual billing date —
// category+currency+amount alone isn't enough when a category holds
// several recurring items (e.g. three under "Mobile Phone"), since an
// unrelated one of them being confirmed could otherwise falsely mark a
// completely different, not-yet-due item as already handled just for
// sharing a similar amount somewhere else in the month. Nothing actually
// links a specific Entry to a specific recurring item (there's no such
// field), so this is still a best-effort match, not a guarantee — see
// CLAUDE.md. Grouped by currency so each group can show a plain sum in
// its own currency without needing a rate just to render; a non-PEN
// group additionally carries its PEN-converted total using the same
// "latest rate at or before this month" rule as everywhere else.
function listExpectedRecurringItems() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var monthStart = year + '-' + pad2_(month) + '-01';
  var monthEnd = year + '-' + pad2_(month) + '-' + pad2_(new Date(year, month, 0).getDate());

  var categoryById = rowsById_(getAllRows('Categories'));
  var confirmedThisMonth = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.date >= monthStart && e.date <= monthEnd;
  });

  function alreadyHandled(r, occurrenceDates) {
    return confirmedThisMonth.some(function (e) { return entryMatchesRecurringOccurrence_(e, r, occurrenceDates); });
  }

  // Kept as {row, occurrenceDate} rather than just the row — a recurring
  // item can only actually occur once within a single-month range, and
  // the occurrence's own (clamped) date is what "overdue" below needs,
  // not the raw day field (a "day 31" item genuinely occurs on the 28th
  // in February, not the 31st).
  var stillExpected = [];
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false') return;
    var occurrenceDates = recurringExpenseOccurrencesInRange_(r, monthStart, monthEnd);
    if (occurrenceDates.length === 0 || alreadyHandled(r, occurrenceDates)) return;
    stillExpected.push({ row: r, occurrenceDate: occurrenceDates[0] });
  });

  var ctx = buildBudgetContext_();
  var cutoffMonth = monthEnd.substring(0, 7);
  var todayStr = formatCalendarDate_(now);
  var groupsByCurrency = {};

  stillExpected.forEach(function (entry) {
    var r = entry.row;
    var currency = r.currency || 'PEN';
    if (!groupsByCurrency[currency]) groupsByCurrency[currency] = { currency: currency, total: 0, items: [] };
    var cat = categoryById[r.category_id];
    var group = groupsByCurrency[currency];
    group.total += Number(r.amount);
    group.items.push({
      id: r.id,
      description: r.description || '',
      category_name: cat ? cat.name : '(unknown category)',
      category_icon: cat ? cat.icon : '',
      amount: Number(r.amount),
      // The occurrence's own actual (clamped) day, not the raw configured
      // one — matters for a 'once' item (which has no day/month at all)
      // and also fixes a latent mismatch for a monthly item whose day
      // (e.g. 31) got clamped to a shorter month's real last day.
      day: Number(entry.occurrenceDate.slice(8, 10)),
      overdue: entry.occurrenceDate < todayStr
    });
  });

  var groups = Object.keys(groupsByCurrency).map(function (currency) {
    var group = groupsByCurrency[currency];
    if (currency !== 'PEN') {
      var rate = latestRateAtOrBefore_(ctx, currency, cutoffMonth);
      group.totalPen = rate != null ? group.total * rate : null;
    }
    group.items.sort(function (a, b) { return a.day - b.day; });
    return group;
  });

  // PEN (the common case) first, then everything else alphabetically —
  // stable and predictable rather than whatever order object keys land in.
  groups.sort(function (a, b) {
    if (a.currency === 'PEN') return -1;
    if (b.currency === 'PEN') return 1;
    return a.currency < b.currency ? -1 : 1;
  });

  return { groups: groups };
}

function clampedCalendarDate_(year, month, day) {
  var lastDayOfMonth = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(day, lastDayOfMonth));
}

function formatCalendarDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function daysBetweenDates_(dateStrA, dateStrB) {
  var msPerDay = 24 * 60 * 60 * 1000;
  var a = new Date(dateStrA + 'T00:00:00');
  var b = new Date(dateStrB + 'T00:00:00');
  return Math.round((a.getTime() - b.getTime()) / msPerDay);
}
