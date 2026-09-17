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
// an empty array is not just "nothing to split" — it's also how a
// friend-paid expense with the split toggle left off gets its loan: with
// no splits at all, own_share is the FULL amount (see below), so this
// still has to run the loan logic even when there's no Entry Splits row
// to write.
function saveEntrySplits(entryId, splits) {
  var entry = getEntryById_(entryId);
  if (!entry) throw new Error('Entry not found');

  deleteEntrySplitsAndLoansForEntry_(entryId);

  splits = (splits || []).filter(function (s) { return s.friend_id && Number(s.amount) > 0; });

  if (splits.length) {
    var splitsSheet = getSheet('Entry Splits');
    splits.forEach(function (s) {
      splitsSheet.appendRow([Utilities.getUuid(), entryId, s.friend_id, Number(s.amount)]);
    });
  }

  var splitTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  var ownShare = Number(entry.amount) - splitTotal;

  if (entry.paid_by === 'me') {
    // Owner paid — every friend in the split owes the owner their share.
    // Nothing to do here when splits is empty (a plain, fully-owned
    // expense — no one else involved).
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
    // remaining share. With no splits at all, that's the full amount: a
    // friend-paid expense the owner didn't explicitly split with anyone
    // else is 100% the owner's, by default — no separate split entry
    // needed just to say so. A second, non-paying friend in the split (a
    // group the payer covered) got a split row above for the math, but no
    // loan of their own — what they owe the payer is a debt between the
    // two of them, outside this app's scope (see CLAUDE.md's "Loan scope
    // is owner-centric").
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

// ---- Standalone cash loans (Phase 5.3) ----
// A loan not tied to any Entry — money lent/borrowed directly, added from
// the Loans tab's own "+ Add loan" button rather than from the entry form.

function addLoan(payload) {
  if (!payload.friend_id) throw new Error('Pick a friend.');
  if (payload.direction !== 'they_owe_me' && payload.direction !== 'i_owe_them') {
    throw new Error('Invalid direction.');
  }
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.date) throw new Error('Date is required.');

  return createLoan_({
    friend_id: payload.friend_id,
    direction: payload.direction,
    origin: 'cash',
    amount: Number(payload.amount),
    currency: payload.currency || 'PEN',
    date: payload.date,
    due_date: payload.due_date || '',
    payment_method_id: payload.payment_method_id || '',
    description: payload.description || ''
  });
}

// A cash loan's own fields can be edited directly; an entry-derived one
// (origin='entry') can't — its amount/currency/date/description all come
// from the expense it was split from, and saveEntrySplits already
// recalculates it from scratch on every save of that entry, so a direct
// edit here would just get silently overwritten the next time the entry
// is touched. Editing one of those means editing the expense itself.
function updateLoan(payload) {
  var existing = getAllRows('Loans').find(function (l) { return l.id === payload.id; });
  if (!existing) throw new Error('Loan not found');
  if (existing.origin !== 'cash') {
    throw new Error("This loan came from a shared expense — edit that entry instead.");
  }
  if (!payload.friend_id) throw new Error('Pick a friend.');
  if (payload.direction !== 'they_owe_me' && payload.direction !== 'i_owe_them') {
    throw new Error('Invalid direction.');
  }
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.date) throw new Error('Date is required.');

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Loan not found');

  ['friend_id', 'direction', 'amount', 'currency', 'date', 'due_date', 'payment_method_id', 'description'].forEach(function (field) {
    setCellByRow_(sheet, headers, rowIndex, field, payload[field] !== undefined ? payload[field] : '');
  });

  return getAllRows('Loans').find(function (l) { return l.id === payload.id; });
}

// Same origin='cash' restriction as updateLoan, above. Also refuses to
// delete a loan that already has a Settlement recorded against it — same
// reasoning as deleteEntrySplitsAndLoansForEntry_: a real repayment
// already made should never just disappear because the loan row it was
// against gets deleted.
function deleteLoan(loanId) {
  var loan = getAllRows('Loans').find(function (l) { return l.id === loanId; });
  if (!loan) return;
  if (loan.origin !== 'cash') {
    throw new Error("This loan came from a shared expense — delete that entry instead.");
  }
  var hasSettlement = getAllRows('Settlements').some(function (s) { return s.loan_id === loanId; });
  if (hasSettlement) {
    throw new Error("This loan has a repayment recorded against it and can't be deleted.");
  }

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, loanId);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);
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
