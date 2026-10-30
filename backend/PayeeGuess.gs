/**
 * "Same place, same treatment" (owner's request, 2026-10-29).
 *
 * Money keeps going to the same places: an investment platform's account, a person, a landlord. After the person has
 * confirmed a few of them the same way, the next one should not need the same fixing. Not AI and not a list kept by hand:
 * the history of confirmed entries is the memory, read with the same key CategoryFollow.gs already uses (`followKey_`:
 * the entry's `merchant` — the name the bank's e-mail gave, kept when the person renames the entry — or, for entries typed
 * by hand, its description). Nothing here writes a confirmed entry: an automatic entry still waits in Needs review
 * (CLAUDE.md §3.6); this only fills in its type, category and account to match what the person did before.
 *
 * A place's TREATMENT is what the person decided for one of its entries:
 *   - an expense under category X          'expense|<category>'
 *   - an investment deposit to platform P   'investment|<platform>'
 *   - a transfer to account A (or no account) 'transfer|<account>'
 *   - converted to a loan / repayment with friend F  'loan|<friend>|<direction>' / 'repayment|<friend>|<direction>'
 *     (the conversion replaces the entry, so each one is noted in the sheet "Payee Habits" — rememberPayeeHabit_)
 * A place is guessed once it has PAYEE_MIN_ENTRIES treatments and at least PAYEE_MIN_SHARE of them are the same one.
 * Pending entries never count (a guess must not reinforce itself); expenses with no category say nothing; withdrawals and
 * money received are not guessed (only money that LEFT: an expense or a transfer).
 *
 * A loan or repayment is only ever a SUGGESTION ("looks like a loan to Ana again"): it needs a friend and a debt check, so
 * the person confirms it with the usual Convert to loan / Mark as repayment button.
 */

var PAYEE_MIN_ENTRIES = 3;
var PAYEE_MIN_SHARE = 0.8;
// Same rule as the merchant guess: the evidence is spelled out for the first guesses only, then just the bare "auto".
var PAYEE_REASON_FIRST_TIMES_ = 3;

function ensurePayeeHabitsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Payee Habits')) return;
  var sheet = ss.insertSheet('Payee Habits');
  var headers = TABLE_DEFINITIONS['Payee Habits'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function payeeHabitRows_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee Habits') ? getAllRows('Payee Habits') : [];
}

/**
 * Called when an entry is converted into a loan or a repayment (convertEntryInto_): the conversion deletes the entry, so
 * this note is what remembers "this place was a loan with this friend". Never blocks the conversion.
 */
function rememberPayeeHabit_(entry, kind, payload) {
  try {
    var key = followKey_(entry);
    if (!key || !payload || !payload.friend_id) return;
    ensurePayeeHabitsSheet_();
    appendRowObject('Payee Habits', {
      key: key, kind: kind, friend_id: payload.friend_id, direction: payload.direction || '', created_at: nowTimestamp_()
    });
  } catch (err) {
    console.error('rememberPayeeHabit_: ' + err);
  }
}

// The treatment an existing entry stands for, or null when it says nothing (see the file comment).
function payeeTreatmentOf_(e) {
  if (e.type === 'expense') {
    return e.category_id ? { sig: 'expense|' + e.category_id, type: 'expense', categoryId: e.category_id } : null;
  }
  if (e.type === 'investment') {
    if (!e.to_payment_method_id || Number(e.amount) < 0) return null;
    return { sig: 'investment|' + e.to_payment_method_id, type: 'investment', platformId: e.to_payment_method_id };
  }
  if (e.type === 'transfer') {
    return { sig: 'transfer|' + (e.to_payment_method_id || ''), type: 'transfer', toId: e.to_payment_method_id || '' };
  }
  return null;
}

/**
 * key -> { total, sigs: { signature: { n, treatment } } }, from ONE pass over the confirmed / imported entries and the
 * loan habits. Read once per scan and reused for every waiting entry.
 */
function buildPayeeHistory_() {
  var hist = {};
  var add = function (key, treatment) {
    var h = hist[key] || (hist[key] = { total: 0, sigs: {} });
    var s = h.sigs[treatment.sig] || (h.sigs[treatment.sig] = { n: 0, treatment: treatment });
    s.n++;
    h.total++;
  };
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' && e.source !== 'import') return;
    var t = payeeTreatmentOf_(e);
    if (!t) return;
    var key = followKey_(e);
    if (key) add(key, t);
  });
  payeeHabitRows_().forEach(function (r) {
    if (!r.key || !r.friend_id) return;
    add(String(r.key), { sig: r.kind + '|' + r.friend_id + '|' + (r.direction || ''), type: r.kind, friendId: r.friend_id, direction: r.direction || '' });
  });
  return hist;
}

/**
 * What the history says about a place, or null. Returns { treatment, n, total, reason, quiet }; `reason` is the
 * evidence in words ("4 of 4 past "yape a ana lo" entries"), `quiet` once the place is familiar.
 */
function payeeGuessForKey_(key, hist) {
  var h = key && hist[key];
  if (!h || h.total < PAYEE_MIN_ENTRIES) return null;
  var best = null;
  Object.keys(h.sigs).forEach(function (sig) { if (!best || h.sigs[sig].n > h.sigs[best].n) best = sig; });
  if (h.sigs[best].n / h.total < PAYEE_MIN_SHARE) return null;
  return {
    treatment: h.sigs[best].treatment,
    n: h.sigs[best].n,
    total: h.total,
    reason: tr_('guess.history', { n: h.sigs[best].n, total: h.total, merchant: key }),
    quiet: h.total >= PAYEE_MIN_ENTRIES + PAYEE_REASON_FIRST_TIMES_
  };
}

// An account / platform / category the guess names must still exist and be usable for what it would fill in.
function payeeTreatmentUsable_(t, lookups) {
  if (t.type === 'expense') return !!(lookups.categories[t.categoryId] && lookups.categories[t.categoryId].type === 'expense' && String(lookups.categories[t.categoryId].hidden) !== 'true');
  if (t.type === 'investment') return !!(lookups.methods[t.platformId] && lookups.methods[t.platformId].type === 'investment' && String(lookups.methods[t.platformId].hidden) !== 'true');
  if (t.type === 'transfer') return !t.toId || !!lookups.methods[t.toId];
  return false;
}

function payeeLookups_() {
  return { categories: rowsById_(getAllRows('Categories')), methods: rowsById_(getAllRows('Payment Methods')) };
}

/**
 * For a NEW automatic entry (an e-mail's): rewrites its type, category and account to what the person did with this place
 * before, when that is clear. Only money that left (an expense or a transfer) is touched. A loan / repayment habit changes
 * nothing here (it is a suggestion shown on the Needs review card, payeeLoanHint_). Returns the guess used, or null.
 * `entry` is the row about to be saved; `hist`/`lookups` are shared across a whole scan.
 */
function applyPayeeGuessToNewEntry_(entry, hist, lookups) {
  if (entry.type !== 'expense' && entry.type !== 'transfer') return null;
  var guess = payeeGuessForKey_(followKey_(entry), hist);
  if (!guess || !payeeTreatmentUsable_(guess.treatment, lookups)) return null;
  var t = guess.treatment;
  if (t.type === 'investment') {
    if (!(Number(entry.amount) > 0)) return null;
    entry.type = 'investment';
    entry.category_id = defaultInvestmentCategoryId_();
    entry.to_payment_method_id = t.platformId;
    return guess;
  }
  if (t.type === 'expense') {
    // Only a category the entry lacks, or a transfer the person always files as an expense for this place.
    if (entry.type === 'expense' && entry.category_id) return null;
    entry.type = 'expense';
    entry.category_id = t.categoryId;
    return guess;
  }
  if (t.type === 'transfer') {
    if (entry.type === 'transfer') {
      if (t.toId && !entry.to_payment_method_id && t.toId !== entry.payment_method_id) {
        entry.to_payment_method_id = t.toId;
        return guess;
      }
      return null;
    }
    // A place the person always files as a transfer, arriving as an expense.
    if (t.toId && t.toId !== entry.payment_method_id) {
      entry.type = 'transfer';
      entry.category_id = transferCategoryId_();
      entry.to_payment_method_id = t.toId;
      return guess;
    }
  }
  return null;
}

/**
 * The "looks like a loan again" suggestion for a waiting entry, or null: { kind: 'loan'|'repayment', friend_id, direction,
 * reason }. Only for a waiting entry that is not already something else.
 */
function payeeLoanHint_(entry, hist) {
  if (entry.type === 'investment') return null;
  var guess = payeeGuessForKey_(followKey_(entry), hist);
  if (!guess) return null;
  var t = guess.treatment;
  if (t.type !== 'loan' && t.type !== 'repayment') return null;
  if (!getAllRows('Friends').some(function (f) { return f.id === t.friendId; })) return null;
  return { kind: t.type, friend_id: t.friendId, direction: t.direction, reason: guess.reason };
}

/**
 * For the new-entry form: what the description typed so far says (a place the person has put the same way before).
 * payload: { description }. Returns { type, category_id, to_payment_method_id, reason } or { loan: {...} } or {} .
 * Reads nothing it could change; money that arrived is not guessed.
 */
function suggestForDescription(payload) {
  var description = String((payload && payload.description) || '');
  var key = followKey_({ merchant: '', description: description });
  if (!key) return {};
  var guess = payeeGuessForKey_(key, buildPayeeHistory_());
  if (!guess) return {};
  var t = guess.treatment;
  if (t.type === 'loan' || t.type === 'repayment') {
    return getAllRows('Friends').some(function (f) { return f.id === t.friendId; })
      ? { loan: { kind: t.type, friend_id: t.friendId, direction: t.direction }, reason: guess.reason }
      : {};
  }
  if (!payeeTreatmentUsable_(t, payeeLookups_())) return {};
  if (t.type === 'expense') return { type: 'expense', category_id: t.categoryId, reason: guess.reason };
  if (t.type === 'investment') return { type: 'investment', to_payment_method_id: t.platformId, reason: guess.reason };
  return { type: 'transfer', to_payment_method_id: t.toId, reason: guess.reason };
}
