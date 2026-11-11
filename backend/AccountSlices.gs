/**
 * Overview's "By account or card" pie (owner's design, 2026-11-10; replaces the 2026-11-08 "Paid by a friend" slice).
 *
 * An entry the owner paid from an account counts under that account. An expense a FRIEND paid (a debt "I owe them")
 * is split by what happened to that debt: the part repaid counts under the account it was repaid from, the part
 * cancelled against something the friend owed is followed ONE step back to the account that money left, the part the
 * friend forgave is "A friend covered it", and what is still owed is "Not repaid yet". Income saved as "Not received
 * yet" is the mirror: received parts count under the account the money arrived in. Every repayment recorded so far
 * counts, so a past month's pie moves when a debt is repaid later; its totals never do.
 *
 * Fractions, never amounts: a part is (amount of the debt it covers) / (the debt), applied to the entry's own share, so a
 * debt kept in another currency than the entry (Charges.gs) still splits right and the pie adds up to the total.
 *
 * The SAME function feeds the pie (Reports.gs) and its drill-down (listEntries), so a slice's list always matches it.
 */

var SLICE_NOT_REPAID_ = '__notrepaid__';         // expense: a friend paid, still owed
var SLICE_COVERED_ = '__covered__';              // expense: the friend forgave it
var SLICE_PAID_WITH_OWED_ = '__owedme__';        // expense: cancelled against income they owed me (no account ever moved)
var SLICE_NOT_RECEIVED_ = '__notreceived__';     // income: "Not received yet", still owed
var SLICE_RECEIVED_AS_OWED_ = '__owedthem__';    // income: cancelled against a debt I owed them with no account behind it
var SLICE_NAME_KEYS_ = {
  __notrepaid__: 'report.notRepaidYet',
  __covered__: 'report.friendCovered',
  __owedme__: 'report.paidWithOwed',
  __notreceived__: 'report.notReceivedYet',
  __owedthem__: 'report.receivedAsOwed'
};
// An older phone (stable/) still opens the old "Paid by a friend" slice: everything a friend paid for.
var PAID_BY_FRIEND_KEY_ = '__friend__';

function isSpecialSliceKey_(key) { return !!SLICE_NAME_KEYS_[key]; }

// Name lookup for addToBucket_: the special slices by their key.
function specialSliceRefs_() {
  var o = {};
  Object.keys(SLICE_NAME_KEYS_).forEach(function (k) { o[k] = { name: tr_(SLICE_NAME_KEYS_[k]) }; });
  return o;
}

// Read once per request: the debts made from entries, their repayment rows, and every entry by id (the repayments' own
// money entries and the entries an offset debt came from).
function buildAccountSliceContext_() {
  var loansByEntry = {}, loansById = {}, settlementsByLoan = {};
  getAllRows('Loans').forEach(function (l) {
    loansById[l.id] = l;
    if (l.origin === 'entry' && l.entry_id) (loansByEntry[l.entry_id] = loansByEntry[l.entry_id] || []).push(l);
  });
  getAllRows('Settlements').forEach(function (s) {
    (settlementsByLoan[s.loan_id] = settlementsByLoan[s.loan_id] || []).push(s);
  });
  return { loansByEntry: loansByEntry, loansById: loansById, settlementsByLoan: settlementsByLoan, entriesById: rowsById_(getAllRows('Entries')) };
}

// Where an offset's OTHER debt came from (one step back). `forIncome` = the entry being placed is an income.
function offsetSourceKey_(other, ctx, forIncome) {
  if (!other) return '';
  if (forIncome) {
    // My income was settled by cancelling a debt I owed the friend. A cash loan they gave me arrived in an account; a
    // debt from an expense they paid for me never touched one.
    if (other.origin === 'cash') return String(other.payment_method_id || '');
    return SLICE_RECEIVED_AS_OWED_;
  }
  // My debt was cancelled against one they owed me.
  if (String(other.pending_income) === '1') return SLICE_PAID_WITH_OWED_;   // income they owed me: no account ever moved
  if (other.origin === 'cash') return String(other.payment_method_id || '');   // cash I lent them from an account
  var src = other.entry_id ? ctx.entriesById[other.entry_id] : null;          // an expense I paid for them
  if (src && src.paid_by === 'me') return String(src.payment_method_id || '');
  return '';
}

// One repayment row → the slice its money belongs to.
function settlementSliceKey_(s, ctx, forIncome) {
  if (s.offset_loan_id) return offsetSourceKey_(ctx.loansById[s.offset_loan_id], ctx, forIncome);
  var moneyEntry = s.transfer_entry_id ? ctx.entriesById[s.transfer_entry_id] : null;
  if (moneyEntry) return String(moneyEntry.payment_method_id || '');
  return String(s.payment_method_id || '');
}

// The parts of one debt: [{ key, fraction, kind }], kind 'repaid' | 'offset' | 'covered' | 'open'. Fractions add up to 1.
function debtSliceParts_(loan, ctx, forIncome, openKey) {
  var total = Number(loan.amount) || 0;
  if (total <= 0.004) return [{ key: openKey, fraction: 1, kind: 'open' }];
  var byKey = {}, order = [];
  var add = function (key, amount, kind) {
    if (amount <= 0.004) return;
    var k = kind + '|' + key;
    if (!byKey[k]) { byKey[k] = { key: key, amount: 0, kind: kind }; order.push(k); }
    byKey[k].amount += amount;
  };
  var used = 0;
  (ctx.settlementsByLoan[loan.id] || []).forEach(function (s) {
    var amt = Number(s.amount) || 0;
    add(settlementSliceKey_(s, ctx, forIncome), amt, s.offset_loan_id ? 'offset' : 'repaid');
    used += amt;
  });
  if (!forIncome) {
    var forgiven = loanForgivenPartsTotal_(loan);
    if (loan.status === 'forgiven') forgiven = Math.max(forgiven, total - used);   // a whole forgiveness covers what was left
    add(SLICE_COVERED_, forgiven, 'covered');
    used += forgiven;
  }
  add(openKey, total - used, 'open');
  var sum = order.reduce(function (t, k) { return t + byKey[k].amount; }, 0);
  var base = Math.max(total, sum);   // more recorded than owed should not happen; never count over 100 %
  return order.map(function (k) { return { key: byKey[k].key, fraction: byKey[k].amount / base, kind: byKey[k].kind }; });
}

// Every part of one entry: [{ key, fraction, kind }]. key = an account id, '' (No account) or a special slice.
function entryAccountSliceParts_(e, ctx) {
  if (e.type === 'income') {
    var waitingLoan = (ctx.loansByEntry[e.id] || []).filter(function (l) { return String(l.pending_income) === '1'; })[0];
    if (waitingLoan) return debtSliceParts_(waitingLoan, ctx, true, SLICE_NOT_RECEIVED_);
    if (String(e.income_waiting) === '1') return [{ key: SLICE_NOT_RECEIVED_, fraction: 1, kind: 'open' }];
    // An income's paid_by is who paid me (a payor), never a friend paying for me: the account it arrived in counts.
    return [{ key: String(e.payment_method_id || ''), fraction: 1, kind: 'own' }];
  }
  if (!e.paid_by || e.paid_by === 'me') return [{ key: String(e.payment_method_id || ''), fraction: 1, kind: 'own' }];
  var debt = (ctx.loansByEntry[e.id] || []).filter(function (l) { return l.direction === 'i_owe_them'; })[0];
  if (!debt) return [{ key: SLICE_NOT_REPAID_, fraction: 1, kind: 'open' }];
  return debtSliceParts_(debt, ctx, false, SLICE_NOT_REPAID_);
}

// How a part reached its slice, for the phone's line (strings `drill.how.*`).
function slicePartHow_(kind, key, isIncome) {
  if (isSpecialSliceKey_(key)) return { __notrepaid__: 'notRepaid', __covered__: 'covered', __owedme__: 'paidWithOwed', __notreceived__: 'notReceived', __owedthem__: 'receivedAsOwed' }[key];
  if (kind === 'offset') return isIncome ? (key ? 'offsetThemFrom' : 'offsetThem') : (key ? 'offsetMeFrom' : 'offsetMe');
  return isIncome ? (key ? 'receivedIn' : 'receivedNoAccount') : (key ? 'repaidFrom' : 'repaidNoAccount');
}

// The drill-down of one slice: the entries with a part in it, each carrying `slice_part` (only when the part is not the
// whole entry, or the entry was not paid from the account directly) so the phone can show "PEN 60.00 of PEN 100.00 · …".
// `key` is the slice id the pie gave ('' = No account). The old "Paid by a friend" id lists every friend-paid expense.
function filterEntriesBySlice_(entries, key) {
  if (key === PAID_BY_FRIEND_KEY_) return entries.filter(function (e) { return e.type === 'expense' && e.paid_by && e.paid_by !== 'me'; });
  var ctx = buildAccountSliceContext_();
  var pmById = rowsById_(getAllRows('Payment Methods'));
  var out = [];
  entries.forEach(function (e) {
    var parts = entryAccountSliceParts_(e, ctx);
    var mine = parts.filter(function (p) { return p.key === key; });
    if (!mine.length) return;
    if (!(mine.length === 1 && mine[0].kind === 'own')) {
      var fraction = mine.reduce(function (t, p) { return t + p.fraction; }, 0);
      // Which way it reached this slice, for the line under the row: the most of it decides.
      var kind = mine.slice().sort(function (a, b) { return b.fraction - a.fraction; })[0].kind;
      var pm = pmById[key];
      e.slice_part = { fraction: fraction, how: slicePartHow_(kind, key, e.type === 'income'), account: pm ? String(pm.nickname || pm.name || '') : '' };
    }
    out.push(e);
  });
  return out;
}
