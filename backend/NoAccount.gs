/**
 * Entries with no account (owner, 2026-11-10/11): More → My data → Tidy my history lists the person's own confirmed entries that have
 * no account yet, newest first, so each can get one; a statement then matches them on the right account and its balance adds up.
 *
 * Listed: confirmed expenses, income and investments with no account, and transfers with neither end (a repayment saved without one),
 * paid by the person. Not listed: what a friend paid (it never touched the person's accounts), an income "not received yet" (no
 * account until the money arrives), the made-up entries of a practice.
 * Saving only fills an account that is STILL empty (a second tap or another phone never overwrites one), and Undo empties only what
 * this save filled and nobody changed since.
 */
var NO_ACCOUNT_LIMIT_ = 150;
var NO_ACCOUNT_TYPES_ = { expense: true, income: true, investment: true, transfer: true };

function noAccountCandidate_(e) {
  if (e.status !== 'confirmed' || !NO_ACCOUNT_TYPES_[e.type]) return false;
  if (e.payment_method_id || e.to_payment_method_id) return false;
  if (e.paid_by && e.paid_by !== 'me') return false;
  if (incomeIsWaiting_(e) || isPracticeEntry_(e) || isPracticeReview_(e)) return false;
  return true;
}

/** payload: { limit }. Returns { total, shown, entries: [{ id, date, type, description, amount, currency }] } — newest first. */
function listNoAccountEntries(payload) {
  var limit = (payload && Number(payload.limit)) || NO_ACCOUNT_LIMIT_;
  var all = getAllRows('Entries').filter(noAccountCandidate_).sort(compareEntriesRecency_);
  return {
    total: all.length, shown: Math.min(limit, all.length),
    entries: all.slice(0, limit).map(function (e) {
      return { id: e.id, date: String(e.date).slice(0, 10), type: e.type, description: String(e.description || ''), amount: Number(e.amount), currency: e.currency || homeCurrency_() };
    })
  };
}

/**
 * payload: { items: [{ id, payment_method_id }] }. Fills only accounts that are still empty, in one column write.
 * Returns { count, changes: [{ id, payment_method_id }] } — what undoEntryAccounts takes back.
 */
function assignEntryAccounts(payload) {
  var items = (payload && payload.items) || [];
  var pms = {};
  getAllRows('Payment Methods').forEach(function (p) { pms[p.id] = p; });
  var want = {};
  items.forEach(function (it) {
    if (!it || !it.id || !it.payment_method_id) return;
    if (!pms[it.payment_method_id]) throw new Error(tr_('err.paymentMethodNotFound'));
    want[String(it.id)] = String(it.payment_method_id);
  });
  var done = setEntryAccountsColumn_(want, '');
  return { count: done.length, changes: done.map(function (id) { return { id: id, payment_method_id: want[id] }; }) };
}

/** payload: { changes: [{ id, payment_method_id }] }. Empties each account again, only where it still holds what was filled. */
function undoEntryAccounts(payload) {
  var want = {}, expect = {};
  ((payload && payload.changes) || []).forEach(function (c) { if (c && c.id) { want[String(c.id)] = ''; expect[String(c.id)] = String(c.payment_method_id || ''); } });
  return { reverted: setEntryAccountsColumn_(want, expect).length };
}

// want: id -> new account; expect: '' (only where empty now) or id -> the value it must hold now. Returns the ids changed.
function setEntryAccountsColumn_(want, expect) {
  if (!Object.keys(want).length) return [];
  var updatedCol = ensureEntriesUpdatedAtColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var idCol = headers.indexOf('id'), pmCol = headers.indexOf('payment_method_id'), toCol = headers.indexOf('to_payment_method_id');
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var pmsCol = sheet.getRange(2, pmCol + 1, lastRow - 1, 1).getValues();
  var tos = toCol === -1 ? null : sheet.getRange(2, toCol + 1, lastRow - 1, 1).getValues();
  var stamps = sheet.getRange(2, updatedCol, lastRow - 1, 1).getValues();
  var stamp = nowStamp_(), done = [];
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0]);
    if (!(id in want)) continue;
    var current = String(pmsCol[i][0] || '');
    if (expect === '') { if (current || (tos && String(tos[i][0] || ''))) continue; }
    else if (current !== expect[id]) continue;
    pmsCol[i][0] = want[id];
    stamps[i][0] = stamp;
    done.push(id);
  }
  if (!done.length) return [];
  sheet.getRange(2, pmCol + 1, pmsCol.length, 1).setValues(pmsCol);
  sheet.getRange(2, updatedCol, stamps.length, 1).setValues(stamps);
  bumpVersion_('ENTRIES_VERSION');
  return done;
}
