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
      var principal = Number(r.principal) || 0, interest = Number(r.interest) || 0, fees = Number(r.fees) || 0;
      // An interest-only installment (a grace period) repays nothing: it is paid while its expense entry (kept in transfer_entry_id) exists.
      var paid = !!(r.transfer_entry_id && (backed[r.transfer_entry_id] || (principal <= 0.004 && r.paid_date && getEntryById_(r.transfer_entry_id))));
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
    if (!r || !r.due_date || principal < 0 || interest < 0 || fees < 0 || !(principal + interest + fees > 0)) throw new Error(tr_('bank.installmentBad'));
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
  if (principal < 0 || interest < 0 || fees < 0 || !(principal + interest + fees > 0)) throw new Error(tr_('err.validAmount'));
  var settled = getAllRows('Settlements').filter(function (s) { return s.loan_id === loan.id; })
    .reduce(function (n, s) { return n + Number(s.amount); }, 0);
  var room = bankRound_(Number(loan.amount) - settled);
  if (principal - room > 0.004) throw new Error(tr_('bank.moreThanOwed', { cur: loan.currency, amount: moneyFmt_(room) }));

  var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
  var count = loanInstallmentsOf_(loan.id).length;
  var what = loan.description || (friend ? friend.name : '');
  // no principal (a grace period, interest only): no repayment and no transfer, only the expense below
  var transfer = principal > 0.004 ? createTransferEntry_({
    date: payload.date, amount: principal, currency: loan.currency, payment_method_id: payload.payment_method_id,
    description: tr_('bank.installmentDesc', { n: live.number, count: count, what: what })
  }) : null;
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
  if (transfer) {
    recordSettlementRow_(loan.id, payload.date, principal, payload.payment_method_id || '', '', transfer.id, true, extraId);
    updateLoanStatusFromSettlements_(loan.id);
  }
  var backingId = transfer ? transfer.id : extraId;

  var sheet = getSheet('Loan Installments');
  var headers = getHeaders(sheet);
  var idx = findRowIndexById(sheet, headers, row.id);
  setCellByRow_(sheet, headers, idx, 'principal', principal);
  setCellByRow_(sheet, headers, idx, 'interest', interest);
  setCellByRow_(sheet, headers, idx, 'fees', fees);
  setCellByRow_(sheet, headers, idx, 'transfer_entry_id', backingId);
  setCellByRow_(sheet, headers, idx, 'paid_date', payload.date);
  return { installment: loanInstallmentsOf_(loan.id).find(function (r) { return r.id === row.id; }), transfer_entry_id: transfer ? transfer.id : '', extra_entry_id: extraId };
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

  // The installments not yet paid, RECALCULATED on what is still owed (owner's request, 2026-10-29). The rate is not stored: the TEA
  // is worked out from the schedule itself (the first unpaid installment's interest over the principal still owed before it, over
  // the real days since the previous date, 360-day year), so it follows whatever the bank's own schedule says. Interest is then the
  // TEA over the real days on the balance of each installment.
  var after = bankRound_(room - principal);
  var open = loanInstallmentsOf_(loan.id).filter(function (r) { return !r.paid; });
  var sheet = getSheet('Loan Installments');
  var headers = getHeaders(sheet);
  var all = loanInstallmentsOf_(loan.id);
  var firstOpen = open.length ? all.findIndex(function (r) { return r.id === open[0].id; }) : -1;
  var prevDate = firstOpen > 0 ? all[firstOpen - 1].due_date : String(loan.date || '').slice(0, 10);
  var plan = recalculateInstallmentsAfterEarly_(open, after, mode, prevDate);
  plan.forEach(function (item) {
    var rowIndex = findRowIndexById(sheet, headers, item.id);
    setCellByRow_(sheet, headers, rowIndex, 'principal', item.principal);
    setCellByRow_(sheet, headers, rowIndex, 'interest', item.interest);
  });
  var keep = {};
  plan.forEach(function (item) { keep[item.id] = true; });
  var removeIds = {};
  open.forEach(function (r) { if (!keep[r.id]) removeIds[r.id] = true; });
  if (Object.keys(removeIds).length) deleteRowsWhere_('Loan Installments', function (r) { return removeIds[r.id]; });
  return { schedule: getLoanSchedule({ loan_id: loan.id }), transfer_entry_id: transfer.id, fee_entry_id: feeId };
}


// Days between two ISO dates (actual days; interest counts them on a 360-day year).
function bankDaysBetween_(a, b) {
  var pa = String(a).slice(0, 10).split('-').map(Number);
  var pb = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

// What the unpaid installments (`open`, in order, before the early payment) become once only `after` of principal is left.
// Returns [{ id, principal, interest }] for the rows that stay; rows not returned are removed. Fees stay as they are.
// `prevDate` is the date before the first unpaid installment (the previous installment's due date, or the loan date); interest is
// the TEA over the real days between dates on a 360-day year, the TEA being the one the first unpaid row implies.
//  - 'shorten' (default): every installment keeps its own amount (principal + interest); interest is the rate on the balance, so more
//    of each goes to principal and the loan ends sooner. The last row takes whatever is left.
//  - 'reduce': the same number of installments, each one smaller (an annuity on the new balance).
function recalculateInstallmentsAfterEarly_(open, after, mode, prevDate) {
  if (after <= 0.004 || !open.length) return [];
  var before = open.reduce(function (n, r) { return n + r.principal; }, 0);
  var daysOf = function (i) {
    var from = i === 0 ? prevDate : open[i - 1].due_date;
    var d = from ? bankDaysBetween_(from, open[i].due_date) : 0;
    return d > 0 ? d : 30;
  };
  var rate = before > 0 && open[0].interest > 0 ? Math.pow(1 + open[0].interest / before, 360 / daysOf(0)) - 1 : 0;
  var grow = function (days) { return Math.pow(1 + rate, days / 360); };
  var out = [];
  var balance = after;
  var n = open.length;
  // interest-only rows (a grace period) stay interest-only; the annuity of 'reduce' spreads over the amortizing rows only
  var lastAmortizing = -1, firstAmortizing = -1;
  open.forEach(function (r, idx) {
    if (r.principal > 0.004) { lastAmortizing = idx; if (firstAmortizing < 0) firstAmortizing = idx; }
  });
  var payment = 0;
  if (mode === 'reduce' && firstAmortizing >= 0) {
    var originDate = firstAmortizing === 0 ? prevDate : open[firstAmortizing - 1].due_date;
    var amortizing = 0, factor = 0;
    for (var k = firstAmortizing; k < n; k++) {
      if (open[k].principal <= 0.004) continue;
      amortizing++;
      factor += 1 / grow(originDate ? Math.max(bankDaysBetween_(originDate, open[k].due_date), 1) : 30 * (k - firstAmortizing + 1));
    }
    payment = rate > 0 ? after / factor : after / amortizing;
  }
  for (var i = 0; i < n && balance > 0.004; i++) {
    var interest = bankRound_(balance * (grow(daysOf(i)) - 1));
    if (open[i].principal <= 0.004) { out.push({ id: open[i].id, principal: 0, interest: interest }); continue; }
    var pay = mode === 'reduce' ? payment : open[i].principal + open[i].interest;
    var p = bankRound_(pay - interest);
    if (i === lastAmortizing || p >= balance - 0.004 || p <= 0) p = bankRound_(balance);
    out.push({ id: open[i].id, principal: p, interest: interest });
    balance = bankRound_(balance - p);
  }
  return out;
}
