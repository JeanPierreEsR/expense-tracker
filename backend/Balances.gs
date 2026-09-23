// ---- Account balances ----
//
// Not part of the original spec — lets the owner see what each account
// (a cash wallet, Yape, a loyalty wallet like Starbucks, a bank account)
// should currently hold, and check it against the real app/statement.
//
// Nothing is stored except an optional STARTING balance on the Payment
// Methods row (`opening_balance`, `opening_balance_date`,
// `opening_balance_currency`). A payment method with no opening_balance
// simply isn't tracked — setting one is never required. The current
// balance is always derived fresh: starting balance plus every confirmed
// movement dated on/after the starting-balance date (same "derive, don't
// store" rule as own_share/amount_pen).
//
// Movements, per account:
//   expense / investment paid with it  → money out (the FULL amount paid,
//                                        not the owner's share — the whole
//                                        thing left the account)
//   income received into it            → money in
//   transfer, "from" this account      → money out
//   transfer, "to" this account        → money in (Entries.to_payment_method_id)
//   loan/repayment transfers           → the direction depends on which way
//                                        the money actually moved, derived
//                                        from the linked Loan/Settlement
//                                        (see buildInboundTransferIds_)

function ensureColumn_(sheetName, header) {
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  if (headers.indexOf(header) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(header);
  }
}

function ensureEntriesToPaymentMethodColumn_() {
  ensureColumn_('Entries', 'to_payment_method_id');
}

function ensurePaymentMethodBalanceColumns_() {
  ensureColumn_('Payment Methods', 'opening_balance');
  ensureColumn_('Payment Methods', 'opening_balance_date');
  ensureColumn_('Payment Methods', 'opening_balance_currency');
}

function isTrackedPaymentMethod_(pm) {
  return pm.opening_balance !== undefined && pm.opening_balance !== '' && pm.opening_balance !== null;
}

// A loan-linked transfer Entry has only one payment method (where the
// cash moved through) and no explicit direction, so it's worked out from
// the Loan/Settlement that created it: money comes IN when someone lends
// the owner cash (cash loan, i_owe_them) or repays the owner (real
// settlement on a they_owe_me loan). Every other loan-linked transfer is
// money going out (lending someone cash, or repaying a debt).
function buildInboundTransferIds_() {
  var inbound = {};
  var loans = getAllRows('Loans');
  var loansById = {};
  loans.forEach(function (l) {
    loansById[l.id] = l;
    if (l.origin === 'cash' && l.transfer_entry_id && l.direction === 'i_owe_them') {
      inbound[l.transfer_entry_id] = true;
    }
  });
  getAllRows('Settlements').forEach(function (s) {
    if (!s.transfer_entry_id || s.offset_loan_id) return;
    var loan = loansById[s.loan_id];
    if (loan && loan.direction === 'they_owe_me') inbound[s.transfer_entry_id] = true;
  });
  return inbound;
}

// Signed effect of one entry on one account (+ in, − out), or 0 when the
// entry doesn't touch it at all.
function signedEffectOnPaymentMethod_(entry, pmId, inboundIds) {
  var amount = Number(entry.amount);
  if (entry.type === 'income') {
    return entry.payment_method_id === pmId ? amount : 0;
  }
  if (entry.type === 'expense' || entry.type === 'investment') {
    return entry.payment_method_id === pmId ? -amount : 0;
  }
  if (entry.type === 'transfer') {
    var effect = 0;
    if (entry.payment_method_id === pmId) effect += inboundIds[entry.id] ? amount : -amount;
    if (entry.to_payment_method_id === pmId) effect += amount;
    return effect;
  }
  return 0;
}

function movementsForPaymentMethod_(pm, entries, inboundIds) {
  var since = pm.opening_balance_date || '';
  var out = [];
  entries.forEach(function (e) {
    if (since && e.date < since) return;
    var signed = signedEffectOnPaymentMethod_(e, pm.id, inboundIds);
    if (signed === 0) return;
    out.push({ entry: e, signed: signed });
  });
  return out;
}

function confirmedEntries_() {
  return getAllRows('Entries').filter(function (e) { return e.status === 'confirmed'; });
}

function todayMonthKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
}

// One row per tracked account — `balances` has a line per currency that
// account has actually moved in (the starting balance's own currency is
// always present, even at 0). `balance_pen` is the PEN total across those
// lines at the latest rate on file, or null if any line has no rate.
function listPaymentMethodBalances() {
  var pms = getAllRows('Payment Methods').filter(isTrackedPaymentMethod_);
  if (!pms.length) return [];
  var entries = confirmedEntries_();
  var inboundIds = buildInboundTransferIds_();
  var banksById = {};
  getAllRows('Banks').forEach(function (b) { banksById[b.id] = b.name; });
  var month = todayMonthKey_();

  return pms.map(function (pm) {
    var baseCurrency = pm.opening_balance_currency || 'PEN';
    var totals = {};
    totals[baseCurrency] = Number(pm.opening_balance) || 0;
    movementsForPaymentMethod_(pm, entries, inboundIds).forEach(function (m) {
      var cur = m.entry.currency || 'PEN';
      totals[cur] = (totals[cur] || 0) + m.signed;
    });

    var balancePen = 0;
    var balances = Object.keys(totals).map(function (cur) {
      var amount = Math.round(totals[cur] * 100) / 100;
      var rate = cur === 'PEN' ? 1 : getLatestRateOnOrBefore_(cur, month);
      var amountPen = rate != null ? amount * rate : null;
      if (amountPen == null || balancePen == null) balancePen = null;
      else balancePen += amountPen;
      return { currency: cur, amount: amount, amount_pen: amountPen };
    }).sort(function (a, b) {
      // The account's own currency first, others after.
      if (a.currency === baseCurrency) return -1;
      if (b.currency === baseCurrency) return 1;
      return a.currency < b.currency ? -1 : 1;
    });

    return {
      id: pm.id,
      nickname: pm.nickname,
      type: pm.type,
      last_4: pm.last_4,
      bank_name: banksById[pm.bank_id] || '',
      opening_balance: Number(pm.opening_balance) || 0,
      opening_balance_date: pm.opening_balance_date || '',
      opening_balance_currency: baseCurrency,
      balances: balances,
      balance_pen: balancePen == null ? null : Math.round(balancePen * 100) / 100
    };
  }).sort(function (a, b) {
    var ap = a.balance_pen == null ? -Infinity : a.balance_pen;
    var bp = b.balance_pen == null ? -Infinity : b.balance_pen;
    return bp - ap;
  });
}

// Every movement that feeds one account's balance, newest first — what
// the balance detail sheet lists so a difference can be traced by hand.
function getPaymentMethodMovements(payload) {
  var pm = getAllRows('Payment Methods').find(function (p) { return p.id === payload.paymentMethodId; });
  if (!pm) throw new Error('Payment method not found');
  var pmsById = {};
  getAllRows('Payment Methods').forEach(function (p) { pmsById[p.id] = p; });
  var movements = movementsForPaymentMethod_(pm, confirmedEntries_(), buildInboundTransferIds_());
  movements.sort(function (a, b) { return compareEntriesRecency_(a.entry, b.entry); });
  return movements.map(function (m) {
    var e = m.entry;
    var other = '';
    if (e.type === 'transfer') {
      var otherId = m.signed < 0 ? e.to_payment_method_id : e.payment_method_id;
      if (otherId && otherId !== pm.id && pmsById[otherId]) other = pmsById[otherId].nickname;
    }
    return {
      id: e.id,
      date: e.date,
      type: e.type,
      description: e.description || '',
      currency: e.currency,
      signed: m.signed,
      other_account: other
    };
  });
}

// Sets (or, with amount = null/'', clears) an account's starting balance.
// Clearing just stops tracking it — nothing else about the account or its
// entries changes.
function setPaymentMethodOpeningBalance(payload) {
  ensurePaymentMethodBalanceColumns_();
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error('Payment method not found');

  var clearing = payload.amount === null || payload.amount === undefined || payload.amount === '';
  if (!clearing && isNaN(Number(payload.amount))) throw new Error('Enter a valid balance.');

  var date = clearing ? '' : String(payload.date || '');
  var currency = clearing ? '' : String(payload.currency || 'PEN').toUpperCase();

  setCellByRow_(sheet, headers, rowIndex, 'opening_balance', clearing ? '' : Number(payload.amount));
  // Plain-text format on the date cell, same reason as setProjectionOverride's
  // period_key: Sheets silently converts date-looking strings otherwise.
  var dateCol = headers.indexOf('opening_balance_date') + 1;
  sheet.getRange(rowIndex, dateCol).setNumberFormat('@');
  setCellByRow_(sheet, headers, rowIndex, 'opening_balance_date', date);
  setCellByRow_(sheet, headers, rowIndex, 'opening_balance_currency', currency);

  return getAllRows('Payment Methods').find(function (p) { return p.id === payload.id; });
}
