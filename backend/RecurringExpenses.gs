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
  // Columns added after the sheet already held real data are appended in
  // place, one at a time (the header row is re-read after each append).
  ['date', 'start_date', 'end_date', 'variable', 'match_words', 'interval', 'interval_unit', 'trip_id'].forEach(function (col) {
    var headers = getHeaders(sheet);
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(col);
      if (col !== 'date') sheet.getRange(1, headers.length + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
    }
  });
}

function ensureRecurringSkipsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Recurring Skips')) return;
  var sheet = ss.insertSheet('Recurring Skips');
  var headers = TABLE_DEFINITIONS['Recurring Skips'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, headers.indexOf('month') + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
}

// Every consumer (Budgets chart, Projections, "Programmed this month",
// category guessing) gets its rows here, so each row carries its skipped
// months (`skip_months`) and recurringExpenseOccurrencesInRange_ — also the
// one place start/end dates are applied — needs no extra sheet reads.
function getRecurringExpenseRows_() {
  ensureRecurringExpensesSheet_();
  ensureEntriesRecurringLinkColumn_();
  ensureRecurringSkipsSheet_();
  var skipsById = {};
  getAllRows('Recurring Skips').forEach(function (s) {
    (skipsById[s.recurring_expense_id] = skipsById[s.recurring_expense_id] || []).push(String(s.month));
  });
  var rows = getAllRows('Recurring Expenses').map(function (r) {
    r.skip_months = (skipsById[r.id] || []).sort();
    return r;
  });
  // Variable-amount items get their estimate (and the amount range that
  // recognises their payments) filled in here, once, so every consumer —
  // Projections, Budgets, "Programmed this month", the category guess — just
  // reads r.amount and needs no special case.
  if (rows.some(isVariableRecurring_)) applyVariableRecurringEstimates_(rows);
  return rows;
}

// ---- Variable-amount items: electricity, gas, building fees (2026-10-19) ----
//
// A monthly bill that surely arrives but never costs the same. The item keeps a
// starting estimate in `amount` and a few `match_words` ("luz", "enel") that
// recognise its payments among the real entries of its category. From then on:
//  - its estimated amount is the AVERAGE of its last 3 recognised payments
//    (set on r.amount by applyVariableRecurringEstimates_, so every consumer
//    sees it without a special case);
//  - a real entry pays an occurrence when it has the same category and
//    currency, shares a keyword, lands inside the plausible amount range
//    (0.4x to 2.5x the median of the recent payments) and falls in the same
//    calendar month or within
//    10 days — the fixed ±10% / 5-day rule can't work for an amount that moves;
//  - because it matches like any programmed item, Projections already pulls the
//    matched payments out of the category's year-to-date average, so the same
//    bill is never counted both as Programmed and as Expected.
// Deliberately plain and explainable (no AI), per the owner's request.
var RECURRING_VARIABLE_DAY_WINDOW = 10;
// The plausible range of one payment, around the MEDIAN of the recent ones (a
// median, so one odd purchase that happens to contain the keyword — a lamp
// bought as "luz LED" — can't stretch the range until it accepts itself).
var RECURRING_VARIABLE_RANGE_LOW = 0.4;   // x the median payment
var RECURRING_VARIABLE_RANGE_HIGH = 2.5;

// Words too generic to identify a bill (on top of the connector words above).
var RECURRING_VARIABLE_STOPWORDS_ = {
  pago: 1, pagos: 1, compra: 1, compras: 1, recibo: 1, boleta: 1, factura: 1,
  yape: 1, plin: 1, transferencia: 1, payment: 1, bill: 1
};

function isVariableRecurring_(r) {
  var f = normalizeRecurringFrequency_(r.frequency);
  return String(r.variable) === 'true' && (f === 'monthly' || f === 'custom');
}

// Like significantWords_ but from 3 letters, because the bills that matter are
// called "luz" and "gas". Unique, in order of appearance.
function keywordTokens_(text) {
  var seen = {}, out = [];
  String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .forEach(function (w) {
      if (w.length < 3 || /^\d+$/.test(w) || RECURRING_MATCH_STOPWORDS_[w] || RECURRING_VARIABLE_STOPWORDS_[w] || seen[w]) return;
      seen[w] = true;
      out.push(w);
    });
  return out;
}

function tokensOverlap_(a, b) {
  return a.some(function (t) { return b.indexOf(t) !== -1; });
}

// One entry per calendar month — the one closest to the item's day — newest
// month first, at most 6.
function variablePickPerMonth_(entries, day, occDates) {
  var bestByMonth = {};
  entries.forEach(function (e) {
    var m, dist;
    if (occDates) {
      // Custom frequency: one payment per OCCURRENCE (the nearest one), the one
      // closest to it — a calendar month is the wrong bucket for "every 5 months"
      // or "every week".
      var nearest = occDates[0], best = Infinity;
      occDates.forEach(function (o) {
        var gap = Math.abs(daysBetweenDates_(e.date, o));
        if (gap < best) { best = gap; nearest = o; }
      });
      m = nearest;
      dist = best;
    } else {
      m = String(e.date).substring(0, 7);
      dist = Math.abs(Number(String(e.date).substring(8, 10)) - day);
    }
    if (!bestByMonth[m] || dist < bestByMonth[m].dist) bestByMonth[m] = { date: e.date, amount: Number(e.amount), own: e._own, dist: dist, linked: !!e._linkedHere };
  });
  return Object.keys(bestByMonth).sort().reverse().slice(0, 6).map(function (m) { return bestByMonth[m]; });
}

function medianOf_(numbers) {
  var sorted = numbers.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The item's recognised payments, newest month first (at most 6), plus the
// plausible amount range {low, high}. Entries already linked to ANOTHER
// programmed item never count; entries linked to this one always do (even
// outside the range). Two passes: the first finds the typical payment (the
// median — with the typed estimate counted as one more data point while fewer
// than 3 payments exist); the second drops entries far from it.
function variablePaymentHistory_(r, categoryEntries, todayStr, splitSumByEntry) {
  var currency = r.currency || homeCurrency_();
  var day = r.day ? Number(r.day) : 1;
  var candidates = [];
  categoryEntries.forEach(function (e) {
    if (e.currency !== currency || !(Number(e.amount) > 0) || e.date > todayStr) return;
    // No start/end-date filter on purpose: payments from before the item's
    // start date are still the best evidence of what the bill costs (which
    // OCCURRENCES count is decided elsewhere, from the start/end dates).
    var linkedHere = e.recurring_expense_id === r.id;
    if (e.recurring_expense_id && !linkedHere) return;
    if (!linkedHere && !tokensOverlap_(r.match_tokens, keywordTokens_((e.description || '') + ' ' + (e.merchant || '')))) return;
    // _own: the owner's own share of that payment (a bill paid for the whole
    // flat has most of it split off to friends).
    candidates.push({ date: e.date, amount: Number(e.amount), _own: Number(e.amount) - ((splitSumByEntry && splitSumByEntry[e.id]) || 0), _linkedHere: linkedHere });
  });
  // Custom frequency: bucket the payments by the series' own dates (extended
  // one step either side of the payments), not by calendar month.
  var occDates = null;
  if (isCustomRecurring_(r) && candidates.length) {
    var sortedDates = candidates.map(function (c) { return c.date; }).sort();
    var stepDays = customPeriodDays_(r);
    var d0 = new Date(sortedDates[0] + 'T00:00:00'), d1 = new Date(sortedDates[sortedDates.length - 1] + 'T00:00:00');
    occDates = customOccurrenceDatesRaw_(r,
      formatCalendarDate_(new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - stepDays)),
      formatCalendarDate_(new Date(d1.getFullYear(), d1.getMonth(), d1.getDate() + stepDays)));
    if (!occDates.length) occDates = null;
  }
  var firstPass = variablePickPerMonth_(candidates, day, occDates).map(function (h) { return h.amount; });
  if (firstPass.length < 3) firstPass.push(r.base_amount);
  var anchor = medianOf_(firstPass);
  var low = anchor * RECURRING_VARIABLE_RANGE_LOW, high = anchor * RECURRING_VARIABLE_RANGE_HIGH;
  var history = variablePickPerMonth_(candidates.filter(function (c) {
    return c._linkedHere || (c.amount >= low && c.amount <= high);
  }), day, occDates);
  return { history: history, low: low, high: high };
}

// Fills, on every variable row: base_amount (what was typed), amount (the
// average of the last 3 payments, or the typed estimate while there are none),
// payments_used, and the plausible range amount_low..amount_high.
function applyVariableRecurringEstimates_(rows) {
  var todayStr = formatCalendarDate_(new Date());
  var entriesByCategory = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed') return;
    (entriesByCategory[e.category_id] = entriesByCategory[e.category_id] || []).push(e);
  });
  var splitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSumByEntry[s.entry_id] = (splitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });
  var savedSplitSums = getRecurringExpenseSplitSums_();
  rows.forEach(function (r) {
    if (!isVariableRecurring_(r)) return;
    r.base_amount = Number(r.amount);
    r.match_tokens = keywordTokens_(r.match_words);
    var found = variablePaymentHistory_(r, entriesByCategory[r.category_id] || [], todayStr, splitSumByEntry);
    r.payments_used = Math.min(3, found.history.length);
    r.amount_low = found.low;
    r.amount_high = found.high;
    if (!found.history.length) return;   // no payment on record yet: keep the typed estimate
    var recent = found.history.slice(0, 3);
    var avg = recent.reduce(function (sum, h) { return sum + h.amount; }, 0) / recent.length;
    r.amount = Math.round(avg * 100) / 100;
    // The owner's own share = the average of what the owner's share of those
    // payments really was. A fixed split on a bill that changes every month
    // would be wrong (a PEN 12 share taken off a PEN 40 bill, then off a 60
    // one), so recurringOwnAmount_ prefers this once there is history.
    var anyPaymentSplit = recent.some(function (h) { return h.own < h.amount - 0.005; });
    if (anyPaymentSplit) {
      r.own_amount = Math.round(recent.reduce(function (sum, h) { return sum + h.own; }, 0) / recent.length * 100) / 100;
    } else if (savedSplitSums[r.id] > 0.005 && r.base_amount > 0) {
      // The real payments were logged unsplit, but the item itself carries a
      // split (set by hand, like the rent): keep it, as the share of the bill
      // it represented when typed, so it follows a bill that changes every month
      // instead of being dropped (reported 2026-10-19: the shared gas lost its
      // "Total" line).
      var friendsShare = Math.min(1, savedSplitSums[r.id] / r.base_amount);
      r.own_amount = Math.round(r.amount * (1 - friendsShare) * 100) / 100;
    }
  });
}

// Does this real entry pay this variable item's occurrence? (Explicit links are
// handled by the caller before this.)
function variableEntryMatchesOccurrence_(entry, r, occurrenceDates) {
  if (entry.recurring_expense_id && entry.recurring_expense_id !== r.id) return false;
  if (entry.currency !== (r.currency || homeCurrency_())) return false;
  var amt = Number(entry.amount);
  if (!(amt > 0)) return false;
  if (r.amount_low !== undefined && (amt < r.amount_low || amt > r.amount_high)) return false;
  var tokens = r.match_tokens || keywordTokens_(r.match_words);
  if (!tokensOverlap_(tokens, keywordTokens_((entry.description || '') + ' ' + (entry.merchant || '')))) return false;
  if (isCustomRecurring_(r)) {
    // Loose real date ("every 4-6 months"): anywhere within half a step of the
    // occurrence (windows of neighbouring occurrences never overlap).
    var winDays = recurringMatchWindowDays_(r);
    return occurrenceDates.some(function (occDate) {
      return Math.abs(daysBetweenDates_(entry.date, occDate)) <= winDays;
    });
  }
  var entryMonth = String(entry.date).substring(0, 7);
  return occurrenceDates.some(function (occDate) {
    return String(occDate).substring(0, 7) === entryMonth ||
      Math.abs(daysBetweenDates_(entry.date, occDate)) <= RECURRING_VARIABLE_DAY_WINDOW;
  });
}

// "Look for variable bills": scans the last 6 complete months of confirmed
// expenses for a description word that shows up roughly once a month with an
// amount that moves — the fingerprint of a utility bill — and proposes it as a
// variable programmed item. Plain counting, no AI. Entries already explained by
// a programmed item (matched or linked) are ignored, so what comes back is only
// what isn't yet accounted for. Nothing is created here: the app opens the
// normal add form pre-filled and the owner decides.
var VARIABLE_SCAN_MONTHS = 6;
var VARIABLE_SCAN_MIN_MONTHS = 4;     // present in at least this many of them
var VARIABLE_SCAN_MAX_PER_MONTH = 2;  // a bill, not a shopping habit
var VARIABLE_SCAN_MIN_SPREAD = 0.08;  // (max-min)/average below this = a fixed amount, not variable

// A variable item must be monthly and have at least one usable keyword;
// returns the cleaned pair. Not variable = the words are dropped.
function validateVariableRecurring_(variable, matchWords, frequency) {
  if (!variable) return { variable: false, match_words: '' };
  if (frequency !== 'monthly' && frequency !== 'custom') throw new Error(tr_('rec.variableMonthlyOnly'));
  var words = String(matchWords || '').trim();
  if (!keywordTokens_(words).length) throw new Error(tr_('rec.variableNeedsWords'));
  return { variable: true, match_words: words };
}

function suggestVariableRecurring() {
  var now = new Date();
  var months = [];
  for (var i = 1; i <= VARIABLE_SCAN_MONTHS; i++) {
    months.push(formatCalendarDate_(new Date(now.getFullYear(), now.getMonth() - i, 1)).substring(0, 7));
  }
  var firstMonth = months[months.length - 1], lastMonth = months[0];
  var rangeStart = firstMonth + '-01';
  var rangeEnd = lastMonth + '-' + pad2_(new Date(Number(lastMonth.substring(0, 4)), Number(lastMonth.substring(5, 7)), 0).getDate());

  var categoryById = rowsById_(getAllRows('Categories'));
  var existing = getRecurringExpenseRows_().filter(function (r) {
    return String(r.active) !== 'false' && normalizeRecurringFrequency_(r.frequency) !== 'once';
  });
  var existingOcc = existing.map(function (r) { return recurringExpenseOccurrencesInRange_(r, rangeStart, rangeEnd); });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var entrySplitSums = {};
  var splitsByEntry = {};   // entry id -> [{friend_id, amount}]: who the payment was shared with
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSums[s.entry_id] = (entrySplitSums[s.entry_id] || 0) + Number(s.amount);
    (splitsByEntry[s.entry_id] = splitsByEntry[s.entry_id] || []).push({ friend_id: s.friend_id, amount: Number(s.amount) });
  });
  var friendById = rowsById_(getAllRows('Friends'));
  function explained(e) {
    if (e.recurring_expense_id) return true;
    return existing.some(function (r, idx) {
      return r.category_id === e.category_id && existingOcc[idx].length > 0 &&
        entryMatchesRecurringOccurrence_(e, r, existingOcc[idx], entrySplitSums, recurringSplitSums);
    });
  }

  // category|currency|word -> { category_id, currency, word, byMonth: { month -> [entries] } }
  var groups = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || e.type !== 'expense' || !(Number(e.amount) > 0)) return;
    var m = String(e.date).substring(0, 7);
    if (m < firstMonth || m > lastMonth) return;
    if (!categoryById[e.category_id] || explained(e)) return;
    keywordTokens_((e.description || '') + ' ' + (e.merchant || '')).forEach(function (w) {
      var key = e.category_id + '|' + e.currency + '|' + w;
      var g = groups[key] || (groups[key] = { category_id: e.category_id, currency: e.currency, word: w, byMonth: {} });
      (g.byMonth[m] = g.byMonth[m] || []).push(e);
    });
  });

  // Words that point at exactly the same entries are one bill ("luz", "enel").
  var bySignature = {};
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    var monthKeys = Object.keys(g.byMonth);
    if (monthKeys.length < VARIABLE_SCAN_MIN_MONTHS) return;
    if (monthKeys.some(function (m) { return g.byMonth[m].length > VARIABLE_SCAN_MAX_PER_MONTH; })) return;
    var picks = monthKeys.sort().reverse().map(function (m) {
      return g.byMonth[m].slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
    });
    var amounts = picks.map(function (e) { return Number(e.amount); });
    var avgAll = amounts.reduce(function (a, b) { return a + b; }, 0) / amounts.length;
    if ((Math.max.apply(null, amounts) - Math.min.apply(null, amounts)) / avgAll < VARIABLE_SCAN_MIN_SPREAD) return;
    var ids = [];
    monthKeys.forEach(function (m) { g.byMonth[m].forEach(function (e) { ids.push(e.id); }); });
    var sig = g.category_id + '|' + g.currency + '|' + ids.sort().join(',');
    var bucket = bySignature[sig] || (bySignature[sig] = { g: g, words: [], picks: picks });
    bucket.words.push(g.word);
  });

  // Skip what an existing variable item in the same category already covers.
  var variableTokensByCategory = {};
  existing.filter(isVariableRecurring_).forEach(function (r) {
    variableTokensByCategory[r.category_id] = (variableTokensByCategory[r.category_id] || []).concat(keywordTokens_(r.match_words));
  });

  var suggestions = [];
  Object.keys(bySignature).forEach(function (sig) {
    var b = bySignature[sig];
    var cat = categoryById[b.g.category_id];
    if (tokensOverlap_(b.words, variableTokensByCategory[b.g.category_id] || [])) return;
    function dayOf(e) { return Number(String(e.date).substring(8, 10)); }
    var days = b.picks.map(dayOf).sort(function (x, y) { return x - y; });
    var typicalDay = days[Math.floor(days.length / 2)];
    // Per month, the entry closest to the typical day — the same choice the
    // item makes once it exists (variablePickPerMonth_), so the proposed
    // estimate is the one the item will actually show.
    var picks = Object.keys(b.g.byMonth).sort().reverse().map(function (m) {
      return b.g.byMonth[m].slice().sort(function (x, y) { return Math.abs(dayOf(x) - typicalDay) - Math.abs(dayOf(y) - typicalDay); })[0];
    });
    var latest = picks[0];
    // Words in the order they appear in the latest description, at most 3.
    var ordered = keywordTokens_((latest.description || '') + ' ' + (latest.merchant || ''))
      .filter(function (w) { return b.words.indexOf(w) !== -1; }).slice(0, 3);
    var recent = picks.slice(0, 3);
    var avg = recent.reduce(function (sum, e) { return sum + Number(e.amount); }, 0) / recent.length;
    var amounts = picks.map(function (e) { return Number(e.amount); });
    // Shared? A bill the owner pays for the whole flat has most of it split off
    // to friends on the real entries. "Shared" = most of the recent payments
    // were; who with, and how much, come from the newest shared one. The
    // owner's own share is what the programmed item will count (the full bill
    // stays visible as the total).
    function ownOf(e) { return Number(e.amount) - (entrySplitSums[e.id] || 0); }
    var sharedRecent = recent.filter(function (e) { return (entrySplitSums[e.id] || 0) > 0.005; });
    var isShared = sharedRecent.length * 2 > recent.length;
    var ownAvg = recent.reduce(function (sum, e) { return sum + ownOf(e); }, 0) / recent.length;
    suggestions.push({
      shared: isShared,
      own_avg_amount: Math.round(ownAvg * 100) / 100,
      split: isShared ? (splitsByEntry[sharedRecent[0].id] || []).map(function (s) {
        var f = friendById[s.friend_id];
        return { friend_id: s.friend_id, name: f ? f.name : '', amount: s.amount };
      }) : [],
      key: b.g.category_id + '|' + ordered.join(' '),
      category_id: b.g.category_id,
      category_name: categoryLabel_(cat),
      category_icon: cat.icon || '',
      match_words: ordered.join(' '),
      description: latest.description || ordered.join(' '),
      currency: b.g.currency,
      months_seen: picks.length,
      avg_amount: Math.round(avg * 100) / 100,
      min_amount: Math.min.apply(null, amounts),
      max_amount: Math.max.apply(null, amounts),
      typical_day: typicalDay,
      recent: recent.map(function (e) { return { date: e.date, amount: Number(e.amount) }; })
    });
  });
  suggestions.sort(function (a, b) {
    return b.months_seen - a.months_seen || b.avg_amount - a.avg_amount;
  });
  return { suggestions: suggestions.slice(0, 20) };
}

var RECURRING_DATE_RE_ =/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Optional start/end dates: blank is fine; otherwise real dates, end not
// before start. Returns the cleaned pair.
function validateRecurringWindow_(startDate, endDate) {
  startDate = startDate ? String(startDate).trim() : '';
  endDate = endDate ? String(endDate).trim() : '';
  if (startDate && !RECURRING_DATE_RE_.test(startDate)) throw new Error(tr_('rec.startDate'));
  if (endDate && !RECURRING_DATE_RE_.test(endDate)) throw new Error(tr_('rec.endDate'));
  if (startDate && endDate && endDate < startDate) throw new Error(tr_('rec.endBeforeStart'));
  return { start_date: startDate, end_date: endDate };
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

// Self-heals like every other post-hoc table (Payors, Loan Alert Log,
// etc.) — added well after Recurring Expenses already held real data.
function ensureRecurringExpenseSplitsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Recurring Expense Splits')) return;
  var sheet = ss.insertSheet('Recurring Expense Splits');
  var headers = TABLE_DEFINITIONS['Recurring Expense Splits'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function getRecurringExpenseSplits(payload) {
  ensureRecurringExpenseSplitsSheet_();
  return getAllRows('Recurring Expense Splits')
    .filter(function (s) { return s.recurring_expense_id === payload.recurringExpenseId; })
    .map(function (s) { return { friend_id: s.friend_id, amount: Number(s.amount) }; });
}

// Replaces this item's whole split set with the new one — same
// recalculate-from-scratch approach saveEntrySplits uses, so editing a
// split never leaves a stale row behind. Unlike saveEntrySplits, this
// never touches Loans — a programmed item's split only feeds Projections
// math (see the "Recurring Expense Splits" note in Setup.gs); the real
// loan only ever gets created when the actual transaction is confirmed
// and split, same as any other expense.
function saveRecurringExpenseSplits(payload) {
  ensureRecurringExpenseSplitsSheet_();
  var recurringExpenseId = payload.recurringExpenseId;
  deleteRowsWhere_('Recurring Expense Splits', function (row) {
    return row.recurring_expense_id === recurringExpenseId;
  });

  var splits = (payload.splits || []).filter(function (s) { return s.friend_id && Number(s.amount) > 0; });
  if (splits.length) {
    splits.forEach(function (s) {
      appendRowObject('Recurring Expense Splits', { id: Utilities.getUuid(), recurring_expense_id: recurringExpenseId, friend_id: s.friend_id, amount: Number(s.amount) });
    });
  }
  return { splits: splits };
}

// id -> total split off to friends, for every recurring item that has
// any — read once and reused across listRecurringExpenses/Projections/
// Budgets/listExpectedRecurringItems rather than re-reading the sheet in
// each one.
function getRecurringExpenseSplitSums_() {
  ensureRecurringExpenseSplitsSheet_();
  var sums = {};
  getAllRows('Recurring Expense Splits').forEach(function (s) {
    sums[s.recurring_expense_id] = (sums[s.recurring_expense_id] || 0) + Number(s.amount);
  });
  return sums;
}

// What this item actually costs the owner — its own amount minus
// whatever's been split off to a friend (own_share, same idea as a real
// expense's own_share; see CLAUDE.md). This is what every consumer of a
// recurring item's amount (Projections, the Budgets pacing chart,
// "Programmed this month") should multiply occurrences by — the item's
// raw `amount` field stays the true full cost, same reasoning as an
// Entry's own `amount` staying the full disbursement.
function recurringOwnAmount_(r, splitSums) {
  // A variable item with payment history knows the owner's real share
  // (applyVariableRecurringEstimates_); a fixed split would not follow a bill
  // that changes every month.
  if (r.own_amount !== undefined) return Number(r.own_amount);
  return Number(r.amount) - ((splitSums && splitSums[r.id]) || 0);
}

function listRecurringExpenses() {
  var categoryById = rowsById_(getAllRows('Categories'));
  var splitSums = getRecurringExpenseSplitSums_();
  return getRecurringExpenseRows_().map(function (r) {
    return recurringExpenseForClient_(r, categoryById, splitSums);
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
  if (freq === 'custom') return 'custom';
  return 'monthly';
}

// ---- Frequency "Other": every N days / weeks / months / years (2026-10-19) ----
//
// `frequency = 'custom'` with `interval` (N, a whole number) and
// `interval_unit` (days | weeks | months | years). Every date is counted from
// `start_date`, which is therefore required for these items (it is the
// anchor — for something that already happened, e.g. the last car service,
// use that date; the next one follows from it). Days/weeks are exact steps.
// Months/years keep the anchor's day and clamp it in shorter months, like a
// monthly item does (31st + every 2 months = Jan 31, Mar 31, May 31…).
var RECURRING_CUSTOM_UNITS_ = { days: 1, weeks: 1, months: 1, years: 1 };

function isCustomRecurring_(r) {
  return normalizeRecurringFrequency_(r.frequency) === 'custom';
}

function customIntervalOf_(r) {
  var n = Math.max(1, Math.floor(Number(r.interval) || 1));
  var unit = RECURRING_CUSTOM_UNITS_[r.interval_unit] ? r.interval_unit : 'months';
  return { n: n, unit: unit };
}

// Roughly how many days one step is (used to size match windows).
function customPeriodDays_(r) {
  var iv = customIntervalOf_(r);
  if (iv.unit === 'days') return iv.n;
  if (iv.unit === 'weeks') return iv.n * 7;
  if (iv.unit === 'months') return Math.round(iv.n * 30.44);
  return Math.round(iv.n * 365.25);
}

// Validated pair for a custom item; throws a readable error otherwise.
function validateCustomRecurring_(interval, unit, startDate) {
  var n = parseInt(interval, 10);
  if (!(n >= 1 && n <= 999) || String(parseInt(interval, 10)) !== String(interval).trim()) throw new Error(tr_('rec.customInterval'));
  if (!RECURRING_CUSTOM_UNITS_[unit]) throw new Error(tr_('rec.customUnit'));
  if (!startDate) throw new Error(tr_('rec.customNeedsStart'));
  return { interval: n, interval_unit: unit };
}

// Every date of the series inside [startDate, endDate], INCLUDING dates before
// the anchor (the series continues backwards: past payments of a recurring
// service are matched against it). The start/end-date filter of the item is
// applied by recurringExpenseOccurrencesInRange_, not here.
function customOccurrenceDatesRaw_(r, startDate, endDate) {
  var anchorStr = r.start_date ? String(r.start_date) : '';
  if (!anchorStr) return [];
  var iv = customIntervalOf_(r);
  var a = new Date(anchorStr + 'T00:00:00');
  var start = new Date(startDate + 'T00:00:00'), end = new Date(endDate + 'T00:00:00');
  var out = [];
  var guard = 0;
  if (iv.unit === 'days' || iv.unit === 'weeks') {
    var stepDays = iv.n * (iv.unit === 'weeks' ? 7 : 1);
    var diff = Math.round((start.getTime() - a.getTime()) / 86400000);
    for (var k = Math.floor(diff / stepDays); guard++ < 5000; k++) {
      var d = new Date(a.getFullYear(), a.getMonth(), a.getDate() + k * stepDays);
      if (d > end) break;
      if (d >= start) out.push(formatCalendarDate_(d));
    }
    return out;
  }
  var stepMonths = iv.n * (iv.unit === 'years' ? 12 : 1);
  var monthDiff = (start.getFullYear() - a.getFullYear()) * 12 + (start.getMonth() - a.getMonth());
  for (var j = Math.floor(monthDiff / stepMonths) - 1; guard++ < 5000; j++) {
    var total = a.getMonth() + j * stepMonths;
    var y = a.getFullYear() + Math.floor(total / 12);
    var m = ((total % 12) + 12) % 12;
    var d2 = clampedCalendarDate_(y, m + 1, a.getDate());
    if (d2 > end) break;
    if (d2 >= start) out.push(formatCalendarDate_(d2));
  }
  return out;
}

// Days around an occurrence within which a real entry counts as its payment.
// A fixed monthly/yearly item: 5 (the long-standing rule). A custom item never
// lets two neighbouring occurrences claim the same entry, so its window is at
// most half a step; a variable one ("approximately every 4-6 months", like a
// car service) uses that whole half-step because the real date is loose.
function recurringMatchWindowDays_(r) {
  if (!isCustomRecurring_(r)) return RECURRING_MATCH_DAY_WINDOW;
  var half = Math.max(0, Math.ceil(customPeriodDays_(r) / 2) - 1);
  return isVariableRecurring_(r) ? half : Math.min(RECURRING_MATCH_DAY_WINDOW, half);
}

function recurringExpenseForClient_(r, categoryById, splitSums) {
  var cat = categoryById[r.category_id];
  var frequency = normalizeRecurringFrequency_(r.frequency);
  // split_total: what's been split off to a friend (0 for the common
  // unsplit case). The frontend uses amount - split_total as this item's
  // own "big number" in the list, same "big = my share, small = total"
  // treatment a split real expense already gets (see CLAUDE.md).
  var splitTotal = (splitSums && splitSums[r.id]) || 0;
  // A variable item with history: what is split off is whatever the owner's
  // real share of its recent payments says (see recurringOwnAmount_).
  if (r.own_amount !== undefined) splitTotal = Math.max(0, Number(r.amount) - Number(r.own_amount));
  return {
    id: r.id,
    category_id: r.category_id,
    category_name: cat ? categoryLabel_(cat) : tr_('label.unknownCategory'),
    category_icon: cat ? cat.icon : '',
    category_color: cat ? cat.color : '',
    category_type: cat ? cat.type : 'expense',
    description: r.description || '',
    amount: Number(r.amount),
    currency: r.currency || homeCurrency_(),
    frequency: frequency,
    interval: frequency === 'custom' ? customIntervalOf_(r).n : null,
    interval_unit: frequency === 'custom' ? customIntervalOf_(r).unit : '',
    day: r.day ? Number(r.day) : 1,
    month: r.month ? Number(r.month) : 1,
    date: r.date || '',
    active: String(r.active) !== 'false',
    start_date: r.start_date || '',
    end_date: r.end_date || '',
    skipped_months: (r.skip_months || []).slice(),
    split_total: splitTotal,
    // Variable-amount item (see the block near the top): `amount` above is then
    // the current estimate; `base_amount` is what the owner typed.
    variable: isVariableRecurring_(r),
    match_words: r.match_words ? String(r.match_words) : '',
    base_amount: r.base_amount !== undefined ? r.base_amount : Number(r.amount),
    payments_used: r.payments_used || 0,
    amount_low: r.amount_low !== undefined ? Math.round(r.amount_low * 100) / 100 : null,
    amount_high: r.amount_high !== undefined ? Math.round(r.amount_high * 100) / 100 : null,
    trip_id: r.trip_id ? String(r.trip_id) : ''   // a one-time item counted as an estimate in this trip/event (Trips.gs)
  };
}

function addRecurringExpense(payload) {
  ensureRecurringExpensesSheet_();
  var frequency = normalizeRecurringFrequency_(payload.frequency);
  var windowDates = frequency === 'once' ? { start_date: '', end_date: '' } : validateRecurringWindow_(payload.start_date, payload.end_date);
  var variable = validateVariableRecurring_(!!payload.variable, payload.match_words, frequency);
  var custom = frequency === 'custom'
    ? validateCustomRecurring_(payload.interval, payload.interval_unit, windowDates.start_date)
    : { interval: '', interval_unit: '' };
  // A custom item's day/month come from its start date (the anchor).
  var startDay = frequency === 'custom' ? Number(windowDates.start_date.substring(8, 10)) : null;
  var startMonth = frequency === 'custom' ? Number(windowDates.start_date.substring(5, 7)) : null;
  var re = {
    id: Utilities.getUuid(),
    category_id: payload.category_id,
    description: payload.description ? String(payload.description).trim() : '',
    amount: payload.amount,
    currency: payload.currency || homeCurrency_(),
    frequency: frequency,
    interval: custom.interval,
    interval_unit: custom.interval_unit,
    day: frequency === 'once' ? '' : (startDay || payload.day || 1),
    month: frequency === 'once' ? '' : (startMonth || payload.month || 1),
    date: frequency === 'once' ? (payload.date || '') : '',
    active: payload.active === false ? 'false' : 'true',
    start_date: windowDates.start_date,
    end_date: windowDates.end_date,
    variable: variable.variable ? 'true' : 'false',
    match_words: variable.match_words,
    trip_id: frequency === 'once' ? tripIdForProgrammed_(payload.trip_id, payload.category_id) : ''
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
  if (rowIndex === -1) throw new Error(tr_('err.recurringNotFound'));

  headers = getHeaders(sheet);   // the ensure above may have just added the date columns
  if (payload.start_date !== undefined || payload.end_date !== undefined) {
    var current = getAllRows('Recurring Expenses').find(function (r) { return r.id === payload.id; });
    var cleaned = validateRecurringWindow_(
      payload.start_date !== undefined ? payload.start_date : current.start_date,
      payload.end_date !== undefined ? payload.end_date : current.end_date
    );
    if (payload.start_date !== undefined) payload.start_date = cleaned.start_date;
    if (payload.end_date !== undefined) payload.end_date = cleaned.end_date;
  }

  // Variable-amount settings are checked against the item as it will be AFTER
  // this update (a yearly item can't be variable; a variable one needs words).
  if (payload.variable !== undefined || payload.match_words !== undefined || payload.frequency !== undefined) {
    var cur = getAllRows('Recurring Expenses').find(function (r) { return r.id === payload.id; });
    var checked = validateVariableRecurring_(
      payload.variable !== undefined ? !!payload.variable : String(cur.variable) === 'true',
      payload.match_words !== undefined ? payload.match_words : cur.match_words,
      normalizeRecurringFrequency_(payload.frequency !== undefined ? payload.frequency : cur.frequency)
    );
    payload.variable = checked.variable;
    payload.match_words = checked.match_words;
  }

  // A custom item needs its interval, unit and start date (the anchor).
  if (payload.frequency !== undefined || payload.interval !== undefined || payload.interval_unit !== undefined || payload.start_date !== undefined) {
    var row = getAllRows('Recurring Expenses').find(function (r) { return r.id === payload.id; });
    var mergedFreq = normalizeRecurringFrequency_(payload.frequency !== undefined ? payload.frequency : row.frequency);
    if (mergedFreq === 'custom') {
      var mergedStart = payload.start_date !== undefined ? payload.start_date : row.start_date;
      var c = validateCustomRecurring_(
        payload.interval !== undefined ? payload.interval : row.interval,
        payload.interval_unit !== undefined ? payload.interval_unit : row.interval_unit,
        mergedStart
      );
      payload.interval = c.interval;
      payload.interval_unit = c.interval_unit;
      if (mergedStart) {   // day/month follow the anchor
        payload.day = Number(String(mergedStart).substring(8, 10));
        payload.month = Number(String(mergedStart).substring(5, 7));
      }
    } else if (payload.frequency !== undefined) {
      payload.interval = '';
      payload.interval_unit = '';
    }
  }

  // Only a one-time EXPENSE item can sit inside a trip or event: anything else drops the link.
  if (payload.trip_id !== undefined || payload.frequency !== undefined || payload.category_id !== undefined) {
    var tripRow = getAllRows('Recurring Expenses').find(function (r) { return r.id === payload.id; });
    var tripFreq = normalizeRecurringFrequency_(payload.frequency !== undefined ? payload.frequency : tripRow.frequency);
    payload.trip_id = tripFreq === 'once'
      ? tripIdForProgrammed_(payload.trip_id !== undefined ? payload.trip_id : tripRow.trip_id, payload.category_id !== undefined ? payload.category_id : tripRow.category_id)
      : '';
  }

  ['category_id', 'description', 'amount', 'currency', 'frequency', 'interval', 'interval_unit', 'day', 'month', 'date', 'active', 'start_date', 'end_date', 'variable', 'match_words', 'trip_id'].forEach(function (field) {
    if (payload[field] === undefined) return;
    var value = payload[field];
    if (field === 'variable') value = value ? 'true' : 'false';
    if (field === 'match_words') value = String(value || '').trim();
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
  if (rowIndex === -1) throw new Error(tr_('err.entryNotFound'));
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
  if (!re) throw new Error(tr_('err.recurringItemNotFound'));

  var categoryRecurring = getRecurringExpenseRows_().filter(function (r) {
    return r.category_id === re.category_id && String(r.active) !== 'false';
  });
  var allEntries = getAllRows('Entries').filter(function (e) {
    return e.status === 'confirmed' && e.category_id === re.category_id;
  });
  var recurringSplitSums = getRecurringExpenseSplitSums_();
  var entrySplitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSumByEntry[s.entry_id] = (entrySplitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  var ratesByCurrency = buildRatesByCurrency_();
  function toPenAmount_(amount, currency, dateStr) {
    if (currency === homeCurrency_()) return amount;
    var rate = rateToMain_(ratesByCurrency, currency, String(dateStr).substring(0, 7));
    return rate != null ? amount * rate : null;
  }

  var todayStr = formatCalendarDate_(new Date());
  var reAmountPen = toPenAmount_(Number(re.amount), re.currency || homeCurrency_(), todayStr);
  // The item's OWN share (a rent split three ways: the full USD 800 and the
  // owner's USD 266). An old entry may hold only his share and a new one the
  // full payment with splits, so each pair is compared like with like.
  var reOwnPen = toPenAmount_(recurringOwnAmount_(re, recurringSplitSums), re.currency || homeCurrency_(), todayStr);
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
      return entryMatchesRecurringOccurrence_(e, r, occ, entrySplitSumByEntry, recurringSplitSums);
    });
    if (alreadyMatched) return;

    var entryAmountPen = toPenAmount_(Number(e.amount), e.currency, e.date);
    var entryOwnPen = toPenAmount_(Number(e.amount) - (entrySplitSumByEntry[e.id] || 0), e.currency, e.date);
    if (entryAmountPen == null || reAmountPen == null) return;
    // Closest of: full amount vs full amount, own share vs own share.
    var amountScore = 1 - Math.abs(entryAmountPen - reAmountPen) / Math.max(entryAmountPen, reAmountPen, 1);
    if (entryOwnPen != null && reOwnPen != null) {
      amountScore = Math.max(amountScore, 1 - Math.abs(entryOwnPen - reOwnPen) / Math.max(entryOwnPen, reOwnPen, 1));
    }
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
  ensureRecurringExpenseSplitsSheet_();
  deleteRowsWhere_('Recurring Expense Splits', function (row) { return row.recurring_expense_id === id; });
  ensureRecurringSkipsSheet_();
  deleteRowsWhere_('Recurring Skips', function (row) { return row.recurring_expense_id === id; });
  return { done: true };
}

// ---- Skipping one occurrence / marking an entry as the payment ----

function assertRecurringMonth_(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw new Error(tr_('err.monthFormat'));
}

function assertRecurringExists_(id) {
  ensureRecurringExpensesSheet_();
  if (!getAllRows('Recurring Expenses').some(function (r) { return r.id === id; })) {
    throw new Error(tr_('err.recurringNotFound'));
  }
}

// "This month's rent is waived / the trip was cancelled": that one
// occurrence stops counting as expected (Programmed this month, Budgets,
// Projections) without touching the item or its other months. Idempotent.
function skipRecurringOccurrence(payload) {
  assertRecurringMonth_(payload.month);
  assertRecurringExists_(payload.id);
  ensureRecurringSkipsSheet_();
  var already = getAllRows('Recurring Skips').some(function (s) {
    return s.recurring_expense_id === payload.id && String(s.month) === payload.month;
  });
  if (!already) appendRowObject('Recurring Skips', { id: Utilities.getUuid(), recurring_expense_id: payload.id, month: payload.month });
  return { done: true };
}

function unskipRecurringOccurrence(payload) {
  assertRecurringMonth_(payload.month);
  ensureRecurringSkipsSheet_();
  deleteRowsWhere_('Recurring Skips', function (s) {
    return s.recurring_expense_id === payload.id && String(s.month) === payload.month;
  });
  return { done: true };
}

// Manual override for the rare case automatic matching (same category and
// currency, ~10% amount, within 5 days) misses a real payment: point one
// entry at the item it paid ('' to unlink). Automatic matching stays on.
function linkEntryToRecurring(payload) {
  if (payload.recurringExpenseId) assertRecurringExists_(payload.recurringExpenseId);
  var result = adminLinkEntryToRecurring(payload.entryId, payload.recurringExpenseId);
  // The owner just said this entry IS the payment for an estimate that sits in a
  // trip/event: the payment joins that trip too (unless it already has one).
  if (payload.recurringExpenseId) {
    var item = getAllRows('Recurring Expenses').find(function (r) { return r.id === payload.recurringExpenseId; });
    var entry = getEntryById_(payload.entryId);
    if (item && item.trip_id && entry && entry.type === 'expense' && !entry.trip_id && validTripIdOrBlank_(item.trip_id)) {
      ensureEntriesTripColumn_();
      setEntryField_(payload.entryId, 'trip_id', String(item.trip_id));
    }
  }
  return result;
}

// The picker for "Mark as paid": EVERY confirmed entry of the item's own kind
// (income vs expense) in this calendar month, in any currency, plus the last
// two days of the previous month when the item falls on the 1st/2nd. The 10
// most similar come first (is_top), then all the rest by date.
function listEntriesForRecurringMonth(payload) {
  assertRecurringMonth_(payload.month);
  var re = getRecurringExpenseRows_().find(function (r) { return r.id === payload.id; });
  if (!re) throw new Error(tr_('err.recurringNotFound'));
  var categoryById = rowsById_(getAllRows('Categories'));
  var cat = categoryById[re.category_id];
  var type = cat ? cat.type : 'expense';
  var y = Number(payload.month.substring(0, 4)), m = Number(payload.month.substring(5, 7));
  var monthStart = payload.month + '-01';
  var monthEnd = payload.month + '-' + pad2_(new Date(y, m, 0).getDate());
  // The item's billing date this month (a yearly item in another month has
  // none: fall back to its day, clamped, so ranking still has a date).
  var occ = recurringExpenseOccurrencesInRange_(re, monthStart, monthEnd)[0] ||
    formatCalendarDate_(clampedCalendarDate_(y, m, re.day ? Number(re.day) : 1));
  var win = matchPickerWindow_(occ);
  var entrySplitSums = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSums[s.entry_id] = (entrySplitSums[s.entry_id] || 0) + Number(s.amount);
  });
  var candidates = getAllRows('Entries')
    .filter(function (e) {
      return e.status === 'confirmed' && e.type === type && e.date >= win.lo && e.date <= win.hi;
    })
    .map(function (e) {
      return {
        id: e.id, date: e.date, amount: Number(e.amount), currency: e.currency,
        own_amount: Number(e.amount) - (entrySplitSums[e.id] || 0),
        description: e.description || '', category_name: categoryById[e.category_id] ? categoryLabel_(categoryById[e.category_id]) : '',
        linked_here: e.recurring_expense_id === re.id
      };
    });
  var ordered = orderMatchCandidates_(candidates, {
    amount: Number(re.amount), own_amount: recurringOwnAmount_(re, getRecurringExpenseSplitSums_()),
    currency: re.currency || homeCurrency_(), date: occ, description: re.description
  });
  ordered.forEach(function (c) { delete c.own_amount; });   // only used for ranking
  return ordered;
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
  var dates = recurringExpenseOccurrencesRaw_(re, startDate, endDate);
  if (re.frequency === 'once') return dates;
  // Optional start/end dates and skipped months (monthly/yearly only; a
  // one-time item is already a single dated payment).
  var skipped = re.skip_months || [];
  return dates.filter(function (d) {
    if (re.start_date && d < re.start_date) return false;
    if (re.end_date && d > re.end_date) return false;
    return skipped.indexOf(d.substring(0, 7)) === -1;
  });
}

function recurringExpenseOccurrencesRaw_(re, startDate, endDate) {
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

  if (re.frequency === 'custom') return customOccurrenceDatesRaw_(re, startDate, endDate);

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

// An amount in PEN using the latest rate on file at or before the date's
// month (the app-wide rule); null when that currency has no rate at all.
function amountInPen_(amount, currency, dateStr) {
  var rate = getLatestRateOnOrBefore_(currency || homeCurrency_(), String(dateStr).substring(0, 7));
  return rate == null ? null : Number(amount) * rate;
}

// Do two amounts in possibly different currencies agree within
// RECURRING_MATCH_TOLERANCE? Used by the category guess, which doesn't go
// through entryMatchesRecurringOccurrence_.
function amountsCloseAcrossCurrencies_(amountA, currencyA, amountB, currencyB, dateStr) {
  if (currencyA === currencyB) return Math.abs(amountA - amountB) <= amountB * RECURRING_MATCH_TOLERANCE;
  var a = amountInPen_(amountA, currencyA, dateStr), b = amountInPen_(amountB, currencyB, dateStr);
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= b * RECURRING_MATCH_TOLERANCE;
}

// The span a "match this to an existing entry" picker shows: the WHOLE
// calendar month of dateStr, plus the last two days of the previous month
// when dateStr falls on the 1st or 2nd (a charge dated the 1st is often
// entered on the 30th/31st). Returns { lo, hi } as YYYY-MM-DD.
function matchPickerWindow_(dateStr) {
  var y = Number(String(dateStr).substring(0, 4)), m = Number(String(dateStr).substring(5, 7));
  var day = Number(String(dateStr).substring(8, 10));
  return {
    lo: day <= 2 ? formatCalendarDate_(new Date(y, m - 1, -1)) : y + '-' + pad2_(m) + '-01',
    hi: y + '-' + pad2_(m) + '-' + pad2_(new Date(y, m, 0).getDate())
  };
}

// Orders match-picker candidates: the 10 most similar first (is_top), then
// every other candidate by date, newest first. Similarity is plain and
// explainable: amount closeness in PEN (so a USD charge can match a PEN
// item), a shared real word in the descriptions, and nearness in days.
// candidates: [{date, amount, currency, description, ...}];
// target: {amount, currency, date, description}.
function orderMatchCandidates_(candidates, target) {
  var targetWords = significantWords_(target.description);
  var targetAbs = Math.abs(Number(target.amount));
  candidates.forEach(function (c) {
    var cAmt = amountInPen_(Math.abs(Number(c.amount)), c.currency, c.date);
    var tAmt = amountInPen_(targetAbs, target.currency, c.date);
    var amountScore = cAmt == null || tAmt == null ? 0 : Math.max(0, 1 - Math.abs(cAmt - tAmt) / Math.max(cAmt, tAmt, 1));
    // Also own share vs own share (a shared item vs an entry that holds only the owner's part).
    if (c.own_amount !== undefined && target.own_amount !== undefined) {
      var cOwn = amountInPen_(Math.abs(Number(c.own_amount)), c.currency, c.date);
      var tOwn = amountInPen_(Math.abs(Number(target.own_amount)), target.currency, c.date);
      if (cOwn != null && tOwn != null) amountScore = Math.max(amountScore, Math.max(0, 1 - Math.abs(cOwn - tOwn) / Math.max(cOwn, tOwn, 1)));
    }
    var wordScore = significantWords_(c.description).some(function (w) { return targetWords.indexOf(w) !== -1; }) ? 0.5 : 0;
    var days = Math.abs(daysBetweenDates_(c.date, target.date));
    c._days = days;
    c._score = amountScore + wordScore + 0.3 * Math.max(0, 1 - days / 10);
    c.is_top = false;
  });
  var ranked = candidates.slice().sort(function (a, b) {
    return b._score - a._score || a._days - b._days || (a.date < b.date ? 1 : -1);
  });
  var top = ranked.slice(0, 10);
  top.forEach(function (c) { c.is_top = true; });
  var rest = ranked.slice(10).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  return top.concat(rest).map(function (c) { delete c._score; delete c._days; return c; });
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
// ensureEntriesRecurringLinkColumn_ above) skips the currency/amount/
// day-window heuristic below, but still only counts for an occurrence in
// the SAME CALENDAR MONTH as the entry's own date — set on specific
// historical Entries via admin_linkEntryToRecurring when a recurring
// item's day/currency/amount gets corrected to the owner's real,
// going-forward intent (a "true-up") and older Entries were logged under
// a different convention that will never satisfy the heuristic again.
// **Bug fixed 2026-09-16:** this used to match unconditionally regardless
// of occurrenceDates at all — harmless for callers that only ever ask
// "is this ENTRY explained by something" (matchedEntryIds-style,
// per-entry, month-scoped ranges), but a real bug for callers that ask
// "is THIS OCCURRENCE handled" one occurrence at a time across a wider
// range (programmedRemainingPen/computeCategoryProgrammedBreakdown_,
// added the same day) — a single Jan-linked entry was satisfying every
// other month's occurrence too, since nothing checked WHICH occurrence
// the link was actually for. Caught live: a year view showed PEN 0
// Programmed remaining for Car insurance despite three genuinely unpaid
// months (Oct–Dec) still ahead, because one earlier linked entry
// "explained" all twelve. Month-matching keeps the original tolerance
// for a linked entry logged on a different DAY than its occurrence
// (that's the whole point of the link) while stopping it from reaching
// into unrelated months.
//
// entrySplitSums (entry_id -> split total) and recurringSplitSums
// (recurring_expense_id -> split total) are both optional maps — pass
// them (built once by the caller, see recurringOwnAmount_ and
// getRecurringExpenseSplitSums_) so the amount check below compares each
// side's OWN share, not the full disbursement/config, since that's what
// a recurring item's `amount` is actually meant to represent when either
// side is genuinely shared (fixed 2026-09-22: a rent split three ways
// with friends never matched its own recurring item — the item was
// configured as the owner's own ~266 USD share, exactly as intended, but
// the heuristic was comparing it against the real entry's FULL 800 USD
// bill instead of that entry's own 266 USD share, a >100% "difference"
// far outside the 10% tolerance). Omitting either map falls back to the
// full amount on that side, same as before this fix — safe for any
// caller not yet passing one, just without the fix.
function entryMatchesRecurringOccurrence_(entry, recurring, occurrenceDates, entrySplitSums, recurringSplitSums) {
  if (entry.recurring_expense_id && entry.recurring_expense_id === recurring.id) {
    // A custom item (weekly, every 5 months…) can have several occurrences in a
    // month or a long gap between them: a link counts for the occurrence
    // within its window, not for "the same calendar month".
    if (isCustomRecurring_(recurring)) {
      var linkWindow = Math.max(recurringMatchWindowDays_(recurring), Math.min(10, Math.floor(customPeriodDays_(recurring) / 2)));
      return occurrenceDates.some(function (occDate) { return Math.abs(daysBetweenDates_(entry.date, occDate)) <= linkWindow; });
    }
    var entryMonth = String(entry.date).substring(0, 7);
    return occurrenceDates.some(function (occDate) { return String(occDate).substring(0, 7) === entryMonth; });
  }
  if (entry.category_id !== recurring.category_id) return false;
  if (isVariableRecurring_(recurring)) return variableEntryMatchesOccurrence_(entry, recurring, occurrenceDates);
  var recCurrency = recurring.currency || homeCurrency_();
  var amt = recurringOwnAmount_(recurring, recurringSplitSums);
  var entryAmt = Number(entry.amount) - ((entrySplitSums && entrySplitSums[entry.id]) || 0);
  if (entry.currency !== recCurrency) {
    // Different currency (e.g. a PEN 12.90 subscription the bank charges in
    // USD): compare both in PEN using the entry's month's rate. No rate on
    // file for either currency = no match (never guess).
    var entryPen = amountInPen_(entryAmt, entry.currency, entry.date);
    var recPen = amountInPen_(amt, recCurrency, entry.date);
    if (entryPen == null || recPen == null) return false;
    entryAmt = entryPen;
    amt = recPen;
  }
  if (Math.abs(entryAmt - amt) > amt * RECURRING_MATCH_TOLERANCE) return false;
  var winDays = recurringMatchWindowDays_(recurring);
  return occurrenceDates.some(function (occDate) {
    return Math.abs(daysBetweenDates_(entry.date, occDate)) <= winDays;
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
// CLAUDE.md. Grouped by type (income vs. expense — Recurring Expenses'
// own category picker never offers investment/transfer, see CLAUDE.md)
// AND currency, so each group can show a plain sum in its own currency
// without needing a rate just to render; a non-PEN group additionally
// carries its PEN-converted total using the same "latest rate at or
// before this month" rule as everywhere else. Income groups are kept
// separate from expense groups (2026-09-22) rather than netted or mixed
// together, matching the same income/expense distinction Projections and
// the Entries list already make.
function listExpectedRecurringItems() {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var monthStart = year + '-' + pad2_(month) + '-01';
  var monthEnd = year + '-' + pad2_(month) + '-' + pad2_(new Date(year, month, 0).getDate());

  var categoryById = rowsById_(getAllRows('Categories'));
  // Confirmed entries of ANY date, by category: a custom item's window can
  // reach well outside this month (a car service paid six weeks early), and a
  // monthly item's 5-day window can cross a month edge.
  var confirmedByCategory = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed') return;
    (confirmedByCategory[e.category_id] = confirmedByCategory[e.category_id] || []).push(e);
  });
  var splitSums = getRecurringExpenseSplitSums_();
  var entrySplitSumByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    entrySplitSumByEntry[s.entry_id] = (entrySplitSumByEntry[s.entry_id] || 0) + Number(s.amount);
  });

  // One occurrence at a time: a weekly item has several this month and each
  // is paid or not on its own. (An explicitly linked entry from another
  // category — "Mark as paid…" accepts any — is still found through the item's
  // own category list only when it shares it; linking an entry sets
  // recurring_expense_id, which is checked below.)
  var linkedByItem = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status === 'confirmed' && e.recurring_expense_id) (linkedByItem[e.recurring_expense_id] = linkedByItem[e.recurring_expense_id] || []).push(e);
  });
  function occurrenceHandled(r, occDate) {
    var pool = (confirmedByCategory[r.category_id] || []).concat(linkedByItem[r.id] || []);
    return pool.some(function (e) {
      return entryMatchesRecurringOccurrence_(e, r, [occDate], entrySplitSumByEntry, splitSums);
    });
  }

  // Kept as {row, occurrenceDate} rather than just the row — the
  // occurrence's own (clamped) date is what "overdue" below needs, not the raw
  // day field (a "day 31" item genuinely occurs on the 28th in February, not
  // the 31st). One entry per unpaid occurrence.
  var stillExpected = [];
  getRecurringExpenseRows_().forEach(function (r) {
    if (String(r.active) === 'false') return;
    recurringExpenseOccurrencesInRange_(r, monthStart, monthEnd).forEach(function (occDate) {
      if (occurrenceHandled(r, occDate)) return;
      stillExpected.push({ row: r, occurrenceDate: occDate });
    });
  });

  var ctx = buildBudgetContext_();
  var cutoffMonth = monthEnd.substring(0, 7);
  var todayStr = formatCalendarDate_(now);
  var groupsByKey = {};

  stillExpected.forEach(function (entry) {
    var r = entry.row;
    var currency = r.currency || homeCurrency_();
    var cat = categoryById[r.category_id];
    var type = cat ? cat.type : 'expense';
    var key = type + '|' + currency;
    if (!groupsByKey[key]) groupsByKey[key] = { type: type, currency: currency, total: 0, items: [] };
    var group = groupsByKey[key];
    var ownAmount = recurringOwnAmount_(r, splitSums);
    group.total += ownAmount;
    group.items.push({
      id: r.id,
      description: r.description || '',
      category_name: cat ? categoryLabel_(cat) : tr_('label.unknownCategory'),
      category_icon: cat ? cat.icon : '',
      amount: ownAmount,
      estimated: isVariableRecurring_(r),   // variable bill: the amount is an average, shown with "≈"
      // The occurrence's own actual (clamped) day, not the raw configured
      // one — matters for a 'once' item (which has no day/month at all)
      // and also fixes a latent mismatch for a monthly item whose day
      // (e.g. 31) got clamped to a shorter month's real last day.
      day: Number(entry.occurrenceDate.slice(8, 10)),
      overdue: entry.occurrenceDate < todayStr
    });
  });

  var groups = Object.keys(groupsByKey).map(function (key) {
    var group = groupsByKey[key];
    if (group.currency !== homeCurrency_()) {
      var rate = latestRateAtOrBefore_(ctx, group.currency, cutoffMonth);
      group.totalPen = rate != null ? group.total * rate : null;
    }
    group.items.sort(function (a, b) { return a.day - b.day; });
    return group;
  });

  // Income groups before expense groups (matches Projections' own
  // income-first convention), then within each type PEN (the common
  // case) first, then everything else alphabetically — stable and
  // predictable rather than whatever order object keys land in.
  groups.sort(function (a, b) {
    if (a.type !== b.type) return a.type === 'income' ? -1 : 1;
    if (a.currency === homeCurrency_()) return -1;
    if (b.currency === homeCurrency_()) return 1;
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

// Days remaining in a period, today's own day already excluded — the
// same "N days left" convention the Projections chart's caption and
// daysLeft (computeAllCategoryProjections_) use, extracted here so
// Budgets' own chart (getBudgetChartSeries) can share it exactly rather
// than risk a second, subtly different definition drifting from it.
// today itself counts as already reflected in "actual," so it isn't
// double-counted as remaining; a period that hasn't started yet counts
// its whole span as remaining; one that's already ended has none left.
function daysLeftInPeriod_(startDate, endDate) {
  var todayStr = formatCalendarDate_(new Date());
  if (todayStr < startDate) return daysBetweenDates_(endDate, startDate) + 1;
  if (todayStr > endDate) return 0;
  return daysBetweenDates_(endDate, todayStr);
}

function daysBetweenDates_(dateStrA, dateStrB) {
  var msPerDay = 24 * 60 * 60 * 1000;
  var a = new Date(dateStrA + 'T00:00:00');
  var b = new Date(dateStrB + 'T00:00:00');
  return Math.round((a.getTime() - b.getTime()) / msPerDay);
}
