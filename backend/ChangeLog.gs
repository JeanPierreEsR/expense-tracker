/**
 * Business 2, Phase 2, piece 8 (owner's plan "Fase 2 en detalle", approved 2026-11-23): the CHANGE LOG. Company copies only (owner:
 * on the consumer copy it would be heavy for little value; deletes are already covered by Recently deleted).
 *
 * Every write the server makes to a tracked tab (entries, loans and their repayments / installments, contributions, distributions,
 * project splits) leaves a line: when, from where (the app, WhatsApp, Telegram, a bank e-mail, Apple Pay, other), what (created,
 * changed, deleted), which row, and for a change the field with its value before and after. The lines are collected while the
 * request runs and written in ONE go at its end (flushChangeLog_), so a save costs one extra write, not one per field; the value
 * before a change comes from ONE read of the row the first time it is touched in the request.
 *
 * Only the server writes the "Change Log" tab: the app has no action that writes it. Honest limit (said on the screen): whoever owns
 * the Sheet can still edit it by hand; the month close's fingerprint (MonthClose.gs) is what notices that. Bulk writers that set
 * whole ranges at once (a statement upload's rows, Tidy my history) are logged as created rows when they go through appendRowsBulk_,
 * and not field by field otherwise.
 */

var CHANGE_LOG_TABLES_ = {
  'Entries': true, 'Loans': true, 'Settlements': true, 'Loan Installments': true,
  'Contributions': true, 'Distributions': true, 'Project Splits': true
};
var CHANGE_LOG_HEADERS_ = ['id', 'at', 'source', 'action', 'table', 'row_id', 'field', 'before', 'after', 'month'];
var CHANGE_LOG_SKIP_FIELDS_ = { updated_at: true };
var CHANGE_ON_ = null;        // per request: is this a company copy?
var CHANGE_BUF_ = [];         // lines waiting to be written at the end of the request
var CHANGE_SOURCE_ = 'other'; // 'app' | 'whatsapp' | 'telegram' | 'email' | 'applepay' | 'other'
var CHANGE_ROWS_ = {};        // table + '|' + row number -> the row as it was when first read in this request (then kept up to date)
var CHANGE_BATCHING_ = false; // inside a request that flushes at its end (doPost, an e-mail scan); otherwise each line is written at once

function changeLogReset_(source) {
  CHANGE_ON_ = null;
  CHANGE_BUF_ = [];
  CHANGE_ROWS_ = {};
  CHANGE_SOURCE_ = source || 'other';
  CHANGE_BATCHING_ = true;
}

function changeLogOn_(table) {
  if (!CHANGE_LOG_TABLES_[table]) return false;
  if (CHANGE_ON_ === null) {
    try { CHANGE_ON_ = isCompanyCopy_(); } catch (e) { CHANGE_ON_ = false; }
  }
  return CHANGE_ON_;
}

function changeText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Utilities.formatDate(v, sheetDateTz_(), 'yyyy-MM-dd');
  return String(v);
}

function changeMonthOf_(row) {
  var d = row && changeText_(row.date);
  return /^\d{4}-\d{2}/.test(d || '') ? d.slice(0, 7) : '';
}

// A row as a short text for "created" / "deleted": its filled fields, the bookkeeping ones left out.
function changeSummary_(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (CHANGE_LOG_SKIP_FIELDS_[k] || k === 'id' || k === 'created_at' || k === 'used') return;
    var v = changeText_(obj[k]);
    if (v !== '') out[k] = v;
  });
  var s = JSON.stringify(out);
  return s.length > 1500 ? s.slice(0, 1500) + '…' : s;
}

function changeNote_(action, table, rowId, field, before, after, month) {
  CHANGE_BUF_.push({ id: Utilities.getUuid(), at: nowStamp_(), source: CHANGE_SOURCE_, action: action, table: table,
    row_id: changeText_(rowId), field: field || '', before: before || '', after: after || '', month: month || '' });
  if (!CHANGE_BATCHING_) flushChangeLog_();   // a timer or a menu item: no end-of-request flush will come
}

function changeNoteCreate_(table, obj) {
  if (!changeLogOn_(table) || !obj) return;
  changeNote_('create', table, obj.id, '', '', changeSummary_(obj), changeMonthOf_(obj));
}

function changeNoteDelete_(table, obj) {
  if (!changeLogOn_(table) || !obj) return;
  changeNote_('delete', table, obj.id, '', changeSummary_(obj), '', changeMonthOf_(obj));
  // Rows below it move up: what was remembered by row number is no longer right.
  Object.keys(CHANGE_ROWS_).forEach(function (k) { if (k.indexOf(table + '|') === 0) delete CHANGE_ROWS_[k]; });
}

// Before one cell of a tracked tab is written: remembers the row (one read per row and request) and notes the change if the value
// really changes. `value` is what is about to be written.
function changeNoteCell_(sheet, headers, rowIndex, field, value) {
  var table = sheet.getName();
  if (!changeLogOn_(table) || CHANGE_LOG_SKIP_FIELDS_[field]) return;
  var key = table + '|' + rowIndex;
  var row = CHANGE_ROWS_[key];
  if (!row) {
    var values = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
    row = {};
    headers.forEach(function (h, i) { row[h] = values[i]; });
    CHANGE_ROWS_[key] = row;
  }
  var before = changeText_(row[field]), after = changeText_(value);
  if (before === after || (before.charAt(0) === "'" && before.slice(1) === after)) return;
  if (Number(before) === Number(after) && before !== '' && after !== '' && !isNaN(Number(before))) return;   // 10 vs "10"
  changeNote_('update', table, row.id, field, before, after, changeMonthOf_(row));
  row[field] = value;
}

// Changes that are not a row of a tracked tab (a month closed or reopened). `what` is a code the app translates.
function changeNoteEvent_(what, month, detail) {
  if (CHANGE_ON_ === null) { try { CHANGE_ON_ = isCompanyCopy_(); } catch (e) { CHANGE_ON_ = false; } }
  if (!CHANGE_ON_) return;
  changeNote_(what, 'Month Closes', month, '', '', detail || '', month);
}

function ensureChangeLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Change Log');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Change Log');
  sheet.getRange(1, 1, 1, CHANGE_LOG_HEADERS_.length).setValues([CHANGE_LOG_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), CHANGE_LOG_HEADERS_.length).setNumberFormat('@');   // everything stays text
  sheet.setFrozenRows(1);
  return sheet;
}

// Writes what this request noted, in one go. Never fails the request it belongs to.
function flushChangeLog_() {
  if (!CHANGE_BUF_.length) return;
  var lines = CHANGE_BUF_;
  CHANGE_BUF_ = [];
  try {
    var sheet = ensureChangeLogSheet_();
    var rows = lines.map(function (l) { return CHANGE_LOG_HEADERS_.map(function (h) { return sheetSafeText_(l[h]); }); });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CHANGE_LOG_HEADERS_.length).setValues(rows);
    if (ROWS_MEMO_) delete ROWS_MEMO_['Change Log'];
  } catch (err) {
    console.error('flushChangeLog_: ' + err);
  }
}

function changeLogRows_() {
  flushChangeLog_();   // what this same request did is part of the answer
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Change Log')) return [];
  return getAllRows('Change Log').map(function (r) {
    var o = {};
    CHANGE_LOG_HEADERS_.forEach(function (h) { o[h] = changeText_(r[h]).replace(/^'/, ''); });
    return o;
  });
}

/**
 * The change log for the app (company copies). payload: { month: 'YYYY-MM' } (the lines about that month's entries, plus what was
 * done in it to rows with no date) or { entry_id } (one entry's history: the entry itself and the rows that belong to it).
 * Newest first, at most `limit` (default 300). Each line: { at, source, action, table, row_id, field, before, after, month, what }.
 * `what` names the row the way a person knows it (the entry's description and amount when it still exists).
 */
function listChangeLog(payload) {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
  payload = payload || {};
  var limit = Math.min(Number(payload.limit) || 300, 1000);
  var rows = changeLogRows_();
  var entries = {};
  getAllRows('Entries').forEach(function (e) { entries[e.id] = e; });
  // Rows that belong to an entry (a split, a contribution...): their entry_id, read from their own tab.
  var owner = {};
  ['Contributions', 'Distributions', 'Project Splits'].forEach(function (t) {
    if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(t)) return;
    getAllRows(t).forEach(function (r) { owner[r.id] = r.entry_id; });
  });
  var monthOf = function (l) {
    if (l.month) return l.month;
    var e = entries[l.row_id] || entries[owner[l.row_id]];
    return e ? String(e.date).slice(0, 7) : String(l.at).slice(0, 7);
  };
  var out = rows.filter(function (l) {
    if (payload.entry_id) return l.row_id === payload.entry_id || owner[l.row_id] === payload.entry_id;
    if (payload.month) return monthOf(l) === payload.month;
    return true;
  }).map(function (l) {
    var e = entries[l.row_id] || entries[owner[l.row_id]];
    l.month = monthOf(l);
    l.what = e ? { description: String(e.description || ''), amount: Number(e.amount), currency: String(e.currency || ''), date: String(e.date).slice(0, 10), type: e.type } : null;
    return l;
  });
  out.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
  return { lines: out.slice(0, limit), total: out.length };
}
