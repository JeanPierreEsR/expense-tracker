/**
 * Refunds on a purchase (owner's plan "Refunds - plan (DRAFT 2026-11-24)"; specs/entries-and-categories.md § Refunds).
 *
 * A refund is recorded FROM the expense it returns money for, and carries `refund_of` = that expense's id. The owner's rule
 * (2026-10-23, kept 2026-11-24) decides what it is, by the day the money came back:
 *   - the purchase's own calendar month → an expense with a MINUS amount, same category (that month nets down in its category);
 *   - any later month → an income in the category "Refunds" (the purchase's month is never touched).
 * A shared purchase's refund is divided like the purchase. Only the person's own part is spending / income; a friend's part
 * only changes what the two owe each other (principle 2):
 *   - money back to the person's account: each friend's part is a debt TO that friend (a cash loan "i_owe_them" into that account,
 *     `Loans.refund_of` = the purchase), which nets against what the friend owed for the purchase;
 *   - money back to the friend who paid the purchase: the person's part is a refund with no account, and that friend now owes it
 *     (a "they_owe_me" loan tied to the refund entry).
 * "Refund approved, not paid yet" is only a note on the purchase (Entries.refund_expected / refund_expected_by): nothing counts until
 * the money arrives (cash basis); Home lists it under "Refunds on the way".
 */

// 'delete' while the person's own Delete of a purchase asked to remove its refunds too (Api.gs, discardEntry); else they are kept.
var REFUND_RELEASE_MODE_ = '';

function ensureRefundColumns_() {
  ensureColumn_('Entries', 'refund_of');
  ensureColumn_('Loans', 'refund_of');
}

function ensureRefundExpectedColumns_() {
  ensureColumn_('Entries', 'refund_expected');
  ensureColumn_('Entries', 'refund_expected_by');
}

// The income category "Refunds": found by its key or name, shown again when hidden, made when missing.
function refundsCategory_() {
  var found = getAllRows('Categories').filter(function (c) {
    return c.type === 'income' && (String(c.key || '') === 'refunds' || String(c.name) === 'Refunds');
  })[0];
  if (!found) return ensureRefundsCategory_();
  if (String(found.hidden || '') === 'yes') updateRowFields_('Categories', found.id, { hidden: '' });
  return found;
}

// What each person paid for of the purchase: { me, <friend id>: … } (only people the person has a debt with for it). A purchase
// the person paid: their own share and each friend's split. A purchase a friend paid: the person's share, and the rest belongs to
// that friend (whatever the others owe the payer is between them).
function purchaseShares_(purchase, splits) {
  var total = Number(purchase.amount);
  var splitTotal = splits.reduce(function (n, s) { return n + Number(s.amount); }, 0);
  var shares = { me: round2_(total - splitTotal) };
  if (purchase.paid_by === 'me' || !purchase.paid_by) {
    splits.forEach(function (s) { shares[s.friend_id] = round2_((shares[s.friend_id] || 0) + Number(s.amount)); });
  } else if (round2_(total - shares.me) > 0.004) {
    shares[purchase.paid_by] = round2_(total - shares.me);
  }
  return shares;
}

// What came back already, per person: the person's refunds (a minus expense counts by its size) and each friend's part (their loans).
function refundedParts_(purchaseId, entries, loans) {
  var parts = {};
  entries.forEach(function (e) {
    if (String(e.refund_of || '') !== String(purchaseId)) return;
    if (e.type === 'expense') parts.me = round2_((parts.me || 0) - Number(e.amount));
    else if (e.type === 'income') parts.me = round2_((parts.me || 0) + Number(e.amount));
  });
  loans.forEach(function (l) {
    if (String(l.refund_of || '') === String(purchaseId)) parts[l.friend_id] = round2_((parts[l.friend_id] || 0) + Number(l.amount));
  });
  return parts;
}

function sumParts_(parts) {
  return round2_(Object.keys(parts).reduce(function (n, k) { return n + Number(parts[k] || 0); }, 0));
}

// Every purchase that has refunds: purchase id → refunded parts. Read once per request (listEntries).
function refundPartsByPurchase_() {
  var out = {};
  getAllRows('Entries').forEach(function (e) {
    var p = String(e.refund_of || '');
    if (!p) return;
    var parts = out[p] = out[p] || {};
    if (e.type === 'expense') parts.me = round2_((parts.me || 0) - Number(e.amount));
    else if (e.type === 'income') parts.me = round2_((parts.me || 0) + Number(e.amount));
  });
  getAllRows('Loans').forEach(function (l) {
    var p = String(l.refund_of || '');
    if (!p) return;
    var parts = out[p] = out[p] || {};
    parts[l.friend_id] = round2_((parts[l.friend_id] || 0) + Number(l.amount));
  });
  return out;
}

// The default division of a refund: in the same proportions as the purchase, never more than what is left for anyone. The last
// person takes what rounding leaves, so the parts always add up to the amount.
function defaultRefundParts_(amount, shares, refunded) {
  var left = {};
  Object.keys(shares).forEach(function (k) { left[k] = Math.max(0, round2_(shares[k] - (refunded[k] || 0))); });
  var keys = Object.keys(left).filter(function (k) { return left[k] > 0.004; });
  var totalLeft = keys.reduce(function (n, k) { return n + left[k]; }, 0);
  var parts = {};
  if (!keys.length || !(totalLeft > 0)) return parts;
  var given = 0;
  keys.forEach(function (k, i) {
    var v = i === keys.length - 1 ? round2_(amount - given) : round2_(amount * left[k] / totalLeft);
    parts[k] = Math.min(v, left[k]);
    given = round2_(given + parts[k]);
  });
  return parts;
}

function refundPurchase_(id) {
  var p = getEntryById_(id);
  if (!p || p.type !== 'expense' || p.status !== 'confirmed' || !(Number(p.amount) > 0) || String(p.refund_of || '')) throw new Error(tr_('refund.notAPurchase'));
  return p;
}

/**
 * Records money back on a purchase, or notes that it is on its way.
 * payload: { entry_id, amount, waiting?, expected_by?, date?, payment_method_id?, back_to? ('' = the account; a friend id = that
 * friend got it), parts? ({ me, <friend id>: amount }; default = like the purchase) }
 */
function recordRefund(payload) {
  payload = payload || {};
  return withScriptLockOnce_(function () {
    var purchase = refundPurchase_(payload.entry_id);
    var amount = round2_(Number(payload.amount));
    var splits = getEntrySplits(purchase.id);
    var shares = purchaseShares_(purchase, splits);
    var refunded = refundedParts_(purchase.id, getAllRows('Entries'), getAllRows('Loans'));
    var leftTotal = round2_(Number(purchase.amount) - sumParts_(refunded));
    if (!(amount > 0)) throw new Error(tr_('err.validAmount'));
    if (amount > leftTotal + 0.004) throw new Error(tr_('refund.tooMuch', { max: exportMoney_(Math.max(0, leftTotal)), cur: purchase.currency }));

    if (payload.waiting === true || payload.waiting === 'true') {
      var by = String(payload.expected_by || '');
      if (by && !validIsoDate_(by)) throw new Error(tr_('err.dateRequired'));
      ensureRefundExpectedColumns_();
      updateRowFields_('Entries', purchase.id, { refund_expected: amount, refund_expected_by: by });
      return { expected: true, entry_id: purchase.id, amount: amount };
    }

    var date = String(payload.date || businessToday_()).substring(0, 10);
    if (!validIsoDate_(date)) throw new Error(tr_('err.dateRequired'));
    if (date < String(purchase.date).substring(0, 10)) throw new Error(tr_('refund.beforePurchase'));
    var backTo = String(payload.back_to || '');
    var toFriend = backTo && backTo !== 'me';
    if (toFriend && backTo !== String(purchase.paid_by)) throw new Error(tr_('refund.backToPayerOnly'));
    var pmId = toFriend ? '' : String(payload.payment_method_id || '');
    if (!toFriend) {
      if (!pmId || !getAllRows('Payment Methods').some(function (p) { return String(p.id) === pmId; })) throw new Error(tr_('refund.needsAccount'));
    }

    var parts = payload.parts && typeof payload.parts === 'object' ? {} : defaultRefundParts_(amount, shares, refunded);
    if (payload.parts && typeof payload.parts === 'object') {
      Object.keys(payload.parts).forEach(function (k) { var v = round2_(Number(payload.parts[k])); if (v > 0) parts[k] = v; });
    }
    Object.keys(parts).forEach(function (k) {
      if (shares[k] === undefined) throw new Error(tr_('refund.notOnPurchase'));
      if (parts[k] > round2_(shares[k] - (refunded[k] || 0)) + 0.004) {
        throw new Error(tr_('refund.partTooMuch', { name: k === 'me' ? tr_('refund.you') : friendName_(k), max: exportMoney_(Math.max(0, round2_(shares[k] - (refunded[k] || 0)))), cur: purchase.currency }));
      }
    });
    if (Math.abs(sumParts_(parts) - amount) > 0.004) throw new Error(tr_('refund.partsDontAdd', { amount: exportMoney_(amount), cur: purchase.currency }));
    // Money back on the friend's own card: their part is their own money back (nothing for this app to record).
    if (toFriend) delete parts[backTo];

    ensureRefundColumns_();
    var desc = tr_('refund.desc', { what: String(purchase.description || '') || refundCategoryName_(purchase) });
    var sameMonth = date.substring(0, 7) === String(purchase.date).substring(0, 7);
    var made = null, loans = [];
    var mine = round2_(parts.me || 0);
    if (mine > 0) {
      made = {
        id: Utilities.getUuid(), date: date, currency: purchase.currency, description: desc, payment_method_id: pmId,
        status: 'confirmed', source: 'manual', external_id: '', import_batch_id: '', created_at: nowStamp_(), refund_of: purchase.id,
        company_id: purchase.company_id || '', project_id: purchase.project_id || ''
      };
      if (sameMonth) {
        Object.assign(made, { type: 'expense', amount: -mine, category_id: purchase.category_id || '', paid_by: 'me', trip_id: purchase.trip_id || '' });
      } else {
        Object.assign(made, { type: 'income', amount: mine, category_id: refundsCategory_().id, paid_by: '' });
      }
      if (made.trip_id) ensureEntriesTripColumn_();
      appendRowObject('Entries', made);
      if (sameMonth) {
        getAllRows('Entry Tags').filter(function (t) { return t.entry_id === purchase.id; })
          .forEach(function (t) { appendRowObject('Entry Tags', { entry_id: made.id, tag_id: t.tag_id }); });
      }
      if (toFriend) {
        // The friend holds the person's part now: they owe it (it nets against what the person owed them for the purchase).
        var owed = createLoan_({ friend_id: backTo, direction: 'they_owe_me', origin: 'entry', entry_id: made.id, amount: mine,
          currency: purchase.currency, date: date, description: desc });
        loans.push(owed.id);
      }
    }
    if (!toFriend) {
      Object.keys(parts).forEach(function (fid) {
        if (fid === 'me' || !(parts[fid] > 0)) return;
        // The friend's part arrived in the person's account: the person owes it to them. Its money entry carries refund_of too, so a
        // statement line of the whole refund is recognised as these pieces together (StatementMatch.gs).
        var loan = createLoan_({ friend_id: fid, direction: 'i_owe_them', origin: 'cash', amount: parts[fid], currency: purchase.currency,
          date: date, payment_method_id: pmId, description: desc });
        updateRowFields_('Loans', loan.id, { refund_of: purchase.id });
        if (loan.transfer_entry_id) updateRowFields_('Entries', loan.transfer_entry_id, { refund_of: purchase.id });
        loans.push(loan.id);
      });
    }
    if (Number(purchase.refund_expected) > 0) updateRowFields_('Entries', purchase.id, { refund_expected: '', refund_expected_by: '' });
    return { entry: made ? getEntryById_(made.id) : null, kind: made ? (sameMonth ? 'offset' : 'income') : 'friends', loans: loans, parts: parts };
  });
}

function refundCategoryName_(purchase) {
  var cat = getAllRows('Categories').find(function (c) { return c.id === purchase.category_id; });
  return cat ? categoryLabel_(cat) : '';
}

function friendName_(id) {
  var f = getAllRows('Friends').find(function (x) { return String(x.id) === String(id); });
  return f ? String(f.name) : '';
}

// "It won't come": the note goes away.
function cancelExpectedRefund(payload) {
  var p = getEntryById_(payload && payload.entry_id);
  if (!p) throw new Error(tr_('err.entryNotFound'));
  if (Number(p.refund_expected) > 0) updateRowFields_('Entries', p.id, { refund_expected: '', refund_expected_by: '' });
  return { ok: true };
}

// Every refund on its way, oldest expected first (Home's "Refunds on the way", the Needs review question).
function listExpectedRefunds_() {
  var rows = getAllRows('Entries');
  if (!rows.length || !rows.some(function (e) { return Number(e.refund_expected) > 0; })) return [];
  var cats = {};
  getAllRows('Categories').forEach(function (c) { cats[c.id] = c; });
  return rows.filter(function (e) { return e.type === 'expense' && e.status === 'confirmed' && Number(e.refund_expected) > 0; }).map(function (e) {
    var cat = cats[e.category_id];
    return { entry_id: e.id, description: String(e.description || ''), amount: round2_(Number(e.refund_expected)), currency: e.currency,
      expected_by: String(e.refund_expected_by || '').substring(0, 10), date: String(e.date).substring(0, 10), payment_method_id: String(e.payment_method_id || ''),
      category_name: cat ? categoryLabel_(cat) : '', category_icon: cat ? cat.icon : '' };
  }).sort(function (a, b) { return (a.expected_by || '9999') < (b.expected_by || '9999') ? -1 : 1; });
}

// A waiting money-in item that could be a refund on its way: same currency and amount, into an account.
function refundMatchForPending_(entry, expected) {
  if (!entry || entry.status !== 'pending' || !expected.length || isPracticeReview_(entry)) return null;
  var into = entry.type === 'income' ? entry.payment_method_id : (entry.type === 'transfer' && !entry.payment_method_id ? entry.to_payment_method_id : '');
  if (!into) return null;
  var amt = Math.abs(Number(entry.amount));
  for (var i = 0; i < expected.length; i++) {
    var x = expected[i];
    if (x.currency === entry.currency && Math.abs(x.amount - amt) < 0.005 && String(entry.date).substring(0, 10) >= x.date) return x;
  }
  return null;
}

// "Yes, that refund": the waiting item becomes the refund (linked, divided like the purchase) and leaves Needs review.
function applyRefundMatch(payload) {
  var pending = getEntryById_(payload && payload.pending_id);
  if (!pending || pending.status !== 'pending') throw new Error(tr_('err.entryNotFound'));
  var match = refundMatchForPending_(pending, listExpectedRefunds_().filter(function (x) { return x.entry_id === String(payload.entry_id); }));
  if (!match) throw new Error(tr_('refund.noLongerMatches'));
  var into = pending.type === 'income' ? pending.payment_method_id : pending.to_payment_method_id;
  var result = recordRefund({ entry_id: match.entry_id, amount: Math.abs(Number(pending.amount)), date: String(pending.date).substring(0, 10), payment_method_id: into });
  deleteEntry_(pending.id);
  return result;
}

// Before an edit is written (updateEntryFromApp_): a refund keeps its kind and stays within what is left of its purchase (typed
// positive, a minus refund is stored minus again); a purchase can never go below what came back. Returns what to do after it.
function refundEditGuard_(entryId, fields) {
  if (!fields) return null;
  var entry = getEntryById_(entryId);
  if (!entry) return null;
  var purchaseId = String(entry.refund_of || '');
  if (purchaseId && entry.type !== 'transfer') {
    if (fields.type !== undefined && fields.type !== entry.type) throw new Error(tr_('refund.typeLocked'));
    if (fields.amount === undefined) return null;
    var size = round2_(Math.abs(Number(fields.amount)));
    var purchase = getEntryById_(purchaseId);
    if (purchase) {
      var refunded = refundedParts_(purchaseId, getAllRows('Entries'), getAllRows('Loans'));
      var shares = purchaseShares_(purchase, getEntrySplits(purchaseId));
      var thisOne = entry.type === 'expense' ? -Number(entry.amount) : Number(entry.amount);
      var max = round2_((shares.me || 0) - (refunded.me || 0) + thisOne);
      if (size > max + 0.004) throw new Error(tr_('refund.tooMuch', { max: exportMoney_(Math.max(0, max)), cur: purchase.currency }));
    }
    if (!(size > 0)) throw new Error(tr_('err.validAmount'));
    fields.amount = entry.type === 'expense' ? -size : size;
    var owed = getAllRows('Loans').find(function (l) { return l.origin === 'entry' && l.entry_id === entryId && l.direction === 'they_owe_me'; });
    if (!owed) return null;
    return function () { if (!protectedLoanIds_()[owed.id]) updateRowFields_('Loans', owed.id, { amount: size }); };
  }
  if (entry.type === 'expense' && fields.amount !== undefined) {
    var back = refundedParts_(entryId, getAllRows('Entries'), getAllRows('Loans'));
    var backTotal = sumParts_(back);
    if (backTotal > 0.004 && Number(fields.amount) < backTotal - 0.004) throw new Error(tr_('refund.belowRefunded', { amount: exportMoney_(backTotal), cur: entry.currency }));
  }
  return null;
}

/**
 * A purchase is being deleted (any way): its refunds are not left pointing at nothing. mode 'delete' removes them too (the person's
 * refunds and the friends' parts no repayment touched yet); anything else keeps them as plain Refunds income (a minus expense would
 * mean nothing without its purchase). The note of a refund on its way goes with the purchase's row.
 */
function releaseRefundsOf_(purchaseId, mode) {
  var entries = getAllRows('Entries').filter(function (e) { return String(e.refund_of || '') === String(purchaseId); });
  var loans = getAllRows('Loans').filter(function (l) { return String(l.refund_of || '') === String(purchaseId); });
  if (!entries.length && !loans.length) return;
  if (mode === 'delete') {
    var protectedIds = protectedLoanIds_();
    loans.forEach(function (l) {
      if (protectedIds[l.id]) { updateRowFields_('Loans', l.id, { refund_of: '' }); return; }
      deleteRowsWhere_('Loans', function (row) { return row.id === l.id; });
      if (l.transfer_entry_id) deleteEntry_(l.transfer_entry_id);
    });
    entries.forEach(function (e) { if (e.type !== 'transfer' && getEntryById_(e.id)) deleteEntry_(e.id); });
    return;
  }
  var refundsCatId = null;
  entries.forEach(function (e) {
    if (e.type === 'expense') {
      refundsCatId = refundsCatId || refundsCategory_().id;
      var asIncome = { type: 'income', amount: -Number(e.amount), category_id: refundsCatId, paid_by: '', refund_of: '' };
      if (e.trip_id) asIncome.trip_id = '';
      updateRowFields_('Entries', e.id, asIncome);
      deleteRowsWhere_('Entry Tags', function (row) { return row.entry_id === e.id; });
    } else {
      updateRowFields_('Entries', e.id, { refund_of: '' });
    }
  });
  loans.forEach(function (l) { updateRowFields_('Loans', l.id, { refund_of: '' }); });
}

// What deleting this purchase must ask about (getEntryRepaymentLinks): its refunds, per currency.
function purchaseRefundSummary_(entryId) {
  var parts = refundedParts_(entryId, getAllRows('Entries'), getAllRows('Loans'));
  var total = sumParts_(parts);
  if (!(total > 0.004)) return null;
  var p = getEntryById_(entryId);
  return { amount: total, currency: p ? p.currency : '' };
}
