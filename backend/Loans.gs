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

  // A loan that already has a repayment against it can't be deleted (that
  // would silently lose the repayment), so it is reused in place below
  // instead of being re-created — otherwise the friend would owe the old
  // loan AND a brand-new full one.
  splits = (splits || []).filter(function (s) { return s.friend_id && Number(s.amount) > 0; });
  var requestedTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  if (requestedTotal > Number(entry.amount) + 0.005) {
    throw new Error("The split (" + requestedTotal.toFixed(2) + ") is larger than the expense (" + Number(entry.amount).toFixed(2) + ").");
  }

  var reusable = settledEntryLoans_(entryId);
  deleteEntrySplitsAndLoansForEntry_(entryId, true);

  if (splits.length) {
    splits.forEach(function (s) {
      appendRowObject('Entry Splits', { id: Utilities.getUuid(), entry_id: entryId, friend_id: s.friend_id, amount: Number(s.amount) });
    });
  }

  var splitTotal = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  var ownShare = Number(entry.amount) - splitTotal;

  if (entry.paid_by === 'me') {
    // Owner paid — every friend in the split owes the owner their share.
    // Nothing to do here when splits is empty (a plain, fully-owned
    // expense — no one else involved).
    splits.forEach(function (s) {
      upsertEntryLoan_(reusable, {
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
    upsertEntryLoan_(reusable, {
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

  // Any repaid loan that no longer matches the new split (e.g. that friend
  // was removed from it) keeps its repayment history but stops being
  // linked to this entry.
  reusable.forEach(function (l) {
    if (!l.used) updateRowFields_('Loans', l.id, { entry_id: '' });
  });

  return { splits: splits };
}

// Loans this entry created that already have a Settlement recorded.
function settledEntryLoans_(entryId) {
  var settled = protectedLoanIds_();
  return getAllRows('Loans')
    .filter(function (l) { return l.origin === 'entry' && l.entry_id === entryId && settled[l.id]; })
    .map(function (l) { return { id: l.id, friend_id: l.friend_id, direction: l.direction, forgiven: l.status === 'forgiven', used: false }; });
}

// Loans that must never be deleted/re-created when their entry is edited:
// ones with a Settlement recorded, and forgiven ones (a forgiven loan has
// no Settlement, but deleting it would make the friend owe the money again
// while the forgiveness expense stayed booked).
function protectedLoanIds_() {
  var ids = {};
  getAllRows('Settlements').forEach(function (s) { ids[s.loan_id] = true; });
  getAllRows('Loans').forEach(function (l) { if (l.status === 'forgiven') ids[l.id] = true; });
  return ids;
}

// Updates a matching repaid loan (same friend + direction) to the new
// amount, or creates a fresh loan when there is none.
function upsertEntryLoan_(reusable, fields) {
  var match = reusable.find(function (l) {
    return !l.used && l.friend_id === fields.friend_id && l.direction === fields.direction;
  });
  if (!match) { createLoan_(fields); return; }
  match.used = true;
  // A forgiven loan keeps its amount: the forgiveness expense was booked
  // for that figure, and nothing is owed any more.
  if (match.forgiven) return;
  updateRowFields_('Loans', match.id, {
    amount: fields.amount,
    currency: fields.currency,
    date: fields.date,
    description: fields.description
  });
}

// Only ever touches loans THIS entry created (origin='entry' + matching
// entry_id) — never a standalone cash loan. A loan that already has a
// Settlement recorded against it is left alone rather than deleted, so a
// real repayment already made is never silently lost just because the
// entry it started from was edited or deleted; it simply stops being
// linked to that entry (its own row still holds the real debt/repayment
// history).
//
// `keepSettledLinked` is for saveEntrySplits, which reuses those repaid
// loans itself; every other caller (entry deleted, entry no longer
// shared) wants them unlinked, which is done here by clearing entry_id.
function deleteEntrySplitsAndLoansForEntry_(entryId, keepSettledLinked) {
  deleteRowsWhere_('Entry Splits', function (row) { return row.entry_id === entryId; });

  var settledLoanIds = protectedLoanIds_();
  deleteRowsWhere_('Loans', function (row) {
    return row.origin === 'entry' && row.entry_id === entryId && !settledLoanIds[row.id];
  });
  if (!keepSettledLinked) {
    getAllRows('Loans').forEach(function (l) {
      if (l.origin === 'entry' && l.entry_id === entryId && settledLoanIds[l.id]) {
        updateRowFields_('Loans', l.id, { entry_id: '' });
      }
    });
  }
}

// ---- Loan/repayment transfer entries (added 2026-09-23) ----
// Money moving between the owner and a friend is never an expense or
// income (principle 2) — but the owner still wants to SEE it happened,
// e.g. to reconcile against a bank/Yape statement. A `type: transfer`
// Entry already exists for exactly this shape of thing (money moving
// without being income/expense) and is already excluded from Overview's
// income/expense/investment totals, so reusing it here needs no changes
// to Reporting at all. Scoped to `cash`-origin loans and real (non-
// offset) settlements only — an `entry`-origin loan (from a shared
// expense) already has a real Entry behind it, the expense itself, so a
// second one would just duplicate it in Recent entries; an offset
// settlement (see recordRepayment, below) represents no real money
// movement at all, so there's nothing to reconcile.

function transferCategoryId_() {
  var cat = getAllRows('Categories').find(function (c) { return c.type === 'transfer'; });
  return cat ? cat.id : '';
}

// Self-healing, same pattern as the column below: links a forgiven loan to
// the expense/income entry its forgiveness booked.
function ensureLoansForgivenessEntryColumn_() {
  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  if (headers.indexOf('forgiveness_entry_id') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('forgiveness_entry_id');
  }
}

function ensureLoansTransferEntryColumn_() {
  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  if (headers.indexOf('transfer_entry_id') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('transfer_entry_id');
  }
}

function ensureSettlementsTransferEntryColumn_() {
  var sheet = getSheet('Settlements');
  var headers = getHeaders(sheet);
  if (headers.indexOf('transfer_entry_id') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('transfer_entry_id');
  }
}

function createTransferEntry_(fields) {
  var entry = {
    id: Utilities.getUuid(),
    type: 'transfer',
    date: fields.date,
    amount: Number(fields.amount),
    currency: fields.currency,
    category_id: transferCategoryId_(),
    description: fields.description,
    payment_method_id: fields.payment_method_id || '',
    paid_by: 'me',
    status: 'confirmed',
    source: 'manual',
    external_id: '',
    import_batch_id: '',
    created_at: nowTimestamp_()
  };
  appendRowObject('Entries', entry);
  return entry;
}

function createLoanTransferEntry_(loan, friendName) {
  return createTransferEntry_({
    date: loan.date,
    amount: loan.amount,
    currency: loan.currency,
    payment_method_id: loan.payment_method_id,
    description: loan.description || (loan.direction === 'they_owe_me'
      ? 'Loan to ' + friendName
      : 'Loan from ' + friendName)
  });
}

// Keeps a cash loan's linked transfer Entry matching the loan's own
// fields after a direct edit (updateLoan, below) — same "never let a
// derived record silently disagree with its source" principle as
// updateLoanStatusFromSettlements_.
function syncLoanTransferEntry_(loan, friendName) {
  if (!loan.transfer_entry_id) return;
  var entry = getEntryById_(loan.transfer_entry_id);
  if (!entry) return;
  setEntryField_(entry.id, 'date', loan.date);
  setEntryField_(entry.id, 'amount', Number(loan.amount));
  setEntryField_(entry.id, 'currency', loan.currency);
  setEntryField_(entry.id, 'payment_method_id', loan.payment_method_id || '');
  setEntryField_(entry.id, 'description', loan.description || (loan.direction === 'they_owe_me'
    ? 'Loan to ' + friendName
    : 'Loan from ' + friendName));
}

function createLoan_(fields) {
  ensureLoansTransferEntryColumn_();
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
    status: 'outstanding',
    transfer_entry_id: ''
  };
  if (fields.origin === 'cash') {
    var friend = getAllRows('Friends').find(function (f) { return f.id === fields.friend_id; });
    var transferEntry = createLoanTransferEntry_(loan, friend ? friend.name : '(unknown friend)');
    loan.transfer_entry_id = transferEntry.id;
  }
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
  var deleted = [];
  var tz = Session.getScriptTimeZone();
  for (var i = values.length - 1; i >= 0; i--) {
    var obj = {};
    // Same Date -> text normalisation getAllRows does, so a predicate sees
    // "2026-10", not a Sheets Date, for a date-like column.
    headers.forEach(function (h, idx) {
      var v = values[i][idx];
      obj[h] = (v instanceof Date && DATE_FIELD_FORMATS[h]) ? Utilities.formatDate(v, tz, DATE_FIELD_FORMATS[h]) : v;
    });
    if (predicate(obj)) { sheet.deleteRow(i + 2); deleted.push(obj); }
  }
  if (ROWS_MEMO_) delete ROWS_MEMO_[sheetName];
  noteRowsDeleted_(sheetName, deleted);   // change tracking — see DataVersion.gs
}

// ---- Standalone cash loans (Phase 5.3) ----
// A loan not tied to any Entry — money lent/borrowed directly, added from
// the Loans tab's own "+ Add loan" button rather than from the entry form.

// A due date stays genuinely optional to type in (see the Add loan
// form) — but a loan with no due date at all can never trigger an
// overdue reminder (Phase 5.6), and in practice almost nobody types one
// in every time. So a standalone cash loan registered with none
// specified defaults to a week out from its own date, giving overdue
// tracking something to work with automatically. Deliberately scoped to
// this one entry point — a shared-expense loan from the split-entry UI
// (saveEntrySplits, which also calls createLoan_) is a much more common,
// often casual case ("Ana owes me for dinner") that this default would
// otherwise turn into a stream of unwanted overdue alerts a week later;
// createLoan_ itself still leaves due_date genuinely blank when none is
// given.
function defaultLoanDueDate_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

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
    due_date: payload.due_date || defaultLoanDueDate_(payload.date),
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

  var settledSoFar = getAllRows('Settlements')
    .filter(function (s) { return s.loan_id === payload.id; })
    .reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  if (settledSoFar > 0.004) {
    // Repayments are already recorded against this loan: changing who, which
    // currency, which direction, or an amount below what's repaid would
    // silently break its balance. Description/date/due date stay editable.
    if (payload.friend_id !== existing.friend_id || payload.direction !== existing.direction ||
        (payload.currency || 'PEN') !== existing.currency) {
      throw new Error("This loan already has a repayment recorded — you can't change its friend, direction or currency.");
    }
    if (Number(payload.amount) < settledSoFar - 0.004) {
      throw new Error("This loan already has " + settledSoFar.toFixed(2) + " in repayments — the amount can't be lower than that.");
    }
  }

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Loan not found');

  ['friend_id', 'direction', 'amount', 'currency', 'date', 'due_date', 'payment_method_id', 'description'].forEach(function (field) {
    setCellByRow_(sheet, headers, rowIndex, field, payload[field] !== undefined ? payload[field] : '');
  });

  var updated = getAllRows('Loans').find(function (l) { return l.id === payload.id; });
  var friend = getAllRows('Friends').find(function (f) { return f.id === updated.friend_id; });
  syncLoanTransferEntry_(updated, friend ? friend.name : '(unknown friend)');
  return updated;
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

  if (loan.transfer_entry_id) {
    deleteEntry_(loan.transfer_entry_id);
  }

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, loanId);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);
}

// ---- Settlements / repayments (Phase 5.4, consolidated 2026-09-17) ----
// A Settlement is a repayment against a loan, in either direction —
// never an Entry, never counted in income/expense totals or budgets (per
// CLAUDE.md's Settlements section). Applies equally to a cash loan and an
// entry-derived one; only editing/deleting the LOAN itself is restricted
// by origin (see updateLoan/deleteLoan, above) — a repayment against it
// is a separate row in its own table either way.
//
// Recording a repayment is friend-+-currency-level, not single-loan: see
// recordRepayment, below, for the two-phase FIFO engine (net opposite-
// direction debt first, then apply the real amount) that replaced the
// original "pick one loan, settle it" design.

function ensureSettlementsOffsetColumn_() {
  var sheet = getSheet('Settlements');
  var headers = getHeaders(sheet);
  if (headers.indexOf('offset_loan_id') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('offset_loan_id');
  }
}

// Keeps the Loan row's own `status` column in sync after any settlement
// change — nothing in this app's own logic actually reads it for
// outstanding/partial/repaid (remaining is always computed fresh from
// amount minus settlements, same as own_share never being stored), but
// the Sheet is meant to stay readable by hand, and `status` sitting there
// unrepaid-forever while real repayments exist elsewhere would be
// misleading. Left alone entirely for a loan already 'forgiven' — that's
// a manual, one-way state (see Loans' `status` column), not something a
// repayment should ever revert.
function updateLoanStatusFromSettlements_(loanId) {
  var loan = getAllRows('Loans').find(function (l) { return l.id === loanId; });
  if (!loan || loan.status === 'forgiven') return;

  var settled = getAllRows('Settlements')
    .filter(function (s) { return s.loan_id === loanId; })
    .reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  var remaining = Number(loan.amount) - settled;
  var status = remaining <= 0.004 ? 'repaid' : (settled > 0.004 ? 'partially_repaid' : 'outstanding');

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, loanId);
  if (rowIndex !== -1) setCellByRow_(sheet, headers, rowIndex, 'status', status);
}

function recordSettlementRow_(loanId, date, amount, paymentMethodId, offsetLoanId, transferEntryId) {
  appendRowObject('Settlements', {
    id: Utilities.getUuid(),
    loan_id: loanId,
    date: date,
    amount: amount,
    payment_method_id: paymentMethodId || '',
    offset_loan_id: offsetLoanId || '',
    transfer_entry_id: transferEntryId || ''
  });
}

// Recomputes a repayment's linked transfer Entry's amount as the sum of
// whichever real settlement rows still reference it — several rows from
// one recordRepayment call (FIFO across more than one loan) can share a
// single transfer_entry_id, since from the owner's perspective it was
// one real payment, so editing/deleting any one of them (updateSettlement/
// deleteSettlement, below) has to re-total the group rather than just
// touch that one row's own share. Removes the entry entirely once
// nothing real is left backing it, rather than leaving a phantom PEN 0.00
// transaction sitting in Recent entries. Deliberately only syncs the
// AMOUNT, never date/description/payment_method — those started out
// identical across every row in the group (one call, one payload), and
// with no single correct owner once they diverge, leaving them alone
// (editable by hand on the Entry itself, same as any other entry) beats
// guessing which row's edit should win.
function recalculateRepaymentTransferEntry_(transferEntryId) {
  if (!transferEntryId) return;
  var total = getAllRows('Settlements')
    .filter(function (s) { return s.transfer_entry_id === transferEntryId; })
    .reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  if (total <= 0.004) {
    deleteEntry_(transferEntryId);
  } else {
    setEntryField_(transferEntryId, 'amount', total);
  }
}

// The core of "record a repayment": friend + currency + direction +
// amount — never a single loan. `direction` is which debt is being paid
// down: 'they_owe_me' (they're paying you) or 'i_owe_them' (you're
// paying them).
//
// Phase 1 nets opposite-direction debt first, before any real money is
// applied — e.g. a loan they gave YOU cancels against the oldest
// expenses you covered for THEM, oldest-first on both sides, dollar for
// dollar. Every loan touched this way gets a real Settlement row on BOTH
// sides of the pair, each referencing the other via offset_loan_id, so
// the Sheet always explains why a balance moved even though no cash did.
//
// Phase 2 applies the actual amount being recorded, FIFO, to whatever's
// left in the direction being paid down. Any amount still left over once
// every loan in that direction is fully paid is returned as `overpaid` —
// the caller decides what that means (see createOverpaymentEntry_,
// below): income to the owner when direction is 'they_owe_me' (someone
// paid the owner more than they owed), or an expense of the owner's own
// when direction is 'i_owe_them' (the owner paid someone more than was
// owed) — mirror images of the same idea: money that moved beyond any
// real debt isn't a loan repayment at all, it's a real transaction in
// its own right, and whoever received it is the one who has to account
// for it.
function recordRepayment(payload) {
  var friend = getAllRows('Friends').find(function (f) { return f.id === payload.friend_id; });
  if (!friend) throw new Error('Friend not found');
  if (payload.direction !== 'they_owe_me' && payload.direction !== 'i_owe_them') {
    throw new Error('Invalid direction.');
  }
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.date) throw new Error('Date is required.');
  var currency = payload.currency || 'PEN';

  ensureSettlementsOffsetColumn_();
  ensureSettlementsTransferEntryColumn_();

  var settledByLoan = buildSettlementTotalsByLoan_();
  var active = getAllRows('Loans')
    .filter(function (l) {
      return l.friend_id === payload.friend_id && l.currency === currency && l.status !== 'forgiven';
    })
    .map(function (l) {
      l.remaining = Number(l.amount) - (settledByLoan[l.id] || 0);
      return l;
    })
    .filter(function (l) { return l.remaining > 0.004; });

  function byDateAsc(a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); }
  var theyOweMe = active.filter(function (l) { return l.direction === 'they_owe_me'; }).sort(byDateAsc);
  var iOweThem = active.filter(function (l) { return l.direction === 'i_owe_them'; }).sort(byDateAsc);

  var primary = payload.direction === 'they_owe_me' ? theyOweMe : iOweThem;
  var secondary = payload.direction === 'they_owe_me' ? iOweThem : theyOweMe;

  // Phase 1 — offset opposite-direction debt first, oldest-first on both
  // sides.
  var primaryLeft = primary.map(function (l) { return l.remaining; });
  var secondaryLeft = secondary.map(function (l) { return l.remaining; });
  var touchedLoanIds = {};
  var pi = 0, si = 0;
  while (pi < primary.length && si < secondary.length) {
    var chunk = Math.min(primaryLeft[pi], secondaryLeft[si]);
    if (chunk > 0.004) {
      recordSettlementRow_(primary[pi].id, payload.date, chunk, '', secondary[si].id);
      recordSettlementRow_(secondary[si].id, payload.date, chunk, '', primary[pi].id);
      primaryLeft[pi] -= chunk;
      secondaryLeft[si] -= chunk;
      touchedLoanIds[primary[pi].id] = true;
      touchedLoanIds[secondary[si].id] = true;
    }
    if (primaryLeft[pi] <= 0.004) pi++;
    if (secondaryLeft[si] <= 0.004) si++;
  }

  // How much of payload.amount phase 2 will actually apply — knowable
  // now, before running it, as min(what's being paid, what's left to pay
  // it against). Used to create ONE transfer Entry for the real money
  // moving in this call (see createTransferEntry_) — skipped entirely
  // when that figure is ~0, since then either nothing was owed in this
  // direction at all (nothing real happened here — see `overpaid` below,
  // which the caller turns into its own income/expense Entry instead) or
  // this call was pure phase-1 offsetting (no real money moved either).
  var primaryRemainingAfterPhase1 = 0;
  for (var pri = pi; pri < primaryLeft.length; pri++) primaryRemainingAfterPhase1 += primaryLeft[pri];
  var appliedAmount = Math.min(Number(payload.amount), primaryRemainingAfterPhase1);
  var transferEntryId = '';
  if (appliedAmount > 0.004) {
    var repaymentTransferEntry = createTransferEntry_({
      date: payload.date,
      amount: appliedAmount,
      currency: currency,
      payment_method_id: payload.payment_method_id,
      description: payload.description || (payload.direction === 'they_owe_me'
        ? 'Repayment from ' + friend.name
        : 'Repayment to ' + friend.name)
    });
    transferEntryId = repaymentTransferEntry.id;
  }

  // Phase 2 — apply the real amount, FIFO, continuing from wherever
  // phase 1 left off.
  var cashLeft = Number(payload.amount);
  while (cashLeft > 0.004 && pi < primary.length) {
    var loan = primary[pi];
    var applyAmt = Math.min(cashLeft, primaryLeft[pi]);
    if (applyAmt > 0.004) {
      recordSettlementRow_(loan.id, payload.date, applyAmt, payload.payment_method_id || '', '', transferEntryId);
      primaryLeft[pi] -= applyAmt;
      cashLeft -= applyAmt;
      touchedLoanIds[loan.id] = true;
    }
    if (primaryLeft[pi] <= 0.004) pi++;
  }

  Object.keys(touchedLoanIds).forEach(updateLoanStatusFromSettlements_);

  // Whatever is left once nothing more is owed is real money and must never be
  // lost, so it is recorded HERE, in the same request as the repayment —
  // confirmed when the caller already has a category (overpay_category_id),
  // otherwise as a PENDING entry in the review queue to categorise later. It
  // used to depend on a second screen the owner could simply close.
  var overpaid = cashLeft > 0.004 ? cashLeft : 0;
  var overpaymentEntry = null;
  if (overpaid > 0) {
    overpaymentEntry = createOverpaymentEntry_(payload.direction === 'they_owe_me' ? 'income' : 'expense', {
      friend_id: payload.friend_id,
      amount: Math.round(overpaid * 100) / 100,
      currency: currency,
      date: payload.date,
      payment_method_id: payload.payment_method_id,
      category_id: payload.overpay_category_id || '',
      pending: !payload.overpay_category_id
    });
  }

  return { overpaid: overpaid, currency: currency, overpayment_entry: overpaymentEntry };
}

// The leftover from recordRepayment, above, once nothing more is owed —
// not a loan repayment at all at that point, a real transaction in its
// own right, so it becomes a real confirmed Entry (per principle 6, this
// is a direct result of the owner's own manual action, same reasoning as
// forgiving a loan converting to an expense directly — it doesn't land
// in the pending review queue). `type` is 'income' (someone paid the
// owner more than they owed) or 'expense' (the owner paid someone more
// than was owed) — mirror images, see recordRepayment above.
//
// An income entry needs a Payor, not a Friend (see Payors.gs) — reuses
// one matching the friend's name if it already exists, creates one if
// not, so the entry looks like any other income entry rather than
// leaving "Received from" unresolvable. An expense entry just uses
// `paid_by: 'me'` — the owner paid it themselves, out of pocket, same as
// any other plain expense; it's deliberately NOT split with the friend
// (this money already isn't a debt with them, by definition — it's what
// was left over once every debt was gone).
//
// `payload.pending` (set by recordRepayment when the caller gave no category)
// creates the entry as PENDING with no category, to be categorised from the
// review queue. A later non-pending call with the same figures (the app's
// "pick a category" step, which still calls recordOverpaymentIncome/Expense)
// COMPLETES that pending entry instead of adding a second one.
function createOverpaymentEntry_(type, payload) {
  if (!payload.friend_id) throw new Error('Missing friend.');
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.pending && !payload.category_id) throw new Error('Pick a category.');
  if (!payload.date) throw new Error('Date is required.');

  var friend = getAllRows('Friends').find(function (f) { return f.id === payload.friend_id; });
  if (!friend) throw new Error('Friend not found');

  var description = payload.description || (type === 'income'
    ? "Overpayment from " + friend.name + "'s loan repayment"
    : "Overpayment to " + friend.name + "'s loan repayment");
  var amount = Number(payload.amount);
  var currency = payload.currency || 'PEN';

  if (!payload.pending) {
    var waiting = getAllRows('Entries').find(function (e) {
      return e.status === 'pending' && e.source === 'manual' && e.type === type && e.description === description &&
        e.currency === currency && e.date === payload.date && Math.abs(Number(e.amount) - amount) < 0.005;
    });
    if (waiting) {
      updateEntryFields(waiting.id, {
        category_id: payload.category_id,
        payment_method_id: payload.payment_method_id || waiting.payment_method_id || '',
        status: 'confirmed'
      });
      return getEntryById_(waiting.id);
    }
  }

  var entry = {
    id: Utilities.getUuid(),
    type: type,
    date: payload.date,
    amount: amount,
    currency: currency,
    category_id: payload.pending ? '' : payload.category_id,
    description: description,
    payment_method_id: payload.payment_method_id || '',
    paid_by: type === 'income' ? findOrCreatePayorByName_(friend.name).id : 'me',
    status: payload.pending ? 'pending' : 'confirmed',
    source: 'manual',
    external_id: '',
    import_batch_id: '',
    created_at: nowTimestamp_()
  };
  appendRowObject('Entries', entry);
  return entry;
}

function recordOverpaymentIncome(payload) {
  return createOverpaymentEntry_('income', payload);
}

function recordOverpaymentExpense(payload) {
  return createOverpaymentEntry_('expense', payload);
}

// "I saved this as an expense / plain transfer, but it was really a
// repayment" — one call that does the whole swap safely (see CHANGELOG.md,
// 2026-10-01). Order matters: the old entry (and the loan it made) must be
// gone BEFORE the repayment is worked out, or FIFO would settle that loan
// and the loan could then never be deleted. Because that makes the delete
// come first, everything that could be refused is checked up front, a
// snapshot of what's about to be deleted is taken, and if anything fails
// after the delete the snapshot is put back and the repayment's partial
// rows are removed — so the owner never ends up with the original lost
// and no repayment either.
//
// Refused (nothing touched) when the entry is:
// - not an expense or a plain transfer;
// - a transfer already linked to a loan or repayment (it IS the money
//   movement of one — converting it would count that payment twice);
// - an expense whose debt already has repayments recorded against it.
function convertEntryToRepayment(payload) {
  return withScriptLockOnce_(function () { return convertEntryInto_(payload, 'repayment'); });
}

// Same swap, but the entry becomes a NEW LOAN with a friend ("this transfer
// was really me lending / borrowing") — payload as addLoan plus entry_id.
// direction here is the loan's: 'they_owe_me' = the owner lent the money.
function convertEntryToLoan(payload) {
  return withScriptLockOnce_(function () { return convertEntryInto_(payload, 'loan'); });
}

// May already be inside routeActionOnce_'s lock (same execution) — only
// take and release it here when nobody up the stack has.
function withScriptLockOnce_(fn) {
  var lock = LockService.getScriptLock();
  var ownsLock = !lock.hasLock();
  if (ownsLock) lock.waitLock(20000);
  try {
    return fn();
  } finally {
    if (ownsLock) lock.releaseLock();
  }
}

// kind: 'repayment' | 'loan'.
function convertEntryInto_(payload, kind) {
  var label = kind === 'loan' ? 'a loan' : 'a repayment';
  var entry = getEntryById_(payload.entry_id);
  if (!entry) throw new Error('That entry no longer exists — it may already have been converted.');
  if (entry.type !== 'expense' && entry.type !== 'transfer') {
    throw new Error('Only an expense or a transfer can be turned into ' + label + '.');
  }
  if (payload.direction !== 'they_owe_me' && payload.direction !== 'i_owe_them') throw new Error('Invalid direction.');
  if (!getAllRows('Friends').some(function (f) { return f.id === payload.friend_id; })) throw new Error('Friend not found');
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.date) throw new Error('Date is required.');
  if (kind === 'repayment' && !payload.overpay_category_id) throw new Error('Pick a category for any extra amount.');

  ensureLoansTransferEntryColumn_();
  ensureSettlementsTransferEntryColumn_();
  var settlementsBefore = getAllRows('Settlements');
  var loansBefore = getAllRows('Loans');

  if (entry.type === 'transfer') {
    var linked = settlementsBefore.some(function (s) { return s.transfer_entry_id === entry.id; }) ||
      loansBefore.some(function (l) { return l.transfer_entry_id === entry.id; });
    if (linked) {
      throw new Error("This transfer is already the money movement of a loan or repayment — change it from the Loans tab instead.");
    }
  }

  var ownLoans = loansBefore.filter(function (l) { return l.origin === 'entry' && l.entry_id === entry.id; });
  var ownLoanIds = {};
  ownLoans.forEach(function (l) { ownLoanIds[l.id] = true; });
  if (settlementsBefore.some(function (s) { return ownLoanIds[s.loan_id]; })) {
    throw new Error("The debt this expense created already has repayments recorded against it — sort those out from the Loans tab first.");
  }

  // Snapshot, then delete.
  var snapshot = {
    entry: entry,
    splits: getAllRows('Entry Splits').filter(function (r) { return r.entry_id === entry.id; }),
    tags: getAllRows('Entry Tags').filter(function (r) { return r.entry_id === entry.id; }),
    loans: ownLoans
  };
  var settlementIdsBefore = {};
  settlementsBefore.forEach(function (s) { settlementIdsBefore[s.id] = true; });
  var loanIdsBefore = {};
  loansBefore.forEach(function (l) { loanIdsBefore[l.id] = true; });
  var entryIdsBefore = {};
  getAllRows('Entries').forEach(function (e) { entryIdsBefore[e.id] = true; });

  deleteEntry_(entry.id);

  try {
    if (kind === 'loan') {
      var loan = addLoan({
        friend_id: payload.friend_id,
        direction: payload.direction,
        amount: payload.amount,
        currency: payload.currency,
        date: payload.date,
        due_date: payload.due_date,
        payment_method_id: payload.payment_method_id,
        description: payload.description
      });
      return { loan: loan };
    }
    var result = recordRepayment({
      friend_id: payload.friend_id,
      direction: payload.direction,
      amount: payload.amount,
      currency: payload.currency,
      date: payload.date,
      payment_method_id: payload.payment_method_id,
      description: payload.description,
      overpay_category_id: payload.overpay_category_id   // recordRepayment books the extra itself
    });
    return { overpaid: result.overpaid, currency: result.currency, overpayment_entry: result.overpayment_entry };
  } catch (err) {
    // Undo: remove whatever was written, put the original back exactly as
    // it was.
    try {
      deleteRowsWhere_('Settlements', function (r) { return !settlementIdsBefore[r.id]; });
      deleteRowsWhere_('Loans', function (r) { return !loanIdsBefore[r.id]; });
      getAllRows('Entries').forEach(function (e) {
        if (!entryIdsBefore[e.id]) deleteEntry_(e.id);
      });
      appendRowObject('Entries', snapshot.entry);
      snapshot.splits.forEach(function (r) { appendRowObject('Entry Splits', r); });
      snapshot.tags.forEach(function (r) { appendRowObject('Entry Tags', r); });
      snapshot.loans.forEach(function (r) { appendRowObject('Loans', r); });
      getAllRows('Loans').filter(function (l) { return l.friend_id === payload.friend_id; })
        .forEach(function (l) { updateLoanStatusFromSettlements_(l.id); });
    } catch (undoErr) {
      throw new Error('Something went wrong AND putting the original back failed — entry "' +
        (snapshot.entry.description || snapshot.entry.id) + '" (' + snapshot.entry.date + ', ' +
        snapshot.entry.amount + ') needs re-entering. ' + err.message);
    }
    throw new Error('Nothing was changed — ' + err.message);
  }
}

// ---- Retrospective "from X to Y" descriptions for transfers (2026-10-02) ----
// The Entries form now fills this in for NEW plain transfers; this does the
// same for existing ones, on demand from the Sheet menu (item 21), after a
// preview. Plain = confirmed, not a repayment/loan's money movement (those
// name the friend), with both a From and a To account. Account NAMES only —
// never the last-4 digits, and a trailing "(1234)" inside a nickname is
// dropped too. Empty descriptions are the safe default; replacing text the
// owner or an email already put there is a separate, explicit choice.
function planTransferDescriptions_() {
  var pmById = rowsById_(getAllRows('Payment Methods'));
  var links = buildTransferLinkMap_();
  var nameOf = function (id) {
    var pm = pmById[id];
    return pm ? String(pm.nickname).replace(/\s*\(\s*\d+\s*\)\s*$/, '') : '';
  };
  var blank = [], filled = [];
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'transfer' || e.status !== 'confirmed' || links[e.id]) return;
    var from = nameOf(e.payment_method_id), to = nameOf(e.to_payment_method_id);
    if (!from || !to) return;
    var text = 'from ' + from + ' to ' + to;
    var current = String(e.description || '').trim();
    if (current === text) return;
    (current === '' ? blank : filled).push({ id: e.id, text: text, old: current, date: e.date });
  });
  return { blank: blank, filled: filled };
}

function applyTransferDescriptions_(items) {
  withWriteBatch_(function () {
    items.forEach(function (i) { setEntryField_(i.id, 'description', i.text); });
  });
  return items.length;
}

// Sheet menu item 21: shows what would change and only changes anything
// after a choice.
function menuFillTransferDescriptions() {
  var ui = SpreadsheetApp.getUi();
  var plan = planTransferDescriptions_();
  if (!plan.blank.length && !plan.filled.length) {
    ui.alert('Nothing to do — every plain transfer between your own accounts already has its "from X to Y" description.');
    return;
  }
  var sample = plan.filled.slice(0, 5).map(function (i) { return '  "' + i.old + '" → "' + i.text + '"'; }).join('\n');
  var msg = plan.blank.length + ' transfers have no description.\n' +
    plan.filled.length + ' have one already' + (sample ? ', e.g.:\n' + sample : '.') + '\n\n' +
    'YES = fill only the ' + plan.blank.length + ' empty ones (safe).\n' +
    'NO = also REPLACE the ' + plan.filled.length + ' existing descriptions.\n' +
    'CANCEL = do nothing.';
  var answer = ui.alert('Fill transfer descriptions', msg, ui.ButtonSet.YES_NO_CANCEL);
  var items = answer === ui.Button.YES ? plan.blank : (answer === ui.Button.NO ? plan.blank.concat(plan.filled) : null);
  if (!items) return;
  ui.alert('Done — ' + applyTransferDescriptions_(items) + ' descriptions updated.');
}

// For every transfer Entry that is really a loan's or a repayment's money
// movement: { kind: 'repayment'|'loan', friend, direction } where direction
// is the underlying loan's ('they_owe_me' = the friend is on the receiving
// end of the owner's money / paying the owner back — the app words it).
// A transfer with no entry here is a plain move between the owner's own
// accounts ("Between Accounts"). Real settlements only (an offset has no
// transfer entry). Read once per request by listEntries / the search index.
function buildTransferLinkMap_() {
  ensureSettlementsTransferEntryColumn_();
  ensureLoansTransferEntryColumn_();
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[f.id] = f.name; });
  var loans = getAllRows('Loans');
  var loanById = {};
  var map = {};
  loans.forEach(function (l) {
    loanById[l.id] = l;
    if (l.transfer_entry_id) {
      map[l.transfer_entry_id] = { kind: 'loan', friend: friends[l.friend_id] || '', direction: l.direction };
    }
  });
  getAllRows('Settlements').forEach(function (s) {
    if (!s.transfer_entry_id || s.offset_loan_id) return;
    var loan = loanById[s.loan_id];
    if (loan) map[s.transfer_entry_id] = { kind: 'repayment', friend: friends[loan.friend_id] || '', direction: loan.direction };
  });
  return map;
}

// What deleting this entry would also undo — asked by the app BEFORE it
// confirms a delete, so the owner is told when the entry is a repayment's
// money movement. `repayment`: real settlements that reference it as their
// transfer entry (friend, direction, total); `loan`: it is a cash loan's
// own money movement (delete that from the Loans tab instead).
function getEntryRepaymentLinks(payload) {
  ensureSettlementsTransferEntryColumn_();
  ensureLoansTransferEntryColumn_();
  var id = payload.id;
  var loans = getAllRows('Loans');
  if (loans.some(function (l) { return l.transfer_entry_id === id; })) return { loan: true, repayment: null };
  var forgiven = loans.find(function (l) { return l.forgiveness_entry_id === id; });
  if (forgiven) {
    var fr = getAllRows('Friends').find(function (f) { return f.id === forgiven.friend_id; });
    return { loan: false, repayment: null, forgiveness: { friend: fr ? fr.name : '', direction: forgiven.direction } };
  }
  var linked = getAllRows('Settlements').filter(function (s) { return s.transfer_entry_id === id; });
  if (!linked.length) return { loan: false, repayment: null };
  var loanById = {};
  loans.forEach(function (l) { loanById[l.id] = l; });
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[f.id] = f.name; });
  var first = loanById[linked[0].loan_id];
  return {
    loan: false,
    repayment: {
      friend: first ? (friends[first.friend_id] || '') : '',
      direction: first ? first.direction : '',
      currency: first ? first.currency : '',
      total: linked.reduce(function (sum, s) { return sum + Number(s.amount); }, 0)
    }
  };
}

// Deleting an entry from the Entries tab. A repayment's transfer entry
// used to just disappear while the repayment it represented stayed on
// record — the debt stayed "paid" with no money movement left to show for
// it, and the Loans tab couldn't bring it back. Now deleting that entry
// also removes the repayment(s) behind it, so the debt comes back (owner's
// decision, 2026-10-01). Only the REAL settlement rows tied to this entry
// go; the offset pairs from the same call (see recordRepayment, phase 1)
// stay, same as deleteSettlement leaves them. A cash loan's own transfer
// entry is refused — deleting it would leave the loan with no movement, and
// deleting the loan is what the Loans tab is for.
function discardEntryWithRepayments_(entryId) {
  var links = getEntryRepaymentLinks({ id: entryId });
  if (links.loan) {
    throw new Error("This entry is the money movement of a loan — delete or edit that loan from the Loans tab instead.");
  }
  if (links.forgiveness) {
    // Deleting the entry a forgiveness booked undoes the forgiveness: the
    // loan is owed again (status recalculated from its repayments).
    var forgivenLoan = getAllRows('Loans').find(function (l) { return l.forgiveness_entry_id === entryId; });
    updateRowFields_('Loans', forgivenLoan.id, { status: 'outstanding', forgiveness_entry_id: '' });
    updateLoanStatusFromSettlements_(forgivenLoan.id);
  }
  if (links.repayment) {
    var touched = {};
    getAllRows('Settlements').forEach(function (s) {
      if (s.transfer_entry_id === entryId) touched[s.loan_id] = true;
    });
    deleteRowsWhere_('Settlements', function (s) { return s.transfer_entry_id === entryId; });
    Object.keys(touched).forEach(updateLoanStatusFromSettlements_);
  }
  deleteEntry_(entryId);
  return { done: true, undone_repayment: !!links.repayment, undone_forgiveness: !!links.forgiveness };
}

function findOrCreatePayorByName_(name) {
  var lower = name.toLowerCase();
  var existing = getPayorRows_().find(function (p) { return p.name.toLowerCase() === lower; });
  if (existing) return existing;
  return addPayor({ name: name });
}

// ---- Forgiving a loan (Phase 5.5) ----
// Applies to either kind of loan (cash or entry-derived) and either
// direction — marking it forgiven doesn't touch the loan's own amount/
// currency/etc the way editing does, it's purely a status change, so
// it isn't origin-restricted. A loan already forgiven can't be forgiven
// again (nothing left to do).
//
// Optionally converts whatever was still outstanding into a real Entry —
// mirroring the exact same direction logic as an overpayment (see
// createOverpaymentEntry_, above), because economically they're the same
// shape: money that was owed and isn't being collected is a real
// transaction in its own right, not a loan anymore.
// - `direction: 'they_owe_me'` forgiven → the owner's own EXPENSE (the
//   owner is choosing to give that money away — "at that point the money
//   really is spent," per CLAUDE.md).
// - `direction: 'i_owe_them'` forgiven → the owner's own INCOME (the
//   other person is the one forgiving — free money from the owner's
//   side, same as being overpaid).
function forgiveLoan(payload) {
  var loan = getAllRows('Loans').find(function (l) { return l.id === payload.id; });
  if (!loan) throw new Error('Loan not found');
  if (loan.status === 'forgiven') throw new Error('This loan is already forgiven.');

  var settled = buildSettlementTotalsByLoan_()[loan.id] || 0;
  var remaining = Number(loan.amount) - settled;

  var sheet = getSheet('Loans');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, loan.id);
  if (rowIndex === -1) throw new Error('Loan not found');

  // Whatever is still owed is always registered as the owner's own
  // expense (or income, if the owner was the debtor) — assuming that money
  // is a real cost, so forgiving never just makes it vanish. The entry is
  // created and validated BEFORE the loan is marked forgiven, so a failed
  // validation can't leave a forgiven loan with nothing booked.
  var entry = null;
  if (remaining > 0.004) {
    if (!payload.category_id) throw new Error('Pick a category.');
    if (!payload.date) throw new Error('Date is required.');

    var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
    var friendName = friend ? friend.name : 'a friend';
    var type = loan.direction === 'they_owe_me' ? 'expense' : 'income';
    var description = loan.direction === 'they_owe_me'
      ? 'Forgave ' + friendName + "'s debt"
      : friendName + ' forgave a debt I owed them';

    entry = createOverpaymentEntry_(type, {
      friend_id: loan.friend_id,
      amount: remaining,
      currency: loan.currency,
      category_id: payload.category_id,
      date: payload.date,
      payment_method_id: '',
      description: description
    });
  }

  setCellByRow_(sheet, headers, rowIndex, 'status', 'forgiven');
  if (entry) {
    ensureLoansForgivenessEntryColumn_();
    headers = getHeaders(sheet);   // the column may have just been added
    setCellByRow_(sheet, headers, rowIndex, 'forgiveness_entry_id', entry.id);
  }

  return { loan: getAllRows('Loans').find(function (l) { return l.id === loan.id; }), entry: entry };
}

// Every settlement for every one of this friend's loans in one currency
// — the Repayments sheet's own list, newest first. Not scoped to a
// single loan (see recordRepayment, above) — each row carries which loan
// it applied to, and, for an offset row, which OTHER loan it was netted
// against, so the sheet can label the two kinds differently and only
// let a real one be edited/deleted (see updateSettlement/deleteSettlement,
// below).
function listSettlementsForFriendCurrency(friendId, currency) {
  ensureSettlementsOffsetColumn_();

  var loans = getAllRows('Loans').filter(function (l) { return l.friend_id === friendId && l.currency === currency; });
  var loanById = {};
  var loanIds = {};
  loans.forEach(function (l) { loanById[l.id] = l; loanIds[l.id] = true; });

  function loanLabel(loan) {
    if (!loan) return '';
    return loan.description || (loan.origin === 'entry' ? 'Shared expense' : 'Loan');
  }

  var settlements = getAllRows('Settlements')
    .filter(function (s) { return loanIds[s.loan_id]; })
    .map(function (s) {
      s.loan_description = loanLabel(loanById[s.loan_id]);
      s.loan_direction = loanById[s.loan_id] ? loanById[s.loan_id].direction : '';
      s.offset_loan_description = s.offset_loan_id ? loanLabel(loanById[s.offset_loan_id]) : '';
      return s;
    });

  settlements.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return settlements;
}

// Only ever a real, cash settlement — an offset one (offset_loan_id set)
// is a paired accounting entry (see recordRepayment) whose other half
// would go stale if only one side were touched, so both are left as
// read-only history instead of a half-fix.
function updateSettlement(payload) {
  ensureSettlementsOffsetColumn_();
  ensureSettlementsTransferEntryColumn_();
  var existing = getAllRows('Settlements').find(function (s) { return s.id === payload.id; });
  if (!existing) throw new Error('Repayment not found');
  if (existing.offset_loan_id) {
    throw new Error("That was an automatic offset from a repayment, not a real payment — it can't be edited directly.");
  }
  var loan = getAllRows('Loans').find(function (l) { return l.id === existing.loan_id; });
  if (!loan) throw new Error('Loan not found');
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.date) throw new Error('Date is required.');

  // Remaining balance excluding THIS settlement's own current amount —
  // otherwise editing one down and back up again would always look like
  // it's exceeding the balance it's itself already part of.
  var settledOthers = getAllRows('Settlements')
    .filter(function (s) { return s.loan_id === existing.loan_id && s.id !== payload.id; })
    .reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
  var remaining = Number(loan.amount) - settledOthers;
  if (Number(payload.amount) - remaining > 0.004) {
    throw new Error("That's more than the remaining balance (" + loan.currency + ' ' + remaining.toFixed(2) + ').');
  }

  var sheet = getSheet('Settlements');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Repayment not found');
  setCellByRow_(sheet, headers, rowIndex, 'date', payload.date);
  setCellByRow_(sheet, headers, rowIndex, 'amount', Number(payload.amount));
  setCellByRow_(sheet, headers, rowIndex, 'payment_method_id', payload.payment_method_id || '');

  updateLoanStatusFromSettlements_(existing.loan_id);
  recalculateRepaymentTransferEntry_(existing.transfer_entry_id);
  return getAllRows('Settlements').find(function (s) { return s.id === payload.id; });
}

function deleteSettlement(id) {
  ensureSettlementsOffsetColumn_();
  ensureSettlementsTransferEntryColumn_();
  var existing = getAllRows('Settlements').find(function (s) { return s.id === id; });
  if (!existing) return;
  if (existing.offset_loan_id) {
    throw new Error("That was an automatic offset from a repayment, not a real payment — it can't be deleted directly.");
  }

  var sheet = getSheet('Settlements');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex !== -1) sheet.deleteRow(rowIndex);

  updateLoanStatusFromSettlements_(existing.loan_id);
  recalculateRepaymentTransferEntry_(existing.transfer_entry_id);
}

// ---- Loans screen (Phase 5.2) ----

function buildSettlementTotalsByLoan_() {
  ensureSettlementsOffsetColumn_();
  var totals = {};
  getAllRows('Settlements').forEach(function (s) {
    totals[s.loan_id] = (totals[s.loan_id] || 0) + Number(s.amount);
  });
  return totals;
}

// Shared by listLoanBalances/getFriendLoanDetail (display) and
// checkOverdueLoans (the Telegram alert, below) — a loan is overdue when
// it has a due_date at all (optional field), that date has passed, there's
// still something left to collect/pay, and it isn't forgiven (a forgiven
// loan has nothing left to be "overdue" about).
function isLoanOverdue_(loan, remaining) {
  if (loan.status === 'forgiven') return false;
  if (!loan.due_date) return false;
  if (remaining <= 0.004) return false;
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return loan.due_date < today;
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

  // friend_id -> currency -> net (they owe me positive, I owe them
  // negative), native amounts, remaining balance after settlements.
  var byFriendCurrency = {};
  var overdueFriendIds = {};
  loans.forEach(function (loan) {
    var remaining = Number(loan.amount) - (settledByLoan[loan.id] || 0);
    if (remaining <= 0.004) return;

    if (isLoanOverdue_(loan, remaining)) overdueFriendIds[loan.friend_id] = true;

    if (!byFriendCurrency[loan.friend_id]) byFriendCurrency[loan.friend_id] = {};
    var byCur = byFriendCurrency[loan.friend_id];
    byCur[loan.currency] = (byCur[loan.currency] || 0) +
      (loan.direction === 'they_owe_me' ? remaining : -remaining);
  });

  var month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var result = [];

  Object.keys(byFriendCurrency).forEach(function (friendId) {
    var byCur = byFriendCurrency[friendId];
    // Only currencies where this friend still has a real, non-zero net — a
    // currency that nets to exactly 0 (fully offsetting loans in both
    // directions) isn't a balance worth listing.
    var balances = Object.keys(byCur)
      .filter(function (cur) { return Math.abs(byCur[cur]) > 0.004; })
      .sort(function (a, b) { return a === 'PEN' ? -1 : (b === 'PEN' ? 1 : (a < b ? -1 : 1)); })
      .map(function (cur) {
        // net_pen is only ever used to ORDER rows (largest first) — never
        // shown, and null when no rate is on file, since balances stay in
        // their own currency and nothing here needs a conversion to display.
        var rate = cur === 'PEN' ? 1 : getLatestRateOnOrBefore_(cur, month);
        return { currency: cur, net: byCur[cur], net_pen: rate == null ? null : byCur[cur] * rate };
      });
    if (!balances.length) return;

    result.push({
      friend_id: friendId,
      friend_name: friendMap[friendId] || '(unknown friend)',
      balances: balances,
      has_overdue: !!overdueFriendIds[friendId]
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
    loan.overdue = isLoanOverdue_(loan, loan.remaining);
  });
  loans.sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return loans;
}

// ---- Overdue reminders (Phase 5.6) ----
// `due_date` on a Loan is optional — set by hand, there's no UI to pick
// one yet (added here, not before, since nothing consumed it until now).
// A loan with no due_date is simply never eligible; there's nothing to be
// overdue against.

// Same reasoning and pattern as Payors/Recurring Expenses' own sheets —
// this table was added well after Loans already held real data.
function ensureLoanAlertLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Loan Alert Log')) return;
  var sheet = ss.insertSheet('Loan Alert Log');
  var headers = TABLE_DEFINITIONS['Loan Alert Log'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// Runs on the same 15-minute automation cycle as the email scan and
// budget checks (see runAutomation in Triggers.gs). Dedupes against Loan
// Alert Log by (loan_id, due_date) — same idea as Budget Alert Log's
// (budget_id, period, threshold) — so a loan already alerted for its
// current due date doesn't re-alert every cycle, but editing the due
// date to something new makes it alert-worthy again on its own, with no
// separate "reset" step needed.
function checkOverdueLoans() {
  ensureLoanAlertLogSheet_();

  var settledByLoan = buildSettlementTotalsByLoan_();
  var overdueLoans = getAllRows('Loans')
    .map(function (l) {
      l.remaining = Number(l.amount) - (settledByLoan[l.id] || 0);
      return l;
    })
    .filter(function (l) { return isLoanOverdue_(l, l.remaining); });

  if (!overdueLoans.length) return { checked: 0, alertsSent: 0 };

  var alertedSet = {};
  getAllRows('Loan Alert Log').forEach(function (a) {
    alertedSet[a.loan_id + '|' + a.due_date] = true;
  });

  var friendNameById = {};
  getAllRows('Friends').forEach(function (f) { friendNameById[f.id] = f.name; });

  var alertsSent = 0;
  overdueLoans.forEach(function (loan) {
    var key = loan.id + '|' + loan.due_date;
    if (alertedSet[key]) return;

    var friendName = friendNameById[loan.friend_id] || '(unknown friend)';
    var sent = sendTelegramLoanOverdueAlert_(loan, friendName);
    if (!sent) return; // Telegram not configured — try again next cycle

    appendRowObject('Loan Alert Log', {
      id: Utilities.getUuid(),
      loan_id: loan.id,
      due_date: loan.due_date,
      sent_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
    });
    alertedSet[key] = true;
    alertsSent++;
  });

  return { checked: overdueLoans.length, alertsSent: alertsSent };
}
