/**
 * First-use practice: "Tidy my history" (docs/app.js § First-use practice: Tidy my history).
 *
 * Tidy only lists entries that have NO category, so the practice first makes some: ONE call (createPracticeTidy) adds three made-up,
 * confirmed expenses of one made-up place ("Practice coffee shop") in the main currency, dated today, with no category and no account.
 * The person then fills the group through the real Tidy screen (applyTidyGroups) and, if they like, the real Undo.
 * These entries must be SEEN by Tidy (so, unlike the Needs review practice, they do not carry source 'practice'); they are found again by
 * the marker in their external_id ('practice-tidy-…'), which the person cannot edit. One cleanup call (removePracticeTidy) deletes them,
 * whatever category they ended up with, and nothing else.
 * What stops them from reacting with anything real: their description is in PRACTICE_ENTRY_NAMES_ (a budget alert skips them), they have no
 * merchant / account (nothing is learned from a merchant), and nothing sends a message for a manual expense.
 * A real uncategorised group is never touched: the phone only taps the practice's own group, and applyTidyGroups acts on the keys it is given.
 */

var PRACTICE_TIDY_MARK_ = 'practice-tidy-';

function isPracticeTidy_(e) {
  return !!e && String(e.external_id || '').indexOf(PRACTICE_TIDY_MARK_) === 0;
}

function practiceTidyName_(lang) {
  return String(lang || '').toLowerCase().indexOf('es') === 0 ? 'Cafetería de práctica' : 'Practice coffee shop';
}

/**
 * payload: { lang: 'en' | 'es' }. Returns { ids: [three entry ids], name }. Always makes a fresh set (the phone cleans up before it asks again).
 */
function createPracticeTidy(payload) {
  return withScriptLockOnce_(function () {
    ensureEntriesMerchantColumn_();
    var name = practiceTidyName_(payload && payload.lang);
    var today = formatCalendarDate_(new Date());
    var ids = [];
    [6.5, 12, 8.5].forEach(function (amount) {
      var id = Utilities.getUuid();
      appendRowObject('Entries', {
        id: id, type: 'expense', date: today, amount: amount, currency: homeCurrency_(), category_id: '', description: name,
        payment_method_id: '', paid_by: 'me', status: 'confirmed', source: 'manual', external_id: PRACTICE_TIDY_MARK_ + id,
        import_batch_id: '', created_at: nowTimestamp_(), merchant: ''
      });
      ids.push(id);
    });
    return { ids: ids, name: name };
  });
}

/** Cleanup: deletes every entry the practice made (found by its marker), with whatever hangs on it (tags, splits). Returns { entries }. */
function removePracticeTidy() {
  return withScriptLockOnce_(function () {
    var removed = 0;
    getAllRows('Entries').forEach(function (e) {
      if (!isPracticeTidy_(e)) return;
      try { discardEntryWithRepayments_(e.id, 'cancel'); removed++; } catch (err) { /* it stays: the person can delete it by hand */ }
    });
    return { entries: removed };
  });
}
