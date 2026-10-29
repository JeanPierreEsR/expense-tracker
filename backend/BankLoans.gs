/**
 * Personal loans from a bank (owner's request, 2026-10-29). A bank loan is an ordinary loan the owner owes ("i_owe_them", the
 * bank being the person) plus a SCHEDULE of installments entered by hand: for each one its date, the principal, the interest and
 * the fees (insurance, commission). Money rules, as for any loan: receiving it is not income; the principal of an installment is
 * a repayment (never an expense); the interest and fees ARE expenses. So recording an installment makes the same two entries as
 * a repayment with an extra: a transfer entry for the principal (what the loan took) and ONE linked expense entry for interest +
 * fees (Settlements.gap_entry_id), which is why the bank's single debit matches the installment in a statement upload.
 *
 * Sheet 'Loan Installments': id, loan_id, number, due_date, principal, interest, fees, transfer_entry_id, paid_date.
 * An installment is PAID while its transfer_entry_id still backs a repayment (cancelling the repayment makes it due again).
 */

function ensureLoanInstallmentsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Loan Installments')) return;
  var sheet = ss.insertSheet('Loan Installments');
  var headers = TABLE_DEFINITIONS['Loan Installments'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  DATE_LIKE_COLUMNS['Loan Installments'].forEach(function (colName) {
    sheet.getRange(1, headers.indexOf(colName) + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

function bankToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function bankRound_(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Rows of one loan, in installment order, each with its live status and total.
function loanInstallmentsOf_(loanId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Loan Installments')) return [];
  var backed = {};
  getAllRows('Settlements').forEach(function (s) { if (s.transfer_entry_id && !s.offset_loan_id) backed[s.transfer_entry_id] = true; });
  var today = bankToday_();
  return getAllRows('Loan Installments')
    .filter(function (r) { return r.loan_id === loanId; })
    .map(function (r) {
      var paid = !!(r.transfer_entry_id && backed[r.transfer_entry_id]);
      var principal = Number(r.principal) || 0, interest = Number(r.interest) || 0, fees = Number(r.fees) || 0;
      return {
        id: r.id, loan_id: r.loan_id, number: Number(r.number), due_date: String(r.due_date),
        principal: principal, interest: interest, fees: fees, total: bankRound_(principal + interest + fees),
        paid: paid, paid_date: paid ? String(r.paid_date || '') : '', transfer_entry_id: paid ? r.transfer_entry_id : '',
        status: paid ? 'paid' : (String(r.due_date) < today ? 'overdue' : 'due')
      };
    })
    .sort(function (a, b) { return a.number - b.number; });
}

// loan id -> { count, paid, next_due, next_total }: what the person's screen shows on a loan that has a schedule.
function loanScheduleSummaries_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Loan Installments')) return {};
  var ids = {};
  getAllRows('Loan Installments').forEach(function (r) { ids[r.loan_id] = true; });
  var out = {};
  Object.keys(ids).forEach(function (loanId) {
    var rows = loanInstallmentsOf_(loanId);
    var open = rows.filter(function (r) { return !r.paid; });
    out[loanId] = {
      count: rows.length, paid: rows.length - open.length,
      next_due: open.length ? open[0].due_date : '', next_total: open.length ? open[0].total : 0,
      overdue: open.some(function (r) { return r.status === 'overdue'; })
    };
  });
  return out;
}

// Checks a list of {due_date, principal, interest, fees} and returns it cleaned. `principalTotal` is what the principals must add up to.
function cleanInstallments_(list, principalTotal) {
  if (!Array.isArray(list) || !list.length) throw new Error(tr_('bank.noInstallments'));
  var sum = 0;
  var out = list.map(function (r) {
    var principal = bankRound_(r && r.principal), interest = bankRound_((r && r.interest) || 0), fees = bankRound_((r && r.fees) || 0);
    if (!r || !r.due_date || !(principal > 0) || interest < 0 || fees < 0) throw new Error(tr_('bank.installmentBad'));
    sum += principal;
    return { due_date: String(r.due_date), principal: principal, interest: interest, fees: fees };
  });
  if (Math.abs(sum - principalTotal) > 0.011) {
    throw new Error(tr_('bank.principalMismatch', { sum: moneyFmt_(sum), amount: moneyFmt_(principalTotal) }));
  }
  out.sort(function (a, b) { return a.due_date < b.due_date ? -1 : (a.due_date > b.due_date ? 1 : 0); });
  return out;
}

function appendInstallmentRows_(loanId, rows, firstNumber) {
  rows.forEach(function (r, i) {
    appendRowObject('Loan Installments', {
      id: Utilities.getUuid(), loan_id: loanId, number: firstNumber + i, due_date: r.due_date,
      principal: r.principal, interest: r.interest, fees: r.fees, transfer_entry_id: '', paid_date: ''
    });
  });
}

// payload: { friend_id | friend_name, amount, currency, date, payment_method_id, description, installments: [{due_date, principal, interest, fees}] }
function saveBankLoan(payload) {
  var friendId = payload.friend_id;
  if (!friendId) {
    if (!String(payload.friend_name || '').trim()) throw new Error(tr_('err.pickFriend'));
  }
  if (!(Number(payload.amount) > 0)) throw new Error(tr_('err.validAmount'));
  if (!payload.date) throw new Error(tr_('err.dateRequired'));
  var rows = cleanInstallments_(payload.installments, bankRound_(payload.amount));   // checked first: nothing is created when it is wrong
  if (!friendId) friendId = addFriend({ name: payload.friend_name }).id;
  var loan = addLoan({
    friend_id: friendId, direction: 'i_owe_them', amount: bankRound_(payload.amount), currency: payload.currency,
    date: payload.date, due_date: rows[rows.length - 1].due_date, payment_method_id: payload.payment_method_id,
    description: payload.description
  });
  ensureLoanInstallmentsSheet_();
  appendInstallmentRows_(loan.id, rows, 1);
  return { loan: loan, installments: loanInstallmentsOf_(loan.id) };
}

function getLoanSchedule(payload) {
  var loan = getAllRows('Loans').find(function (l) { return l.id === payload.loan_id; });
  if (!loan) throw new Error(tr_('err.loanNotFound'));
  var rows = loanInstallmentsOf_(loan.id);
  var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
  // what is still owed counts EVERYTHING repaid on the loan (installments and early payments), not just the paid installments
  var paidPrincipal = getAllRows('Settlements').filter(function (st) { return st.loan_id === loan.id; }).reduce(function (n, st) { return n + Number(st.amount); }, 0);
  return {
    loan: { id: loan.id, amount: Number(loan.amount), currency: loan.currency, date: loan.date, description: loan.description || '', friend_id: loan.friend_id, friend_name: friend ? friend.name : '' },
    installments: rows,
    remaining_principal: bankRound_(Number(loan.amount) - paidPrincipal),
    totals: {
      principal: bankRound_(rows.reduce(function (n, r) { return n + r.principal; }, 0)),
      interest: bankRound_(rows.reduce(function (n, r) { return n + r.interest; }, 0)),
      fees: bankRound_(rows.reduce(function (n, r) { return n + r.fees; }, 0))
    }
  };
}

// Replaces the installments NOT yet paid (paid ones stay as they are). The principals of paid + new rows must still add up to the loan.
// payload: { loan_id, installments: [{due_date, principal, interest, fees}] }
function saveLoanSchedule(payload) {
  var loan = getAllRows('Loans').find(function (l) { return l.id === payload.loan_id; });
  if (!loan) throw new Error(tr_('err.loanNotFound'));
  ensureLoanInstallmentsSheet_();
  var existing = loanInstallmentsOf_(loan.id);
  var paid = existing.filter(function (r) { return r.paid; });
  var paidPrincipal = paid.reduce(function (n, r) { return n + r.principal; }, 0);
  var left = bankRound_(Number(loan.amount) - paidPrincipal);
  var rows = left > 0.004 ? cleanInstallments_(payload.installments, left)
    : (function () { if (payload.installments && payload.installments.length) throw new Error(tr_('bank.principalMismatch', { sum: moneyFmt_(0), amount: moneyFmt_(0) })); return []; })();
  var keep = {};
  paid.forEach(function (r) { keep[r.id] = true; });
  deleteRowsWhere_('Loan Installments', function (r) { return r.loan_id === loan.id && !keep[r.id]; });
  var maxPaid = paid.reduce(function (n, r) { return Math.max(n, r.number); }, 0);
  appendInstallmentRows_(loan.id, rows, maxPaid + 1);
  return getLoanSchedule({ loan_id: loan.id });
}

// Records an installment as paid: the principal is a repayment of the loan (a transfer entry + a settlement), the interest and
// fees are ONE linked expense entry. payload: { id, date, payment_method_id, principal?, interest?, fees?, category_id? } — the numbers
// default to the schedule's; what the bank really charged can be typed over them, and is kept on the installment.
function recordInstallment(payload) {
  ensureLoanInstallmentsSheet_();
  ensureSettlementsOffsetColumn_();
  ensureSettlementsTransferEntryColumn_();
  ensureSettlementsGapColumn_();
  ensureSettlementsLimitedColumn_();
  var row = getAllRows('Loan Installments').find(function (r) { return r.id === payload.id; });
  if (!row) throw new Error(tr_('bank.noSchedule'));
  var live = loanInstallmentsOf_(row.loan_id).find(function (r) { return r.id === row.id; });
  if (live.paid) throw new Error(tr_('bank.alreadyPaid'));
  var loan = getAllRows('Loans').find(function (l) { return l.id === row.loan_id; });
  if (!loan) throw new Error(tr_('err.loanNotFound'));
  if (!payload.date) throw new Error(tr_('err.dateRequired'));
  var principal = payload.principal !== undefined && payload.principal !== '' ? bankRound_(payload.principal) : live.principal;
  var interest = payload.interest !== undefined && payload.interest !== '' ? bankRound_(payload.interest) : live.interest;
  var fees = payload.fees !== undefined && payload.fees !== '' ? bankRound_(payload.fees) : live.fees;
  if (!(principal > 0) || interest < 0 || fees < 0) throw new Error(tr_('err.validAmount'));
  var settled = getAllRows('Settlements').filter(function (s) { return s.loan_id === loan.id; })
    .reduce(function (n, s) { return n + Number(s.amount); }, 0);
  var room = bankRound_(Number(loan.amount) - settled);
  if (principal - room > 0.004) throw new Error(tr_('bank.moreThanOwed', { cur: loan.currency, amount: moneyFmt_(room) }));

  var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
  var count = loanInstallmentsOf_(loan.id).length;
  var what = loan.description || (friend ? friend.name : '');
  var transfer = createTransferEntry_({
    date: payload.date, amount: principal, currency: loan.currency, payment_method_id: payload.payment_method_id,
    description: tr_('bank.installmentDesc', { n: live.number, count: count, what: what })
  });
  var extra = bankRound_(interest + fees);
  var extraId = '';
  if (extra > 0.004) {
    var extraEntry = createOverpaymentEntry_('expense', {
      friend_id: loan.friend_id, amount: extra, currency: loan.currency, date: payload.date, payment_method_id: payload.payment_method_id,
      category_id: payload.category_id || '', pending: !payload.category_id,
      description: tr_('bank.extraDesc', { n: live.number, count: count, what: what })
    });
    extraId = extraEntry.id;
  }
  recordSettlementRow_(loan.id, payload.date, principal, payload.payment_method_id || '', '', transfer.id, true, extraId);
  updateLoanStatusFromSettlements_(loan.id);

  var sheet = getSheet('Loan Installments');
  var headers = getHeaders(sheet);
  var idx = findRowIndexById(sheet, headers, row.id);
  setCellByRow_(sheet, headers, idx, 'principal', principal);
  setCellByRow_(sheet, headers, idx, 'interest', interest);
  setCellByRow_(sheet, headers, idx, 'fees', fees);
  setCellByRow_(sheet, headers, idx, 'transfer_entry_id', transfer.id);
  setCellByRow_(sheet, headers, idx, 'paid_date', payload.date);
  return { installment: loanInstallmentsOf_(loan.id).find(function (r) { return r.id === row.id; }), transfer_entry_id: transfer.id, extra_entry_id: extraId };
}

// An EARLY payment (prepago, owner's request, 2026-10-29): extra principal paid ahead of the schedule, with an optional prepayment fee
// (default 0). Like an installment it is a repayment of the loan (transfer entry + settlement) plus ONE linked expense (the fee).
// The installments not yet paid are then adjusted: mode 'shorten' (the DEFAULT) keeps each installment and drops the principal from the
// LAST ones (a row emptied is removed, with its interest and fees); mode 'reduce' keeps the number of installments and shrinks every
// unpaid one (principal and interest in proportion — an estimate, to be typed over with the bank's own numbers). Paying everything that
// is owed removes all unpaid installments and the loan is repaid.
// payload: { loan_id, date, payment_method_id, principal, fee?, category_id?, mode? }
function recordEarlyPayment(payload) {
  ensureLoanInstallmentsSheet_();
  ensureSettlementsOffsetColumn_();
  ensureSettlementsTransferEntryColumn_();
  ensureSettlementsGapColumn_();
  ensureSettlementsLimitedColumn_();
  var loan = getAllRows('Loans').find(function (l) { return l.id === payload.loan_id; });
  if (!loan) throw new Error(tr_('err.loanNotFound'));
  if (!payload.date) throw new Error(tr_('err.dateRequired'));
  var mode = payload.mode === 'reduce' ? 'reduce' : 'shorten';
  var principal = bankRound_(payload.principal);
  var fee = bankRound_(payload.fee || 0);
  if (!(principal > 0)) throw new Error(tr_('bank.earlyNothing'));
  if (fee < 0) throw new Error(tr_('err.validAmount'));
  var settled = getAllRows('Settlements').filter(function (s) { return s.loan_id === loan.id; })
    .reduce(function (n, s) { return n + Number(s.amount); }, 0);
  var room = bankRound_(Number(loan.amount) - settled);
  if (principal - room > 0.004) throw new Error(tr_('bank.moreThanOwed', { cur: loan.currency, amount: moneyFmt_(room) }));

  var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
  var what = loan.description || (friend ? friend.name : '');
  var transfer = createTransferEntry_({
    date: payload.date, amount: principal, currency: loan.currency, payment_method_id: payload.payment_method_id,
    description: tr_('bank.earlyDesc', { what: what })
  });
  var feeId = '';
  if (fee > 0.004) {
    feeId = createOverpaymentEntry_('expense', {
      friend_id: loan.friend_id, amount: fee, currency: loan.currency, date: payload.date, payment_method_id: payload.payment_method_id,
      category_id: payload.category_id || '', pending: !payload.category_id, description: tr_('bank.earlyFeeDesc', { what: what })
    }).id;
  }
  recordSettlementRow_(loan.id, payload.date, principal, payload.payment_method_id || '', '', transfer.id, true, feeId);
  updateLoanStatusFromSettlements_(loan.id);

  // the installments not yet paid, adjusted to what is still owed
  var after = bankRound_(room - principal);
  var open = loanInstallmentsOf_(loan.id).filter(function (r) { return !r.paid; });
  var sheet = getSheet('Loan Installments');
  var headers = getHeaders(sheet);
  var removeIds = {};
  if (after <= 0.004) {
    open.forEach(function (r) { removeIds[r.id] = true; });
  } else if (mode === 'shorten') {
    var cut = principal;
    for (var i = open.length - 1; i >= 0 && cut > 0.004; i--) {
      if (open[i].principal <= cut + 0.004) {
        cut = bankRound_(cut - open[i].principal);
        removeIds[open[i].id] = true;
      } else {
        setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, open[i].id), 'principal', bankRound_(open[i].principal - cut));
        cut = 0;
      }
    }
  } else {
    var openTotal = open.reduce(function (n, r) { return n + r.principal; }, 0);
    var factor = openTotal > 0 ? after / openTotal : 1;
    var assigned = 0;
    open.forEach(function (r, idx) {
      var p = idx === open.length - 1 ? bankRound_(after - assigned) : bankRound_(r.principal * factor);
      assigned = bankRound_(assigned + p);
      var rowIndex = findRowIndexById(sheet, headers, r.id);
      setCellByRow_(sheet, headers, rowIndex, 'principal', p);
      setCellByRow_(sheet, headers, rowIndex, 'interest', bankRound_(r.interest * factor));
    });
  }
  if (Object.keys(removeIds).length) deleteRowsWhere_('Loan Installments', function (r) { return removeIds[r.id]; });
  return { schedule: getLoanSchedule({ loan_id: loan.id }), transfer_entry_id: transfer.id, fee_entry_id: feeId };
}
