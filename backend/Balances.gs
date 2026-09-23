// ---- Account balances ----
//
// Not part of the original spec — lets the owner see what each account
// (a cash wallet, Yape, a loyalty wallet like Starbucks, a bank account)
// should currently hold, and check it against the real app/statement.
//
// Nothing is stored except optional STARTING balances — one per account
// per currency, in the "Account Opening Balances" sheet (`payment_method_id`,
// `currency`, `amount`, `date`). An account with none simply isn't
// tracked — setting one is never required. (Before multi-currency support,
// a single balance lived in three columns on the Payment Methods row; those
// are still read as a fallback for an account with no rows in the new
// sheet, and cleared the next time that account's balances are saved.)
// The current balance is always derived fresh, per currency: that
// currency's starting balance plus every confirmed movement in it dated
// on/after its starting date (same "derive, don't store" rule as
// own_share/amount_pen). A currency with movements but no starting
// balance of its own counts from the account's EARLIEST starting date.
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

function ensureAccountOpeningBalancesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Account Opening Balances')) return;
  var sheet = ss.insertSheet('Account Opening Balances');
  var headers = TABLE_DEFINITIONS['Account Opening Balances'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

// Map of payment_method_id -> [{currency, amount, date}], from the new
// sheet, with the legacy single-balance columns as a per-account fallback.
function buildOpeningsByPm_(pms) {
  ensureAccountOpeningBalancesSheet_();
  var byPm = {};
  getAllRows('Account Opening Balances').forEach(function (r) {
    if (!byPm[r.payment_method_id]) byPm[r.payment_method_id] = [];
    byPm[r.payment_method_id].push({
      currency: String(r.currency || 'PEN').toUpperCase(),
      amount: Number(r.amount) || 0,
      date: r.date || ''
    });
  });
  pms.forEach(function (pm) {
    if (byPm[pm.id]) return;
    if (pm.opening_balance !== undefined && pm.opening_balance !== '' && pm.opening_balance !== null) {
      byPm[pm.id] = [{
        currency: String(pm.opening_balance_currency || 'PEN').toUpperCase(),
        amount: Number(pm.opening_balance) || 0,
        date: pm.opening_balance_date || ''
      }];
    }
  });
  return byPm;
}

// The date from which entries in `currency` count toward this account.
function openingSinceDate_(openings, currency) {
  var own = openings.find(function (o) { return o.currency === currency; });
  if (own) return own.date || '';
  var earliest = '';
  openings.forEach(function (o) {
    if (o.date && (!earliest || o.date < earliest)) earliest = o.date;
  });
  return earliest;
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

function movementsForPaymentMethod_(pm, openings, entries, inboundIds) {
  var out = [];
  entries.forEach(function (e) {
    var since = openingSinceDate_(openings, e.currency || 'PEN');
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
  var allPms = getAllRows('Payment Methods');
  var openingsByPm = buildOpeningsByPm_(allPms);
  var pms = allPms.filter(function (pm) { return openingsByPm[pm.id]; });
  if (!pms.length) return [];
  var entries = confirmedEntries_();
  var inboundIds = buildInboundTransferIds_();
  var banksById = {};
  getAllRows('Banks').forEach(function (b) { banksById[b.id] = b.name; });
  var month = todayMonthKey_();

  return pms.map(function (pm) {
    var openings = openingsByPm[pm.id];
    var baseCurrency = openings[0].currency;
    var totals = {};
    openings.forEach(function (o) { totals[o.currency] = (totals[o.currency] || 0) + o.amount; });
    movementsForPaymentMethod_(pm, openings, entries, inboundIds).forEach(function (m) {
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
      // The account's first-entered currency first, others after.
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
      openings: openings,
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
  var allPms = getAllRows('Payment Methods');
  var pmsById = {};
  allPms.forEach(function (p) { pmsById[p.id] = p; });
  var openings = buildOpeningsByPm_(allPms)[pm.id] || [];
  var movements = movementsForPaymentMethod_(pm, openings, confirmedEntries_(), buildInboundTransferIds_());
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

// Replaces an account's whole set of starting balances with
// payload.balances = [{currency, amount, date}] (one per currency); an
// empty list clears them, which just stops tracking the account —
// nothing else about it or its entries changes. Also clears the legacy
// single-balance columns, so they can't resurface as a fallback later.
function setPaymentMethodOpeningBalance(payload) {
  ensureAccountOpeningBalancesSheet_();
  var pmSheet = getSheet('Payment Methods');
  var pmHeaders = getHeaders(pmSheet);
  var rowIndex = findRowIndexById(pmSheet, pmHeaders, payload.id);
  if (rowIndex === -1) throw new Error('Payment method not found');

  var list = payload.balances || [];
  var seen = {};
  var clean = list.map(function (b) {
    var currency = String(b.currency || 'PEN').toUpperCase();
    if (seen[currency]) throw new Error('Each currency can only be listed once (' + currency + ').');
    seen[currency] = true;
    if (b.amount === '' || b.amount === null || b.amount === undefined || isNaN(Number(b.amount))) {
      throw new Error('Enter a valid balance for ' + currency + '.');
    }
    if (!b.date) throw new Error('Pick a from-date for ' + currency + '.');
    return { currency: currency, amount: Number(b.amount), date: String(b.date) };
  });

  deleteRowsWhere_('Account Opening Balances', function (row) { return row.payment_method_id === payload.id; });
  var sheet = getSheet('Account Opening Balances');
  var headers = getHeaders(sheet);
  clean.forEach(function (b) {
    appendRowObject('Account Opening Balances', {
      id: Utilities.getUuid(), payment_method_id: payload.id,
      currency: b.currency, amount: b.amount, date: ''
    });
    // Plain-text date cell, same reason as setProjectionOverride's
    // period_key: Sheets converts date-looking strings otherwise.
    var dateCell = sheet.getRange(sheet.getLastRow(), headers.indexOf('date') + 1);
    dateCell.setNumberFormat('@');
    dateCell.setValue(b.date);
  });

  ['opening_balance', 'opening_balance_date', 'opening_balance_currency'].forEach(function (col) {
    setCellByRow_(pmSheet, pmHeaders, rowIndex, col, '');
  });
  return { done: true };
}
