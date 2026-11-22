/**
 * First-use practice: "Bank statements" (docs/statements.js § First-use practice: Import from another app / Bank statements).
 *
 * Same idea as the Import practice (a made-up CSV built on the phone, run through the REAL screens and the REAL Undo), with one difference: a
 * bank statement is about ONE account, so the practice first adds an empty "Practice account" (no bank, no digits: nothing automatic can ever
 * reach it, see isPracticeAccount_ in Accounts.gs) for the file to belong to.
 *  - createPracticeBankAccount({ lang }) adds it. If an account with that name ALREADY exists (an earlier practice left it, or the person named one
 *    so) nothing is made and `existed` says so: the phone then does not start, and never deletes what it did not make.
 *  - removePracticeBank({ signature, account }) = removePracticeImport (undo any batch made only of practice entries, forget the made-up
 *    file's remembered layout) and, when `account` is true (the phone made it), removePracticeAccounts (the account and any pointer to it).
 */

/** Returns { id, existed }. */
function createPracticeBankAccount(payload) {
  return withScriptLockOnce_(function () {
    var existing = getAllRows('Payment Methods').filter(isPracticeAccount_)[0];
    if (existing) return { id: String(existing.id), existed: true };
    var es = String((payload && payload.lang) || '').toLowerCase().indexOf('es') === 0;
    var pm = addPaymentMethod({ nickname: es ? 'Cuenta de pr\u00e1ctica' : 'Practice account', type: 'debit' });
    bumpStructureVersion_();
    return { id: String(pm.id), existed: false };
  });
}

/** payload: { signature, account }. Returns { batches, entries, layouts, accounts }. */
function removePracticeBank(payload) {
  return withScriptLockOnce_(function () {
    var out = removePracticeImport(payload);   // (the lock is re-entrant: withScriptLockOnce_)
    out.accounts = 0;
    if (payload && payload.account) out.accounts = removePracticeAccounts({}).accounts || 0;
    return out;
  });
}
