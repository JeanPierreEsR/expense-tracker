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
