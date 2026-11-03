/**
 * Home → Edit: several entries at once (owner's request, 2026-11-03; stage 1 = delete).
 *
 * Deleting one entry has seven special cases (a loan's cash movement, a repayment and its extra, a forgiveness, an expense whose loans were repaid, one side of
 * a currency exchange, a shared expense). A bulk delete handles ONLY the plain ones, so the rest are kept, never half-undone, and named with the reason: the
 * person deletes those one by one, where the single flow asks the right question. A shared expense IS deleted (its split and the debt that came from it go with
 * it, as with the single delete), and the preview says how many friends' debts that touches.
 *
 *   previewEntriesDelete({ ids })  -> { items: [{ id, found, reason, shared }] }   reason '' = can be deleted here
 *   deleteEntries({ ids })         -> { deleted: [ids], kept: [{ id, reason }], batch_id }    judged again here: the phone's answer is never trusted
 *                                     (batch_id = the safety copy of what was deleted, see Stage 3 below)
 *
 * Reasons: missing | loanMovement | forgiveness | repayment | repaymentExtra | repaidLoans | exchange. At most BULK_ENTRIES_MAX_ per call.
 */
var BULK_ENTRIES_MAX_ = 300;

function bulkEntryIds_(payload) {
  var ids = uniqueIds_(payload && payload.ids);
  if (ids.length > BULK_ENTRIES_MAX_) {
    var err = new Error(tr_('bulk.tooMany', { n: BULK_ENTRIES_MAX_ }));
    err.code = 'bad_request';
    throw err;
  }
  return ids;
}

// '' when the entry is a plain one that can go in a batch; otherwise why not. The same links the single delete looks at (getEntryRepaymentLinks).
function entryBulkVerdict_(entry) {
  if (['transfer', 'expense', 'income'].indexOf(entry.type) === -1) return '';   // (an investment has none of these links)
  var links = getEntryRepaymentLinks({ id: entry.id });
  if (links.loan) return 'loanMovement';
  if (links.forgiveness) return 'forgiveness';
  if (links.repayment) return 'repayment';
  if (links.repaymentExtra) return 'repaymentExtra';
  if (links.refunds && links.refunds.length) return 'repaidLoans';
  if (links.exchangePartner) return 'exchange';
  return '';
}

// entry id -> { friendId: true } for the friends whose split or loan comes from that entry.
function entrySharedFriendsMap_(ids) {
  var want = {}, out = {};
  ids.forEach(function (id) { want[id] = true; });
  var add = function (entryId, friendId) {
    if (!want[entryId] || !friendId) return;
    (out[entryId] = out[entryId] || {})[friendId] = true;
  };
  getAllRows('Entry Splits').forEach(function (s) { add(String(s.entry_id), String(s.friend_id)); });
  getAllRows('Loans').forEach(function (l) { if (l.origin === 'entry') add(String(l.entry_id), String(l.friend_id)); });
  return out;
}

function previewEntriesDelete(payload) {
  var ids = bulkEntryIds_(payload);
  var shared = entrySharedFriendsMap_(ids);
  return {
    items: ids.map(function (id) {
      var entry = getEntryById_(id);
      if (!entry) return { id: id, found: false, reason: 'missing', shared: 0 };
      return { id: id, found: true, reason: entryBulkVerdict_(entry), shared: Object.keys(shared[id] || {}).length };
    })
  };
}

function deleteEntries(payload) {
  var ids = bulkEntryIds_(payload);
  var out = { deleted: [], kept: [] };
  var del = [];
  ids.forEach(function (id) {
    var entry = getEntryById_(id);
    if (!entry) { out.kept.push({ id: id, reason: 'missing' }); return; }
    var reason = entryBulkVerdict_(entry);
    if (reason) { out.kept.push({ id: id, reason: reason }); return; }
    del.push(id);
  });
  if (!del.length) return out;
  // The safety copy FIRST: if it cannot be written, nothing is deleted (an Undo that might not work is worse than none).
  out.batch_id = snapshotEntriesForUndo_(del);
  // What deleteEntry_ does, for all of them at once (one pass per tab instead of one per entry). Splits and loans only for the shared ones, through the
  // same function the single delete uses (settled loans are handled there).
  var shared = entrySharedFriendsMap_(del);
  var gone = {};
  del.forEach(function (id) { gone[id] = true; });
  withWriteBatch_(function () {
    deleteRowsWhere_('Entries', function (row) { return gone[String(row.id)] === true; });
    recordEntryDeletions_(del);
    Object.keys(shared).forEach(function (id) { deleteEntrySplitsAndLoansForEntry_(id); });
    deleteRowsWhere_('Entry Tags', function (row) { return gone[String(row.entry_id)] === true; });
    if (entryBillsSheetExists_()) deleteRowsWhere_('Entry Bills', function (row) { return gone[String(row.entry_id)] === true; });
  });
  out.deleted = del;
  return out;
}

// ---- Stage 2: change the category of several entries at once ----
// setEntriesCategory({ ids, categories: { expense: id, income: id } }): each entry moves to the category chosen for ITS type (an expense never takes an income category).
// Only expense and income entries have a category of their own (a transfer's and an investment's are the app's); those, entries already there, entries of a type with no
// choice, and ids that no longer exist are kept with the reason. The same one-pass writer as "Tidy my history" (bulkSetEntryCategories_, which stamps the entries so other
// phones refresh), and an entry moved INTO Travel becomes Annual too, as with a single edit. The "blank look-alikes follow" learning is NOT run here.
// Answers { changed: [{ id, from, to }], kept: [{ id, reason: missing|type|noTarget|same|badCategory }], annualIds } — `changed` + `annualIds` are exactly what
// undoSetEntriesCategory needs to put everything back.
function setEntriesCategory(payload) {
  var ids = bulkEntryIds_(payload);
  var chosen = (payload && payload.categories) || {};
  var cats = {};
  getAllRows('Categories').forEach(function (c) { cats[String(c.id)] = c; });
  var target = {};
  ['expense', 'income'].forEach(function (type) {
    var c = chosen[type] ? cats[String(chosen[type])] : null;
    if (c && c.type === type && MANAGED_CATEGORY_TYPES_.indexOf(c.type) !== -1) target[type] = String(c.id);
  });
  var out = { changed: [], kept: [], annualIds: [] };
  var changes = [], before = {};
  ids.forEach(function (id) {
    var entry = getEntryById_(id);
    if (!entry) { out.kept.push({ id: id, reason: 'missing' }); return; }
    if (entry.type !== 'expense' && entry.type !== 'income') { out.kept.push({ id: id, reason: 'type' }); return; }
    if (chosen[entry.type] && !target[entry.type]) { out.kept.push({ id: id, reason: 'badCategory' }); return; }
    if (!target[entry.type]) { out.kept.push({ id: id, reason: 'noTarget' }); return; }
    if (String(entry.category_id || '') === target[entry.type]) { out.kept.push({ id: id, reason: 'same' }); return; }
    before[id] = String(entry.category_id || '');
    changes.push({ id: id, categoryId: target[entry.type], expect: before[id] });
  });
  var done = bulkSetEntryCategories_(changes);
  var doneSet = {};
  done.forEach(function (id) { doneSet[id] = true; });
  changes.forEach(function (c) {
    if (doneSet[c.id]) out.changed.push({ id: c.id, from: before[c.id], to: c.categoryId });
    else out.kept.push({ id: c.id, reason: 'same' });   // it moved under us (another device): nothing to do
  });
  Object.keys(target).forEach(function (type) {
    var movedHere = out.changed.filter(function (c) { return c.to === target[type]; }).map(function (c) { return c.id; });
    out.annualIds = out.annualIds.concat(annualForTravelMoves_(movedHere, target[type]));
  });
  return out;
}

// undoSetEntriesCategory({ changes: [{ id, from, to }], annualIds }): puts each entry back in its old category, but only if it is still in the one it was moved to; the
// Annual tags that action added go too.
function undoSetEntriesCategory(payload) {
  var changes = ((payload && payload.changes) || []).map(function (c) { return { id: String(c.id), categoryId: String(c.from || ''), expect: String(c.to || '') }; });
  var reverted = bulkSetEntryCategories_(changes);
  var annual = {};
  ((payload && payload.annualIds) || []).forEach(function (id) { annual[String(id)] = true; });
  if (Object.keys(annual).length) deleteRowsWhere_('Entry Tags', function (r) { return r.tag_id === ANNUAL_TAG_ID && annual[String(r.entry_id)] === true; });
  return { reverted: reverted };
}

// ---- Stage 3: Undo and "Recently deleted" for a bulk delete ----
// Before a bulk delete removes anything, a copy of each entry — with its splits, tags, bill and the loans that came from it — is written to the tab "Deleted Entries"
// (one row per entry, grouped by `batch_id`) and kept DELETED_ENTRIES_DAYS_ days. The toast's Undo and More → Recently deleted bring a whole batch, or single entries, back.
// A restored entry gets a fresh `updated_at` (so every phone picks it up again) and its id leaves the deletion log (otherwise a phone that syncs later would drop it again).
// What cannot come back is said: a friend deleted in the meantime means that entry's split / debt is not restored (`lostDebt`).
//   listDeletedEntries()                       -> { days, batches: [{ batch_id, deleted_at, entries: [{ entry_id, description, amount, currency, date, type, category_id }] }] }
//   restoreDeletedEntries({ batch_id | ids })   -> { restored: [ids], lostDebt: [ids], skipped: [{ id, reason: exists }] }
//   forgetDeletedEntries({ batch_id | ids })    -> { forgotten: n }   (delete for good)
var DELETED_ENTRIES_DAYS_ = 30;
var DELETED_ENTRIES_HEADERS_ = ['batch_id', 'deleted_at', 'entry_id', 'summary', 'payload'];

function ensureDeletedEntriesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Deleted Entries');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Deleted Entries');
  sheet.getRange(1, 1, 1, DELETED_ENTRIES_HEADERS_.length).setValues([DELETED_ENTRIES_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), DELETED_ENTRIES_HEADERS_.length).setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

function purgeOldDeletedEntries_() {
  var cutoff = Utilities.formatDate(new Date(Date.now() - DELETED_ENTRIES_DAYS_ * 86400000), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  deleteRowsWhere_('Deleted Entries', function (r) { return String(r.deleted_at) < cutoff; });
}

function snapshotEntriesForUndo_(ids) {
  var sheet = ensureDeletedEntriesSheet_();
  purgeOldDeletedEntries_();
  var want = {};
  ids.forEach(function (id) { want[id] = true; });
  var group = function (rows, key, keep) {
    var out = {};
    rows.forEach(function (r) { var k = String(r[key]); if (want[k] && (!keep || keep(r))) (out[k] = out[k] || []).push(r); });
    return out;
  };
  var splits = group(getAllRows('Entry Splits'), 'entry_id');
  var tags = group(getAllRows('Entry Tags'), 'entry_id');
  var bills = entryBillsSheetExists_() ? group(getAllRows('Entry Bills'), 'entry_id') : {};
  var loans = group(getAllRows('Loans'), 'entry_id', function (l) { return l.origin === 'entry'; });
  var batchId = Utilities.getUuid(), stamp = nowStamp_();
  var rows = [];
  getAllRows('Entries').forEach(function (e) {
    var id = String(e.id);
    if (!want[id]) return;
    var payload = { entry: e, splits: splits[id] || [], tags: tags[id] || [], bills: bills[id] || [], loans: loans[id] || [] };
    var text = JSON.stringify(payload);
    if (text.length > 45000) { payload.bills = []; payload.partial = 'bill'; text = JSON.stringify(payload); }   // (a cell holds 50,000 characters)
    var summary = JSON.stringify({ description: e.description || '', amount: e.amount, currency: e.currency, date: String(e.date || ''), type: e.type, category_id: e.category_id || '' });
    rows.push([batchId, stamp, id, summary, text]);
  });
  if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, DELETED_ENTRIES_HEADERS_.length).setValues(rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Deleted Entries'];
  return batchId;
}

function listDeletedEntries() {
  ensureDeletedEntriesSheet_();
  purgeOldDeletedEntries_();
  var byBatch = {}, order = [];
  getAllRows('Deleted Entries').forEach(function (r) {
    var b = byBatch[r.batch_id];
    if (!b) { b = byBatch[r.batch_id] = { batch_id: String(r.batch_id), deleted_at: String(r.deleted_at), entries: [] }; order.push(b); }
    var info = {};
    try { info = JSON.parse(String(r.summary || '{}')); } catch (e) { info = {}; }
    b.entries.push({ entry_id: String(r.entry_id), description: info.description || '', amount: info.amount, currency: info.currency || '', date: info.date || '', type: info.type || '', category_id: info.category_id || '' });
  });
  order.sort(function (a, b) { return String(b.deleted_at).localeCompare(String(a.deleted_at)); });
  return { days: DELETED_ENTRIES_DAYS_, batches: order };
}

// Rows of the safety-copy tab chosen by a batch id and / or entry ids.
function deletedEntryRowsFor_(payload) {
  var batch = String((payload && payload.batch_id) || '');
  var ids = {};
  uniqueIds_(payload && payload.ids).forEach(function (id) { ids[id] = true; });
  return getAllRows('Deleted Entries').filter(function (r) {
    return (batch && String(r.batch_id) === batch && (!Object.keys(ids).length || ids[String(r.entry_id)])) || (!batch && ids[String(r.entry_id)]);
  });
}

// One write per tab for a whole batch (a restore of 300 entries with one write per row would take minutes on a real Sheet).
function appendObjectsBatch_(sheetName, objs) {
  if (!objs.length) return;
  if (sheetName === 'Entries') {
    ensureEntriesUpdatedAtColumn_();
    var stamp = nowStamp_();
    objs.forEach(function (o) { o.updated_at = stamp; });
  }
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var rows = objs.map(function (o) { return headers.map(function (h) { return o[h] !== undefined ? o[h] : ''; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_[sheetName];
  if (sheetName === 'Entries') bumpVersion_('ENTRIES_VERSION');
  else if (ENTRY_CHILD_SHEETS_[sheetName]) touchEntriesById_(objs.map(function (o) { return o.entry_id; }));
  else if (STRUCTURE_SHEETS_[sheetName]) bumpStructureVersion_();
}

function restoreDeletedEntries(payload) {
  var rows = deletedEntryRowsFor_(payload);
  var out = { restored: [], lostDebt: [], skipped: [] };
  if (!rows.length) return out;
  var existing = {}, friends = {}, loanIds = {}, tagIds = {};
  getAllRows('Entries').forEach(function (e) { existing[String(e.id)] = true; });
  getAllRows('Friends').forEach(function (f) { friends[String(f.id)] = true; });
  getAllRows('Loans').forEach(function (l) { loanIds[String(l.id)] = true; });
  getAllRows('Tags').forEach(function (t) { tagIds[String(t.id)] = true; });
  var entries = [], splits = [], tags = [], bills = [], loans = [], doneKeys = {};
  rows.forEach(function (r) {
    var id = String(r.entry_id);
    var p;
    try { p = JSON.parse(String(r.payload)); } catch (e) { return; }
    var key = String(r.batch_id) + '|' + id;
    if (existing[id]) { out.skipped.push({ id: id, reason: 'exists' }); doneKeys[key] = true; return; }   // already back: only the copy is dropped
    entries.push(p.entry);
    var lost = false;
    (p.splits || []).forEach(function (sp) { if (friends[String(sp.friend_id)]) splits.push(sp); else lost = true; });
    (p.loans || []).forEach(function (l) { if (!friends[String(l.friend_id)]) lost = true; else if (!loanIds[String(l.id)]) loans.push(l); });
    (p.tags || []).forEach(function (t) { if (tagIds[String(t.tag_id)]) tags.push(t); });
    (p.bills || []).forEach(function (b) { bills.push(b); });
    if (lost) out.lostDebt.push(id);
    out.restored.push(id);
    doneKeys[key] = true;
  });
  appendObjectsBatch_('Entries', entries);
  appendObjectsBatch_('Entry Splits', splits);
  appendObjectsBatch_('Entry Tags', tags);
  if (bills.length && entryBillsSheetExists_()) appendObjectsBatch_('Entry Bills', bills);
  appendObjectsBatch_('Loans', loans);
  var back = {};
  out.restored.forEach(function (id) { back[id] = true; });
  if (Object.keys(back).length) deleteRowsWhere_('Entry Deletions', function (r) { return back[String(r.entry_id)] === true; });
  deleteRowsWhere_('Deleted Entries', function (r) { return doneKeys[String(r.batch_id) + '|' + String(r.entry_id)] === true; });
  return out;
}

function forgetDeletedEntries(payload) {
  var rows = deletedEntryRowsFor_(payload);
  if (!rows.length) return { forgotten: 0 };
  var key = {};
  rows.forEach(function (r) { key[String(r.batch_id) + '|' + String(r.entry_id)] = true; });
  deleteRowsWhere_('Deleted Entries', function (r) { return key[String(r.batch_id) + '|' + String(r.entry_id)] === true; });
  return { forgotten: rows.length };
}
