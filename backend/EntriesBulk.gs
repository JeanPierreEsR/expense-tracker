/**
 * Home → Edit: several entries at once (owner's request, 2026-11-03; stage 1 = delete).
 *
 * Deleting one entry has seven special cases (a loan's cash movement, a repayment and its extra, a forgiveness, an expense whose loans were repaid, one side of
 * a currency exchange, a shared expense). A bulk delete handles ONLY the plain ones, so the rest are kept, never half-undone, and named with the reason: the
 * person deletes those one by one, where the single flow asks the right question. A shared expense IS deleted (its split and the debt that came from it go with
 * it, as with the single delete), and the preview says how many friends' debts that touches.
 *
 *   previewEntriesDelete({ ids })  -> { items: [{ id, found, reason, shared }] }   reason '' = can be deleted here
 *   deleteEntries({ ids })         -> { deleted: [ids], kept: [{ id, reason }] }    judged again here: the phone's answer is never trusted
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
