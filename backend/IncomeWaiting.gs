/**
 * Income not received yet (owner's decision, 2026-11-09): the one exception to cash basis.
 *
 * It mirrors a friend paying for an expense. The income counts on its own date, the person owes it (a they_owe_me loan, origin 'entry', marked
 * pending_income), and no account moves. The money arrives as an ordinary repayment, so a general repayment covers it automatically, oldest debt
 * first, and only that repayment changes a balance. Entries.income_waiting: '1' = still owed, 'paid' = fully covered, '' = an ordinary income.
 * Never for a company or a project: those stay cash basis (specs/business.md).
 */

function ensureIncomeWaitingColumns_() {
  ensureColumn_('Entries', 'income_waiting');
  ensureColumn_('Loans', 'pending_income');
}

function incomeIsWaiting_(entry) { return !!entry && !!String(entry.income_waiting || ''); }

function waitingIncomeLoan_(entryId) {
  return getAllRows('Loans').find(function (l) { return l.entry_id === entryId && String(l.pending_income) === '1'; }) || null;
}

// What must hold before an income can wait for its money. Throws with the reason.
function checkWaitingIncome_(friendId, businessLinked) {
  if (businessLinked) throw new Error(tr_('income.waitingNoBusiness'));
  if (!friendId || friendId === 'me' || !getAllRows('Friends').some(function (f) { return String(f.id) === String(friendId); })) throw new Error(tr_('income.waitingNeedsPerson'));
}

function createWaitingIncomeLoan_(entry, dueDate) {
  ensureIncomeWaitingColumns_();
  createLoan_({
    friend_id: entry.paid_by,
    direction: 'they_owe_me',
    origin: 'entry',
    entry_id: entry.id,
    amount: Number(entry.amount),
    currency: entry.currency,
    date: entry.date,
    due_date: splitDueDate_(dueDate),
    description: entry.description || tr_('label.pendingIncome')
  });
  var made = getAllRows('Loans').find(function (l) { return l.entry_id === entry.id && l.origin === 'entry'; });
  updateRowFields_('Loans', made.id, { pending_income: '1' });
}

// Runs before an edit is written; checks everything first and returns what must happen after it (or null).
function prepareWaitingIncomeEdit_(entryId, fields) {
  if (!fields) return null;
  var dueSent = fields.due_date;
  var wantSent = fields.income_waiting;
  delete fields.due_date;
  delete fields.income_waiting;
  var entry = getEntryById_(entryId);
  if (!entry || entry.type !== 'income' || entry.status !== 'confirmed') return null;
  var loan = waitingIncomeLoan_(entryId);
  var want = wantSent === undefined ? !!loan : !!wantSent;
  if (!loan && !want) return null;
  var repaid = loan ? (buildSettlementTotalsByLoan_()[loan.id] || 0) : 0;
  if (loan && !want) {
    if (repaid > 0.004) throw new Error(tr_('income.waitingPaidLocked'));
    deleteRowsWhere_('Loans', function (row) { return row.id === loan.id; });
    fields.income_waiting = '';
    return null;
  }
  var friendId = String(fields.paid_by !== undefined ? fields.paid_by : entry.paid_by);
  var amount = Number(fields.amount !== undefined ? fields.amount : entry.amount);
  var currency = String(fields.currency !== undefined ? fields.currency : entry.currency);
  var date = String(fields.date !== undefined ? fields.date : entry.date);
  var description = String(fields.description !== undefined ? fields.description : entry.description) || tr_('label.pendingIncome');
  checkWaitingIncome_(friendId, !!(fields.company_id !== undefined ? fields.company_id : entry.company_id));
  fields.payment_method_id = '';
  if (!loan) {
    ensureIncomeWaitingColumns_();
    fields.income_waiting = '1';
    return function () { createWaitingIncomeLoan_(getEntryById_(entryId), dueSent); };
  }
  if (repaid > 0.004 && (friendId !== String(loan.friend_id) || currency !== String(loan.currency))) throw new Error(tr_('income.waitingPaidLocked'));
  if (amount < repaid - 0.004) throw new Error(tr_('income.waitingBelowPaid', { amount: repaid.toFixed(2) }));
  var changes = { friend_id: friendId, amount: amount, currency: currency, date: date, description: description };
  if (dueSent !== undefined) changes.due_date = splitDueDate_(dueSent);
  updateRowFields_('Loans', loan.id, changes);
  return function () { updateLoanStatusFromSettlements_(loan.id); };
}

// A loan's status changed: the income follows ("not received yet" while anything is owed).
function syncWaitingIncomeMarker_(loan, status) {
  var entry = getEntryById_(loan.entry_id);
  if (!entry) return;
  var marker = status === 'repaid' ? 'paid' : '1';
  if (String(entry.income_waiting) !== marker) updateEntryFields(entry.id, { income_waiting: marker });
}

// It will never be paid: the income was never really earned money, so it shrinks by what is given up. No expense is booked (that would inflate
// both income and spending). A repeat from the phone's queue is recognised for six hours, so a partial amount is never taken twice.
function forgiveWaitingIncome_(loan, amount, repaid, clientId) {
  var cache = CacheService.getScriptCache();
  var cacheKey = clientId ? 'forgive_income_' + clientId : '';
  if (cacheKey && cache.get(cacheKey)) return { loan: loan, entry: null, repeat: true };
  var entry = getEntryById_(loan.entry_id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  var left = Math.round((Number(entry.amount) - amount) * 100) / 100;
  if (left <= 0.004) {
    deleteEntry_(entry.id);   // nothing was ever paid and nothing is left: the income and its debt both go
  } else {
    updateEntryFields(entry.id, { amount: left });
    updateRowFields_('Loans', loan.id, { amount: left });
    updateLoanStatusFromSettlements_(loan.id);
  }
  if (cacheKey) cache.put(cacheKey, '1', 21600);
  return { loan: getAllRows('Loans').find(function (l) { return l.id === loan.id; }) || null, entry: null, income_reduced: amount, remaining: Math.max(0, left - repaid) };
}

// Everything still owed as income, oldest first (Home's card and the "Is this the payment?" question).
function listWaitingIncome_() {
  var loans = getAllRows('Loans').filter(function (l) { return String(l.pending_income) === '1' && (l.status === 'outstanding' || l.status === 'partially_repaid'); });
  if (!loans.length) return [];
  var totals = buildSettlementTotalsByLoan_();
  var names = {};
  getAllRows('Friends').forEach(function (f) { names[f.id] = f.name; });
  return loans.map(function (l) {
    return { loan_id: l.id, entry_id: l.entry_id, friend_id: l.friend_id, friend_name: names[l.friend_id] || '', description: l.description || '',
      amount: Number(l.amount), remaining: Math.round((Number(l.amount) - (totals[l.id] || 0)) * 100) / 100, currency: l.currency, date: String(l.date || ''), due_date: String(l.due_date || '') };
  }).sort(function (a, b) { return a.date.localeCompare(b.date); });
}

// The income waiting that this money could be: same currency, same amount as what is still owed.
function waitingMatchFor_(entry, waiting) {
  for (var i = 0; i < waiting.length; i++) {
    if (waiting[i].currency === entry.currency && Math.abs(waiting[i].remaining - Math.abs(Number(entry.amount))) < 0.005) return waiting[i];
  }
  return null;
}
