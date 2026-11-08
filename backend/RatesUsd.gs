/**
 * Exchange rates stored against the US dollar (owner, 2026-11-07; release B of "Exchange rates through USD plan").
 *
 * A converted copy has Settings `rate_base` = USD and `rate_form` = per_base. Each Exchange Rates row then reads the way
 * banks quote it, "1 USD = <rate> <currency>" (so the Sheet reads right by hand: ARS 1,442.31, not 0.000693), and an
 * amount in any currency reaches the main currency through the dollar: X in main = per_usd(main) / per_usd(X).
 * Inside the code every rate is still "1 <currency> = r <base>" (HomeCurrency.gs); only the row is turned around, in
 * `buildRatesByCurrency_` / `upsertBaseRate_` (rowRateToBase_ / baseRateToRow_).
 *
 * A copy is converted once, by the person: `previewRatesToUsd` lists every row before and after and every month whose
 * expenses would change, `convertRatesToUsd` applies it (a copy of the old rows goes to the "Exchange Rates before USD"
 * tab first). Only the owner's copy for now (friends' copies on the owner's decision).
 */

var RATE_FORM_MEMO_ = null;   // per request; doPost clears it, setSetting_ clears it on a change
var RATES_BEFORE_USD_SHEET_ = 'Exchange Rates before USD';

function ratesPerBase_() {
  if (RATE_FORM_MEMO_ === null) {
    var v = '';
    try { v = String(getSettingsMap().rate_form || '').trim(); } catch (err) { /* sheet unreadable: as before */ }
    RATE_FORM_MEMO_ = v === 'per_base' ? 'per_base' : '';
  }
  return RATE_FORM_MEMO_ === 'per_base';
}

// A stored row's rate, in the code's terms (1 <currency> = r <base>), and back.
function rowRateToBase_(v) { v = Number(v); return ratesPerBase_() && v > 0 ? 1 / v : v; }
function baseRateToRow_(v) { v = Number(v); return ratesPerBase_() && v > 0 ? 1 / v : v; }

// Rates go through the dollar: asked and listed as "1 USD = ? <currency>".
function ratesThroughUsd_() { return rateBase_() === 'USD' && ratesPerBase_(); }

// "1 USD = ? <code>" around `month` (latest on or before), for a currency as the person sees it: the main currency's
// own rate is listed as USD (1 USD = ? main). Null when not on file.
function perUsdAt_(currency, month) {
  if (!ratesThroughUsd_()) return null;
  var by = buildRatesByCurrency_();
  var code = currency === 'USD' ? homeCurrency_() : currency;
  if (code === 'USD') return null;
  var b = baseRateAt_(by, code, month);
  return b > 0 ? 1 / b : null;
}

// The owner's share in US dollars, for an entry in a third currency (not USD, not the main one), once rates go through
// the dollar; null otherwise (owner, 2026-11-07: the line shows under the main-currency amount).
function usdLineAmount_(by, amount, currency, date) {
  if (!ratesThroughUsd_() || currency === 'USD' || currency === homeCurrency_() || homeCurrency_() === 'USD') return null;
  var b = baseRateAt_(by, currency, String(date).substring(0, 7));
  return b != null ? Number(amount) * b : null;
}

// 1 <currency> = ? <main>, with any map, base and main (the preview compares two maps). Same rules as rateToMain_.
function rateToMainWith_(by, base, main, currency, month) {
  if (currency === main) return 1;
  var x = currency === base ? 1 : latestRateFromList_(by[currency], month);
  if (x == null) return null;
  var m;
  if (main === base) m = 1;
  else {
    var list = by[main];
    if (!list || !list.length) return null;
    m = latestRateFromList_(list, month);
    if (m == null) m = list[0].rate;
  }
  return m > 0 ? x / m : null;
}

// What the conversion would write: one new row for every old one (the dollar's own rows become the old base's rows,
// "1 USD = u <old base>"), plus the new map in base-USD terms.
function ratesToUsdPlan_() {
  var base = rateBase_(), main = homeCurrency_();
  var rows = getAllRows('Exchange Rates');
  var old = buildRatesByCurrency_();
  var usd = base === 'USD' ? null : (old.USD || []);
  if (usd && !usd.length) return { needsUsd: true };
  function usdAt(month) {   // 1 USD = ? <old base>: the latest on or before, else the earliest
    if (!usd) return 1;
    var r = latestRateFromList_(usd, month);
    return r != null ? r : usd[0].rate;
  }
  var out = [], dropped = 0;
  rows.forEach(function (r) {
    var cur = String(r.currency).toUpperCase(), month = String(r.month), rate = rowRateToBase_(r.rate);
    if (!(rate > 0) || cur === base) { dropped++; return; }   // the base has no row of its own (it is 1)
    var before = { currency: cur, rate: rateToMainWith_(old, base, main, cur, month) };
    if (cur === 'USD') out.push({ id: r.id, month: month, currency: base, per_usd: rate, before: before });
    else out.push({ id: r.id, month: month, currency: cur, per_usd: usdAt(month) / rate, before: before });
  });
  var next = {};
  out.forEach(function (o) { (next[o.currency] = next[o.currency] || []).push({ month: o.month, rate: 1 / o.per_usd }); });
  Object.keys(next).forEach(function (c) { next[c].sort(function (a, b) { return a.month < b.month ? -1 : 1; }); });
  return { base: base, main: main, rows: out, dropped: dropped, old: old, next: next };
}

function previewRatesToUsd() {
  if (isFriendCopy_()) requireOwnerCopyForRates_();
  if (ratesThroughUsd_()) return { done: true };
  var plan = ratesToUsdPlan_();
  if (plan.needsUsd) return { needsUsd: true };
  var main = plan.main;
  // Every month whose expenses (the owner's share, in the main currency) would read differently.
  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) { splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount); });
  var months = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || e.type !== 'expense') return;
    var month = String(e.date).substring(0, 7), cur = String(e.currency || main).toUpperCase();
    var own = Number(e.amount) - (splitSum[e.id] || 0);
    var m = months[month] = months[month] || { month: month, before: 0, after: 0, changed: 0 };
    if (cur === main) { m.before += own; m.after += own; return; }
    var a = rateToMainWith_(plan.old, plan.base, main, cur, month), b = rateToMainWith_(plan.next, 'USD', main, cur, month);
    m.before += a != null ? own * a : 0;
    m.after += b != null ? own * b : 0;
    if (a == null || b == null ? a !== b : Math.abs(own * a - own * b) >= 0.005) m.changed++;
  });
  var changed = Object.keys(months).map(function (k) { return months[k]; })
    .filter(function (m) { return m.changed > 0 && Math.abs(m.after - m.before) >= 0.005; })
    .sort(function (x, y) { return x.month < y.month ? 1 : -1; })
    .map(function (m) { return { month: m.month, before: round2_(m.before), after: round2_(m.after), entries: m.changed }; });
  return {
    main: main,
    rows: plan.rows.map(function (o) { return { month: o.month, currency: o.currency, per_usd: o.per_usd, before: o.before }; })
      .sort(function (x, y) { return x.month !== y.month ? (x.month < y.month ? 1 : -1) : (x.currency < y.currency ? -1 : 1); }),
    months: changed
  };
}

function requireOwnerCopyForRates_() {
  var denied = new Error(tr_('rates.usdOwnerOnly'));
  denied.code = 'not_allowed';
  throw denied;
}

function convertRatesToUsd() {
  if (isFriendCopy_()) requireOwnerCopyForRates_();
  if (ratesThroughUsd_()) return { done: true, changed: false };
  var plan = ratesToUsdPlan_();
  if (plan.needsUsd) throw new Error(tr_('rates.usdNeeded'));
  var sheet = getSheet('Exchange Rates');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var oldValues = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  // 1. A copy of the old rows, as they were, in a tab of their own (replaced if an earlier copy is there).
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var backup = ss.getSheetByName(RATES_BEFORE_USD_SHEET_);
  if (!backup) backup = ss.insertSheet(RATES_BEFORE_USD_SHEET_);
  else if (backup.getLastRow() >= 1) backup.getRange(1, 1, backup.getLastRow(), backup.getLastColumn()).clearContent();
  backup.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  backup.getRange(1, 1, Math.max(backup.getMaxRows(), oldValues.length + 1), headers.length).setNumberFormat('@');
  if (oldValues.length) backup.getRange(2, 1, oldValues.length, headers.length).setValues(oldValues.map(function (row) { return row.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, sheetDateTz_(), 'yyyy-MM') : String(v); }); }));
  backup.getRange(1, headers.length + 2).setValue(tr_('rates.usdBackupNote', { base: plan.base }));
  // 2. The new rows over the old ones (one for one; a row that could not be converted is removed at the end).
  var newValues = plan.rows.map(function (o) {
    return headers.map(function (h) { return h === 'id' ? o.id : h === 'month' ? o.month : h === 'currency' ? o.currency : h === 'rate' ? o.per_usd : ''; });
  });
  if (newValues.length) sheet.getRange(2, 1, newValues.length, headers.length).setValues(newValues);
  if (oldValues.length > newValues.length) deleteSheetRows_(sheet, 2 + newValues.length, oldValues.length - newValues.length);
  // 3. Only then the settings: from here on every row is "1 USD = rate <currency>".
  setSetting_('rate_base_before_usd', plan.base);
  setSetting_('rate_base', 'USD');
  setSetting_('rate_form', 'per_base');
  RATES_MEMO_ = null;
  bumpStructureVersion_();
  return { done: true, changed: true, rows: newValues.length };
}
