/**
 * Phase 5 — shared expenses, loans, and settlements. Entry Splits records
 * who besides the owner had part of a shared expense; Loans tracks the
 * resulting debt with each friend. See CLAUDE.md's "Entry Splits" and
 * "Loans" sections for the underlying rules this follows.
 */

function getEntrySplits(entryId) {
  return getAllRows('Entry Splits')
    .filter(function (s) { return s.entry_id === entryId; })
    .map(function (s) { return { friend_id: s.friend_id, amount: Number(s.amount) }; });
}

// Replaces whatever splits/loans this entry previously had with the new
// set — the same "recalculate from scratch" approach an exchange-rate
// edit uses (see CLAUDE.md), so editing a split never leaves a stale
// split row or a stale loan behind. `splits` is [{friend_id, amount}];
// sending an empty array is how the frontend clears a split that was
// turned back off.
function saveEntrySplits(entryId, splits) {
  var entry = getEntryById_(entryId);
  if (!entry) throw new Error('Entry not found');

  deleteEntrySplitsAndLoansForEntry_(entryId);

  splits = (splits || []).filter(function (s) { return s.friend_id && Number(s.amount) > 0; });
  if (!splits.length) return { splits: [] };

  var splitsSheet = getSheet('Entry Splits');
  splits.forEach(function (s) {
    splitsSheet.appendRow([Utilities.getUuid(), entryId, s.friend_id, Number(s.amount)]);
  });

  var splitTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  var ownShare = Number(entry.amount) - splitTotal;

  if (entry.paid_by === 'me') {
    // Owner paid — every friend in the split owes the owner their share.
    splits.forEach(function (s) {
      createLoan_({
        friend_id: s.friend_id,
        direction: 'they_owe_me',
        origin: 'entry',
        entry_id: entryId,
        amount: Number(s.amount),
        currency: entry.currency,
        date: entry.date,
        description: entry.description || ''
      });
    });
  } else if (ownShare > 0.004) {
    // A friend paid — only that friend gets a loan, for the owner's own
    // remaining share. A second, non-paying friend in the split (a group
    // the payer covered) got a split row above for the math, but no loan
    // of their own — what they owe the payer is a debt between the two of
    // them, outside this app's scope (see CLAUDE.md's "Loan scope is
    // owner-centric").
    createLoan_({
      friend_id: entry.paid_by,
      direction: 'i_owe_them',
      origin: 'entry',
      entry_id: entryId,
      amount: ownShare,
      currency: entry.currency,
      date: entry.date,
      description: entry.description || ''
    });
  }

  return { splits: splits };
}

// Only ever touches loans THIS entry created (origin='entry' + matching
// entry_id) — never a standalone cash loan. A loan that already has a
// Settlement recorded against it is left alone rather than deleted, so a
// real repayment already made is never silently lost just because the
// entry it started from was edited or deleted; it simply stops being
// linked to that entry (its own row still holds the real debt/repayment
// history).
function deleteEntrySplitsAndLoansForEntry_(entryId) {
  deleteRowsWhere_('Entry Splits', function (row) { return row.entry_id === entryId; });

  var settledLoanIds = {};
  getAllRows('Settlements').forEach(function (s) { settledLoanIds[s.loan_id] = true; });
  deleteRowsWhere_('Loans', function (row) {
    return row.origin === 'entry' && row.entry_id === entryId && !settledLoanIds[row.id];
  });
}

function createLoan_(fields) {
  var loan = {
    id: Utilities.getUuid(),
    friend_id: fields.friend_id,
    direction: fields.direction,
    origin: fields.origin,
    entry_id: fields.entry_id || '',
    amount: fields.amount,
    currency: fields.currency,
    date: fields.date,
    due_date: fields.due_date || '',
    payment_method_id: fields.payment_method_id || '',
    description: fields.description || '',
    status: 'outstanding'
  };
  appendRowObject('Loans', loan);
  return loan;
}

// Generic "delete every row matching predicate" for a sheet with a header
// row — walks bottom-up so earlier row indexes stay valid as matching
// rows are removed further down.
function deleteRowsWhere_(sheetName, predicate) {
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = values[i][idx]; });
    if (predicate(obj)) sheet.deleteRow(i + 2);
  }
}

// ---- Loans screen (Phase 5.2) ----

function buildSettlementTotalsByLoan_() {
  var totals = {};
  getAllRows('Settlements').forEach(function (s) {
    totals[s.loan_id] = (totals[s.loan_id] || 0) + Number(s.amount);
  });
  return totals;
}

// One net figure per friend, for the Loans tab's "Owes you" / "You owe"
// lists. Loans keep their own original currency and are never re-converted
// on their own row (see CLAUDE.md) — but netting several loans together
// into one number needs a common unit whenever more than one currency is
// involved, so: if every one of a friend's still-outstanding loans shares
// a single currency, the net is that exact currency, no conversion at all;
// only a friend with a genuine currency mix falls back to PEN, via the
// same latest-rate-on-file fallback used everywhere else non-entry-saving
// FX math happens (see CLAUDE.md's general exchange-rate rule).
function listLoanBalances() {
  var loans = getAllRows('Loans').filter(function (l) { return l.status !== 'forgiven'; });
  var settledByLoan = buildSettlementTotalsByLoan_();
  var friendMap = {};
  getAllRows('Friends').forEach(function (f) { friendMap[f.id] = f.name; });

  // friend_id -> currency -> { theyOweMe, iOweThem } (native amounts,
  // remaining balance after settlements).
  var byFriendCurrency = {};
  loans.forEach(function (loan) {
    var remaining = Number(loan.amount) - (settledByLoan[loan.id] || 0);
    if (remaining <= 0.004) return;

    if (!byFriendCurrency[loan.friend_id]) byFriendCurrency[loan.friend_id] = {};
    var byCur = byFriendCurrency[loan.friend_id];
    if (!byCur[loan.currency]) byCur[loan.currency] = { theyOweMe: 0, iOweThem: 0 };
    if (loan.direction === 'they_owe_me') byCur[loan.currency].theyOweMe += remaining;
    else byCur[loan.currency].iOweThem += remaining;
  });

  var month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var result = [];

  Object.keys(byFriendCurrency).forEach(function (friendId) {
    var byCur = byFriendCurrency[friendId];
    // Only currencies where this friend still has a real, non-zero net —
    // a currency that happens to net to exactly 0 (fully offsetting loans
    // in both directions) doesn't count as "a currency this friend is
    // owed/owes in" for the single-vs-mixed decision below.
    var activeCurrencies = Object.keys(byCur).filter(function (cur) {
      return Math.abs(byCur[cur].theyOweMe - byCur[cur].iOweThem) > 0.004;
    });
    if (!activeCurrencies.length) return;

    var netPen = 0;
    var missingRateFor = null;
    activeCurrencies.forEach(function (cur) {
      var net = byCur[cur].theyOweMe - byCur[cur].iOweThem;
      var rate = cur === 'PEN' ? 1 : getLatestRateOnOrBefore_(cur, month);
      if (rate == null) { missingRateFor = cur; return; }
      netPen += net * rate;
    });

    var displayCurrency = null;
    var displayAmount = null;
    var needsRate = false;
    if (activeCurrencies.length === 1) {
      // No conversion needed at all — exact, regardless of whether a rate
      // is on file for this currency.
      var cur = activeCurrencies[0];
      displayCurrency = cur;
      displayAmount = byCur[cur].theyOweMe - byCur[cur].iOweThem;
    } else if (missingRateFor == null) {
      displayCurrency = 'PEN';
      displayAmount = netPen;
    } else {
      needsRate = true;
    }

    result.push({
      friend_id: friendId,
      friend_name: friendMap[friendId] || '(unknown friend)',
      net_pen: needsRate ? null : netPen,
      display_currency: displayCurrency,
      display_amount: displayAmount,
      needs_rate: needsRate
    });
  });

  return result;
}

// Full loan history for one friend — outstanding, settled, and forgiven —
// for the Loans tab's per-friend detail. Not filtered or netted; that's
// what listLoanBalances is for.
function getFriendLoanDetail(friendId) {
  var settledByLoan = buildSettlementTotalsByLoan_();
  var loans = getAllRows('Loans').filter(function (l) { return l.friend_id === friendId; });
  loans.forEach(function (loan) {
    loan.settled = settledByLoan[loan.id] || 0;
    loan.remaining = Number(loan.amount) - loan.settled;
  });
  loans.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return loans;
}
