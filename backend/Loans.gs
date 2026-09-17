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

function recordSettlementRow_(loanId, date, amount, paymentMethodId, offsetLoanId) {
  appendRowObject('Settlements', {
    id: Utilities.getUuid(),
    loan_id: loanId,
    date: date,
    amount: amount,
    payment_method_id: paymentMethodId || '',
    offset_loan_id: offsetLoanId || ''
  });
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

  // Phase 2 — apply the real amount, FIFO, continuing from wherever
  // phase 1 left off.
  var cashLeft = Number(payload.amount);
  while (cashLeft > 0.004 && pi < primary.length) {
    var loan = primary[pi];
    var applyAmt = Math.min(cashLeft, primaryLeft[pi]);
    if (applyAmt > 0.004) {
      recordSettlementRow_(loan.id, payload.date, applyAmt, payload.payment_method_id || '', '');
      primaryLeft[pi] -= applyAmt;
      cashLeft -= applyAmt;
      touchedLoanIds[loan.id] = true;
    }
    if (primaryLeft[pi] <= 0.004) pi++;
  }

  Object.keys(touchedLoanIds).forEach(updateLoanStatusFromSettlements_);

  return { overpaid: cashLeft > 0.004 ? cashLeft : 0, currency: currency };
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
function createOverpaymentEntry_(type, payload) {
  if (!payload.friend_id) throw new Error('Missing friend.');
  if (!(Number(payload.amount) > 0)) throw new Error('Enter a valid amount.');
  if (!payload.category_id) throw new Error('Pick a category.');
  if (!payload.date) throw new Error('Date is required.');

  var friend = getAllRows('Friends').find(function (f) { return f.id === payload.friend_id; });
  if (!friend) throw new Error('Friend not found');

  var entry = {
    id: Utilities.getUuid(),
    type: type,
    date: payload.date,
    amount: Number(payload.amount),
    currency: payload.currency || 'PEN',
    category_id: payload.category_id,
    description: payload.description || (type === 'income'
      ? "Overpayment from " + friend.name + "'s loan repayment"
      : "Overpayment to " + friend.name + "'s loan repayment"),
    payment_method_id: payload.payment_method_id || '',
    paid_by: type === 'income' ? findOrCreatePayorByName_(friend.name).id : 'me',
    status: 'confirmed',
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

function findOrCreatePayorByName_(name) {
  var lower = name.toLowerCase();
  var existing = getPayorRows_().find(function (p) { return p.name.toLowerCase() === lower; });
  if (existing) return existing;
  return addPayor({ name: name });
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
  return getAllRows('Settlements').find(function (s) { return s.id === payload.id; });
}

function deleteSettlement(id) {
  ensureSettlementsOffsetColumn_();
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
