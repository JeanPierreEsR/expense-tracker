/**
 * Change tracking for the Entries-tab search (see specs/entries-and-categories.md).
 *
 * The app keeps a copy of every confirmed entry on the phone so search is
 * instant. To keep that copy fresh WITHOUT re-downloading everything, the
 * backend records what changed:
 *
 *  - Entries.updated_at   — UTC timestamp of the entry's last change (any
 *    field, its splits, or its labels). Blank = never touched since the
 *    column was introduced. Plain-text column, like created_at.
 *  - ENTRIES_VERSION      — Script Property, replaced with a new unique value
 *    on every entry change. Equal to the phone's copy => nothing to fetch.
 *  - STRUCTURE_VERSION    — bumped when something that changes MANY entries'
 *    search text or amounts changes (category / payment method / friend /
 *    payor / label / exchange-rate edits, bulk writes). The phone then does a
 *    full reload instead of a delta.
 *  - Entry Deletions      — a small log of deleted entry ids, since a deleted
 *    row leaves nothing behind for `updated_at` to flag.
 *
 * Every write path funnels through appendRowObject / setCellByRow_ /
 * deleteRowsWhere_ / deleteEntry_, which call the hooks below; the few bulk
 * writers that touch sheets directly call bumpStructureVersion_() instead.
 * Not covered: edits typed by hand into the Google Sheet — the phone's copy
 * is force-refreshed every 24 h (and on demand, "↻") for exactly that.
 */

// Sheets whose contents feed entries' search text / PEN amounts.
var STRUCTURE_SHEETS_ = {
  'Categories': true, 'Payment Methods': true, 'Friends': true, 'Payors': true,
  'Tags': true, 'Exchange Rates': true
};
// Per-entry side tables — a change touches the entry they belong to.
var ENTRY_CHILD_SHEETS_ = { 'Entry Splits': true, 'Entry Tags': true };

var updatedAtColCache_ = null;   // per execution
var writeBatch_ = null;          // {rows: {rowIndex: true}, structure: bool} while batching

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

function bumpVersion_(key) {
  PropertiesService.getScriptProperties().setProperty(key, nowStamp_() + '-' + Math.random().toString(36).slice(2, 8));
}

function getVersion_(key) {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty(key);
  if (!v) { bumpVersion_(key); v = props.getProperty(key); }
  return v;
}

function bumpStructureVersion_() {
  if (writeBatch_) { writeBatch_.structure = true; return; }
  bumpVersion_('STRUCTURE_VERSION');
}

// Entries pre-date this column, so it's appended in place the first time
// it's needed (same self-heal as merchant / recurring_expense_id). Returns
// its 1-based column number.
function ensureEntriesUpdatedAtColumn_() {
  if (updatedAtColCache_) return updatedAtColCache_;
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var idx = headers.indexOf('updated_at');
  if (idx === -1) {
    var col = headers.length + 1;
    sheet.getRange(1, col).setValue('updated_at').setFontWeight('bold');
    // Plain text, or Sheets converts the timestamps into its own Date type
    // and every string comparison breaks (same trap as created_at).
    sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
    idx = col - 1;
  }
  updatedAtColCache_ = idx + 1;
  return updatedAtColCache_;
}

// Groups the writes made inside fn into ONE timestamp + version bump per
// entry (an edit form saves ~10 cells; stamping each one would be slow).
function withWriteBatch_(fn) {
  if (writeBatch_) return fn();
  writeBatch_ = { rows: {}, structure: false };
  try {
    return fn();
  } finally {
    var batch = writeBatch_;
    writeBatch_ = null;
    var rows = Object.keys(batch.rows).map(Number);
    if (rows.length) stampEntryRows_(rows);
    if (batch.structure) bumpVersion_('STRUCTURE_VERSION');
  }
}

function stampEntryRows_(rowIndexes) {
  var sheet = getSheet('Entries');
  var col = ensureEntriesUpdatedAtColumn_();
  var stamp = nowStamp_();
  rowIndexes.forEach(function (r) { sheet.getRange(r, col).setValue(stamp); });
  bumpVersion_('ENTRIES_VERSION');
}

// Called after every single-cell write (setCellByRow_).
function noteCellWrite_(sheet, rowIndex, fieldName) {
  var name = sheet.getName();
  if (name === 'Entries') {
    if (fieldName === 'updated_at') return;
    if (writeBatch_) { writeBatch_.rows[rowIndex] = true; return; }
    stampEntryRows_([rowIndex]);
  } else if (STRUCTURE_SHEETS_[name]) {
    bumpStructureVersion_();
  }
}

// Called by appendRowObject AFTER the row is written (child/structure
// sheets) — Entries itself is stamped inline, before the row is written.
function noteRowAppended_(sheetName, obj) {
  if (ENTRY_CHILD_SHEETS_[sheetName]) touchEntriesById_([obj.entry_id]);
  else if (STRUCTURE_SHEETS_[sheetName]) bumpStructureVersion_();
  else if (sheetName === 'Entries') bumpVersion_('ENTRIES_VERSION');
}

// Called by deleteRowsWhere_ with the rows it removed.
function noteRowsDeleted_(sheetName, deletedObjs) {
  if (!deletedObjs.length) return;
  if (sheetName === 'Entries') {
    recordEntryDeletions_(deletedObjs.map(function (o) { return o.id; }));
  } else if (ENTRY_CHILD_SHEETS_[sheetName]) {
    touchEntriesById_(deletedObjs.map(function (o) { return o.entry_id; }));
  } else if (STRUCTURE_SHEETS_[sheetName]) {
    bumpStructureVersion_();
  }
}

// Stamps updated_at on the given entries (a split or label changed) and
// bumps the version once. Ids that no longer exist are skipped.
function touchEntriesById_(entryIds) {
  var wanted = {};
  entryIds.forEach(function (id) { if (id) wanted[String(id)] = true; });
  if (!Object.keys(wanted).length) return;
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var idCol = headers.indexOf('id');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || idCol === -1) return;
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var rows = [];
  for (var i = 0; i < ids.length; i++) {
    if (wanted[String(ids[i][0])]) rows.push(i + 2);
  }
  if (!rows.length) return;
  if (writeBatch_) { rows.forEach(function (r) { writeBatch_.rows[r] = true; }); return; }
  stampEntryRows_(rows);
}

var ENTRY_DELETIONS_HEADERS_ = ['entry_id', 'deleted_at'];

function ensureEntryDeletionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Entry Deletions');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Entry Deletions');
  sheet.getRange(1, 1, 1, 2).setValues([ENTRY_DELETIONS_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 2, sheet.getMaxRows(), 1).setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

function recordEntryDeletions_(entryIds) {
  if (!entryIds.length) return;
  var sheet = ensureEntryDeletionsSheet_();
  var stamp = nowStamp_();
  var rows = entryIds.map(function (id) { return [String(id), stamp]; });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
  // Only recent history matters (the phone does a full reload if it has
  // been away longer than a day) — trim rows older than 30 days.
  if (sheet.getLastRow() > 300) {
    var cutoff = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
    var vals = sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues();
    for (var i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][0]) < cutoff) sheet.deleteRow(i + 2);
    }
  }
  bumpVersion_('ENTRIES_VERSION');
}

// ---- Sync API for the Entries-tab search (see app.js: syncSearchIndex_) ----

/**
 * Payload: { structureVersion, entriesVersion, since } — what the phone's
 * saved copy was built from (all absent on first ever load).
 * Returns { mode: 'full' | 'delta' | 'none', structureVersion,
 *   entriesVersion, syncedAt, count, ... }:
 *   full  -> rows: the whole list
 *   delta -> changed: rows to add/replace, removedIds: rows to drop
 *   none  -> nothing changed (the phone must NOT advance its `since`)
 * Versions are read BEFORE the data, and `syncedAt` before both, so a write
 * racing with this call is picked up by the next one, never lost.
 */
function syncEntrySearchIndex(payload) {
  payload = payload || {};
  var sv = getVersion_('STRUCTURE_VERSION');
  var ev = getVersion_('ENTRIES_VERSION');
  var syncedAt = nowStamp_();
  var base = { structureVersion: sv, entriesVersion: ev, syncedAt: syncedAt };

  var canDelta = payload.since && payload.structureVersion === sv && payload.entriesVersion;
  if (!canDelta) return fullSearchIndexResponse_(base);
  if (payload.entriesVersion === ev) {
    base.mode = 'none';
    return base;
  }

  ensureEntriesUpdatedAtColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var col = function (name) { return headers.indexOf(name); };
  var colVals = function (name) {
    return lastRow < 2 ? [] : sheet.getRange(2, col(name) + 1, lastRow - 1, 1).getValues();
  };
  var ids = colVals('id'), stamps = colVals('updated_at'), statuses = colVals('status');

  var count = 0, changedRows = [];
  for (var i = 0; i < ids.length; i++) {
    if (statuses[i][0] === 'confirmed') count++;
    if (String(stamps[i][0]) >= payload.since && stamps[i][0] !== '') changedRows.push(i + 2);
  }
  // A big batch of changes is cheaper to send as a full reload.
  if (changedRows.length > 40) return fullSearchIndexResponse_(base);

  var tz = Session.getScriptTimeZone();
  var changedObjs = changedRows.map(function (r) {
    var values = sheet.getRange(r, 1, 1, headers.length).getValues()[0];
    var obj = {};
    headers.forEach(function (h, idx) {
      var v = values[idx];
      if (v instanceof Date && DATE_FIELD_FORMATS[h]) v = Utilities.formatDate(v, tz, DATE_FIELD_FORMATS[h]);
      else if (STRING_FIELDS[h] && v !== '' && v != null) v = String(v);
      obj[h] = v;
    });
    return obj;
  });

  var removedIds = changedObjs.filter(function (o) { return o.status !== 'confirmed'; })
    .map(function (o) { return o.id; });
  var confirmed = changedObjs.filter(function (o) { return o.status === 'confirmed'; });

  var deletions = ensureEntryDeletionsSheet_();
  if (deletions.getLastRow() > 1) {
    deletions.getRange(2, 1, deletions.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (String(r[1]) >= payload.since) removedIds.push(String(r[0]));
    });
  }

  base.mode = 'delta';
  base.count = count;
  base.changed = buildSearchIndexRows_(confirmed);
  base.removedIds = removedIds;
  return base;
}

function fullSearchIndexResponse_(base) {
  var rows = listEntrySearchIndex();
  base.mode = 'full';
  base.count = rows.length;
  base.rows = rows;
  return base;
}
