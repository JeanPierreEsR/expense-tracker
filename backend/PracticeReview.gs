/**
 * First-use practice: "Needs review" (docs/app.js § First-use practice: Needs review).
 *
 * The practice makes the review queue real: ONE call (createPracticePending) puts two made-up waiting entries in "Needs review" -
 * "Practice purchase" (the person confirms it) and "Practice charge" (the person discards it) - the way a bank e-mail would. Both carry
 * source 'practice' and NO account, NO merchant, NO category and NO e-mail identity, so nothing else in the app reacts to them:
 *   - no Telegram card or message is sent (they are not made by the e-mail scan, the only place that sends cards);
 *   - nothing is learned from them: a confirm teaches the category guesser (CategoryGuess.gs), the "same place" memory (PayeeGuess.gs)
 *     and the look-alike filling (CategoryFollow.gs) from confirmed entries, so all three skip a practice entry;
 *   - no "Maybe yours?" / "Is this you?" name question (OwnerNames.gs), no suggested trip (it would link the entry to a real trip on
 *     Confirm), no statement matching candidate, no e-mail-overlap entry.
 * One cleanup call (removePracticeReview) deletes them, pending or confirmed, and nothing else.
 * Budget / trip alerts caused by the confirmed practice entry counting are handled by the practice-wide alert guard, not here.
 */

var PRACTICE_REVIEW_NAME_RE_ = /^(Practice purchase|Compra de práctica|Practice charge|Cargo de práctica)$/;
var PRACTICE_REVIEW_SOURCE_ = 'practice';

/** True for an entry that belongs to the Needs review practice (its source, or - if the source was lost - one of its names). */
function isPracticeReview_(e) {
  return !!e && (String(e.source || '') === PRACTICE_REVIEW_SOURCE_ || PRACTICE_REVIEW_NAME_RE_.test(String(e.description || '').trim()));
}

function practiceReviewNames_(lang) {
  return String(lang || '').toLowerCase().indexOf('es') === 0
    ? { purchase: 'Compra de práctica', charge: 'Cargo de práctica' }
    : { purchase: 'Practice purchase', charge: 'Practice charge' };
}

/**
 * payload: { lang: 'en' | 'es' }. Returns { purchase_id, charge_id } (both waiting in Needs review, dated today, in the main currency,
 * no category so the person has to choose one - exactly the case where an automatic entry could not guess).
 */
function createPracticePending(payload) {
  return withScriptLockOnce_(function () {
    ensureEntriesMerchantColumn_();
    var names = practiceReviewNames_(payload && payload.lang);
    var today = formatCalendarDate_(new Date());
    var make = function (description, amount) {
      var id = Utilities.getUuid();
      appendRowObject('Entries', {
        id: id, type: 'expense', date: today, amount: amount, currency: homeCurrency_(), category_id: '', description: description,
        payment_method_id: '', paid_by: 'me', status: 'pending', source: PRACTICE_REVIEW_SOURCE_, external_id: 'practice-' + id,
        import_batch_id: '', created_at: nowTimestamp_(), merchant: ''
      });
      return id;
    };
    return { purchase_id: make(names.purchase, 38.5), charge_id: make(names.charge, 12) };
  });
}

/**
 * Cleanup: deletes every practice entry (waiting or confirmed), with whatever hangs on it (tags, splits).
 * An entry made by the practice has source 'practice', which a rename or a confirm does not change. Only that counts: a real entry the
 * person happens to call "Practice purchase" is theirs (matching by name used to delete those too).
 * Returns { entries }.
 */
function removePracticeReview(payload) {
  return withScriptLockOnce_(function () {
    var removed = 0;
    getAllRows('Entries').forEach(function (e) {
      if (String(e.source || '') !== PRACTICE_REVIEW_SOURCE_) return;
      try { discardEntryWithRepayments_(e.id, 'cancel'); removed++; } catch (err) { /* it stays: the person can delete it by hand */ }
    });
    return { entries: removed };
  });
}
