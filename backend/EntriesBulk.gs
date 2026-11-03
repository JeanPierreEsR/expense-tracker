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
