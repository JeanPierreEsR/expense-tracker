/**
 * First-use practice: "Recently deleted" (docs/app.js § First-use practice: Recently deleted).
 *
 * The person deletes TWO made-up entries together from Home (the real edit mode: tick, Delete), then opens More → My data → Recently deleted,
 * restores one and deletes the other for good. So the practice first makes the two entries: ONE call (createPracticeDeleted) adds two confirmed
 * expenses called "Practice snack" in the main currency, dated today, with no account. They are found again by the marker in their external_id
 * ('practice-deleted-…'), which the person cannot edit.
 * Cleanup = one call (removePracticeDeleted): it deletes whichever of the two is still on the books (the one the person restored, or both if the
 * practice was left midway) and drops every safety copy of them from the "Deleted Entries" tab (found by the same marker inside the copy), so no
 * practice batch is left in Recently deleted. Nothing else is touched.
 * What stops them from reacting with anything real: their description is in PRACTICE_ENTRY_NAMES_ (a budget alert skips them), they have no
 * merchant / account (nothing is learned from a merchant), and nothing sends a message for a manual expense.
 */

var PRACTICE_DELETED_MARK_ = 'practice-deleted-';

function isPracticeDeleted_(e) {
  return !!e && String(e.external_id || '').indexOf(PRACTICE_DELETED_MARK_) === 0;
}

function practiceDeletedName_(lang) {
  return String(lang || '').toLowerCase().indexOf('es') === 0 ? 'Merienda de práctica' : 'Practice snack';
}

/** payload: { lang: 'en' | 'es' }. Returns { ids: [two entry ids], name }. Always makes a fresh pair (the phone cleans up before it asks again). */
function createPracticeDeleted(payload) {
  return withScriptLockOnce_(function () {
    ensureEntriesMerchantColumn_();
    var name = practiceDeletedName_(payload && payload.lang);
    var today = formatCalendarDate_(new Date());
    var cat = '';
    getAllRows('Categories').some(function (c) {
      if (c.type === 'expense' && String(c.hidden || '') !== 'yes') { cat = String(c.id); return true; }
      return false;
    });
    var ids = [];
    [4.5, 9].forEach(function (amount) {
      var id = Utilities.getUuid();
      appendRowObject('Entries', {
        id: id, type: 'expense', date: today, amount: amount, currency: homeCurrency_(), category_id: cat, description: name,
        payment_method_id: '', paid_by: 'me', status: 'confirmed', source: 'manual', external_id: PRACTICE_DELETED_MARK_ + id,
        import_batch_id: '', created_at: nowTimestamp_(), merchant: ''
      });
      ids.push(id);
    });
    return { ids: ids, name: name };
  });
}

/** Cleanup. Returns { entries, copies }: entries deleted, safety copies dropped. */
function removePracticeDeleted() {
  return withScriptLockOnce_(function () {
    var removed = 0, copies = 0;
    getAllRows('Entries').forEach(function (e) {
      if (!isPracticeDeleted_(e)) return;
      try { discardEntryWithRepayments_(e.id, 'cancel'); removed++; } catch (err) { /* it stays: the person can delete it by hand */ }
    });
    ensureDeletedEntriesSheet_();
    var gone = {};
    getAllRows('Deleted Entries').forEach(function (r) {
      if (String(r.payload || '').indexOf('"external_id":"' + PRACTICE_DELETED_MARK_) !== -1) gone[String(r.batch_id) + '|' + String(r.entry_id)] = true;
    });
    if (Object.keys(gone).length) {
      deleteRowsWhere_('Deleted Entries', function (r) {
        if (gone[String(r.batch_id) + '|' + String(r.entry_id)] !== true) return false;
        copies++;
        return true;
      });
    }
    return { entries: removed, copies: copies };
  });
}
