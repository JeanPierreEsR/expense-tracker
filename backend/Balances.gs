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
  if (memoHasColumns_(sheetName, [header])) return;   // already there (read earlier in this request)
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  if (headers.indexOf(header) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(header);
  }
}

// Entries.exchange = "1" on each leg of a currency exchange (the "Currency exchange" type of transfer).
function ensureEntriesExchangeColumn_() {
  ensureColumn_('Entries', 'exchange');
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

// as_of (added after the sheet first shipped): the exact moment the
// starting balance was saved, for a balance dated today — see
// entryCountsAfterOpening_. Older rows simply lack it.
function ensureAccountOpeningBalancesAsOfColumn_() {
  ensureAccountOpeningBalancesSheet_();
  ensureColumn_('Account Opening Balances', 'as_of');
  ensureColumn_('Account Opening Balances', 'not_yet');
}

// not_yet (owner, 2026-11-11): entry ids the person marked "Not yet (in process)" when saving the starting balance. They were recorded
// before the balance was typed, but had not left the bank yet, so they count AFTER it. Stored "id1,id2"; read as a list.
function notYetList_(value) {
  return String(value || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; });
}

// Map of payment_method_id -> [{currency, amount, date}], from the new
// sheet, with the legacy single-balance columns as a per-account fallback.
function buildOpeningsByPm_(pms) {
  ensureAccountOpeningBalancesAsOfColumn_();
  var byPm = {};
  getAllRows('Account Opening Balances').forEach(function (r) {
    if (!byPm[r.payment_method_id]) byPm[r.payment_method_id] = [];
    byPm[r.payment_method_id].push({
      currency: String(r.currency || homeCurrency_()).toUpperCase(),
      amount: Number(r.amount) || 0,
      date: r.date || '',
      as_of: r.as_of || '',
      not_yet: notYetList_(r.not_yet)
    });
  });
  pms.forEach(function (pm) {
    if (byPm[pm.id]) return;
    if (pm.opening_balance !== undefined && pm.opening_balance !== '' && pm.opening_balance !== null) {
      byPm[pm.id] = [{
        currency: String(pm.opening_balance_currency || homeCurrency_()).toUpperCase(),
        amount: Number(pm.opening_balance) || 0,
        date: pm.opening_balance_date || ''
      }];
    }
  });
  return byPm;
}

// The opening (date + exact moment) that governs entries in `currency`:
// that currency's own, else the account's earliest one.
function openingForCurrency_(openings, currency) {
  var own = openings.find(function (o) { return o.currency === currency; });
  if (own) return own;
  var earliest = null;
  openings.forEach(function (o) {
    if (o.date && (!earliest || o.date < earliest.date)) earliest = o;
  });
  return earliest;
}

// A starting balance is a snapshot of what the real account held at
// some moment. Entries dated AFTER its date always count. Entries dated
// ON the same day only count if they were logged after the snapshot
// (created_at) — otherwise they're already inside the balance the owner
// typed in, and counting them again would double them. A row with no
// as_of (dated a past day, or saved before this existed) is the END of
// that day (owner's rule, 2026-10-31): every entry dated that day is
// already inside it, only later days count.
//
// One refinement for a snapshot taken from a STATEMENT closing on that day: an
// entry dated on the closing day but logged after the snapshot's moment is
// still inside the statement's closing balance when the statement itself
// covers it — a line matched to it, or the entry was recorded/added from a line
// (the statement import creates fees and transfers dated on the closing day
// AFTER it stamps the balance). Without this such an entry was subtracted a
// second time. An entry no statement line covers still counts, as before.
function entryCountsAfterOpening_(entry, opening) {
  if (!opening || !opening.date) return true;
  if (entry.date > opening.date) return true;
  if (opening.not_yet && opening.not_yet.indexOf(String(entry.id)) !== -1) return true;   // marked "Not yet" when the balance was saved
  // A BANK E-MAIL that arrived after the balance was saved, for a purchase of the balance's last days (owner's option C, 2026-11-11):
  // the bank was still processing it when the balance was typed, so it counts after the balance. An entry typed by hand later stays
  // inside (it usually catches up on something already posted). Only for a balance with a saved moment, and never for an entry a
  // statement line covers (that statement's closing already holds it).
  if (entry.date < opening.date && String(entry.source || '') === 'email' && opening.as_of && entry.created_at && entry.created_at >= opening.as_of &&
      entry.date >= startNotYetFrom_(opening.date) && !statementCoversEntry_(entry.id, opening.date)) return true;
  if (entry.date < opening.date) return false;
  if (!opening.as_of) return false;
  if (!(entry.created_at && entry.created_at >= opening.as_of)) return false;
  return !statementCoversEntry_(entry.id, opening.date);
}

// entry id -> { periodEnd: true } for entries a statement line covers.
// Memoised for one request (reset in doPost and whenever Statement Lines is
// written). Only outcomes that mean "this line IS this entry" count — an
// ignored or waiting line says nothing about any entry.
var STMT_COVERAGE_MEMO_ = null;
var STMT_COVERING_OUTCOMES_ = { matched: true, added: true, recorded: true, completed: true };

function statementCoversEntry_(entryId, periodEnd) {
  if (!STMT_COVERAGE_MEMO_) {
    STMT_COVERAGE_MEMO_ = {};
    if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Statement Lines')) {
      getAllRows('Statement Lines').forEach(function (r) {
        if (!r.entry_id || !STMT_COVERING_OUTCOMES_[r.outcome]) return;
        (STMT_COVERAGE_MEMO_[r.entry_id] = STMT_COVERAGE_MEMO_[r.entry_id] || {})[String(r.period_end)] = true;
      });
    }
  }
  return !!(STMT_COVERAGE_MEMO_[entryId] && STMT_COVERAGE_MEMO_[entryId][periodEnd]);
}

// A line of any saved statement is this entry (whatever its period): the bank posted it.
function statementCoversAny_(entryId) {
  statementCoversEntry_(entryId, '');
  return !!STMT_COVERAGE_MEMO_[entryId];
}
// …on a saved statement whose period ended on or before `date` (it was posted by then).
function statementCoversUpTo_(entryId, date) {
  statementCoversEntry_(entryId, '');
  var m = STMT_COVERAGE_MEMO_[entryId];
  return !!m && Object.keys(m).some(function (end) { return end && end.slice(0, 10) <= date; });
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
  return partnerInboundIds_(inbound);   // a partner's contribution (or one to be decided) is money in (Partners.gs)
}

// Signed effect of one entry on one account (+ in, − out), or 0 when the
// entry doesn't touch it at all.
function signedEffectOnPaymentMethod_(entry, pmId, inboundIds) {
  var amount = Number(entry.amount);
  if (entry.type === 'income') {
    return entry.payment_method_id === pmId ? amount : 0;
  }
  if (entry.type === 'expense') {
    return entry.payment_method_id === pmId ? -amount : 0;
  }
  // Investment: money out of the paying account (a withdrawal is a negative
  // amount, so it comes back in); the platform, if named, gets the mirror.
  if (entry.type === 'investment') {
    var inv = 0;
    if (entry.payment_method_id === pmId) inv -= amount;
    if (entry.to_payment_method_id === pmId) inv += amount;
    return inv;
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
    if (!entryCountsAfterOpening_(e, openingForCurrency_(openings, e.currency || homeCurrency_()))) return;
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
  return Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM');
}

// One row per tracked account — `balances` has a line per currency that
// account has actually moved in (the starting balance's own currency is
// always present, even at 0). `balance_pen` is the PEN total across those
// lines at the latest rate on file, or null if any line has no rate.
function listPaymentMethodBalances() {
  var allPms = getAllRows('Payment Methods');
  var openingsByPm = buildOpeningsByPm_(allPms);
  var pms = allPms.filter(function (pm) { return openingsByPm[pm.id]; });
  var fromStatements = cardOwedFromStatements_(allPms, openingsByPm);   // cards with no starting balance, from their last statement
  if (!pms.length) return fromStatements;
  var entries = confirmedEntries_();
  var inboundIds = buildInboundTransferIds_();
  var banksById = {};
  getAllRows('Banks').forEach(function (b) { banksById[b.id] = b.name; });
  var month = todayMonthKey_();
  // A credit card with a starting balance shows its live balance AND its last statement's pay-by line (owner, 2026-11-18).
  var liveCards = {};
  pms.forEach(function (pm) { if (pm.type === 'credit') liveCards[pm.id] = pm; });
  var cardStatements = cardLastStatements_(liveCards);

  return pms.map(function (pm) {
    var openings = openingsByPm[pm.id];
    var baseCurrency = openings[0].currency;
    var totals = {};
    openings.forEach(function (o) { totals[o.currency] = (totals[o.currency] || 0) + o.amount; });
    movementsForPaymentMethod_(pm, openings, entries, inboundIds).forEach(function (m) {
      var cur = m.entry.currency || homeCurrency_();
      totals[cur] = (totals[cur] || 0) + m.signed;
    });

    // What this account still waits to know the charge of (Charges.gs): shown apart, because it is not this currency's real money yet.
    var waiting = {};
    entries.forEach(function (e) { if (e.payment_method_id === pm.id && isChargePending_(e)) waiting[e.currency] = true; });
    var balancePen = 0;
    var balances = Object.keys(totals).map(function (cur) {
      var amount = Math.round(totals[cur] * 100) / 100;
      var rate = cur === homeCurrency_() ? 1 : getLatestRateOnOrBefore_(cur, month);
      var amountPen = rate != null ? amount * rate : null;
      if (amountPen == null || balancePen == null) balancePen = null;
      else balancePen += amountPen;
      return waiting[cur] ? { currency: cur, amount: amount, amount_pen: amountPen, waiting: true } : { currency: cur, amount: amount, amount_pen: amountPen };
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
      balance_pen: balancePen == null ? null : Math.round(balancePen * 100) / 100,
      card_statement: cardStatements[pm.id] || null
    };
  }).sort(function (a, b) {
    var ap = a.balance_pen == null ? -Infinity : a.balance_pen;
    var bp = b.balance_pen == null ? -Infinity : b.balance_pen;
    return bp - ap;
  }).concat(fromStatements);
}

// What a card owed when its last statement closed (owner's plan, 2026-11-17, after the journeys run: Marta never saw what her two cards
// owed). For credit cards with no starting balance of their own: the newest saved statement's closing balance per currency
// (`Statement Uploads.closing_json`, negative = owed). Not a live balance: the row says `statement_closed` and Overview labels it so and
// leaves it out of the totals. Nothing is written.
function cardOwedFromStatements_(allPms, openingsByPm) {
  var cards = {};
  allPms.forEach(function (pm) { if (pm.type === 'credit' && !openingsByPm[pm.id] && String(pm.hidden || '') !== 'yes') cards[pm.id] = pm; });
  var info = cardLastStatements_(cards), banksById = {};
  if (!Object.keys(info).length) return [];
  getAllRows('Banks').forEach(function (b) { banksById[b.id] = b.name; });
  return Object.keys(info).map(function (id) {
    var pm = cards[id], st = info[id];
    return { id: pm.id, nickname: pm.nickname, type: pm.type, last_4: pm.last_4, bank_name: banksById[pm.bank_id] || '', openings: [],
      balances: st.balances, balance_pen: null, statement_closed: st.statement_closed, due: st.due, paid_since: st.paid_since, last_paid: st.last_paid, covered_on: st.covered_on };
  });
}

// A card's last saved statement: what it owed when it closed (per currency, negative = owed), its pay-by date, and the payments INTO the
// card recorded after the close (a transfer to it, from a bank e-mail, a savings statement's "PAGO TARJETA" or typed by hand), per
// currency: what the card's pay-by line weighs against what was owed (owner, 2026-11-18). A refund on the card is not a payment; one made
// before the close is already inside the statement. `cards` = { id: Payment Method }; answers { id: info } for the cards with one.
function cardLastStatements_(cards) {
  if (!Object.keys(cards).length) return {};
  var latest = {};
  try { ensureStatementUploadsSheet_(); } catch (e) { return {}; }
  getAllRows('Statement Uploads').forEach(function (u) {
    if (!cards[u.payment_method_id] || !u.closing_json) return;
    if (!latest[u.payment_method_id] || String(u.period_end) > String(latest[u.payment_method_id].period_end)) latest[u.payment_method_id] = u;
  });
  if (!Object.keys(latest).length) return {};
  var paymentsByCard = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status === 'confirmed' && e.type === 'transfer' && cards[e.to_payment_method_id]) (paymentsByCard[e.to_payment_method_id] = paymentsByCard[e.to_payment_method_id] || []).push(e);
  });
  var out = {};
  Object.keys(latest).forEach(function (id) {
    var u = latest[id], closing = {};
    try { closing = JSON.parse(String(u.closing_json)) || {}; } catch (e) { return; }
    var balances = Object.keys(closing).filter(function (cur) { return cur.charAt(0) !== '_' && closing[cur] && isFinite(Number(closing[cur].closing)); })
      .map(function (cur) { return { currency: cur, amount: Math.round(Number(closing[cur].closing) * 100) / 100 }; })
      .sort(function (a, b) { return a.currency === homeCurrency_() ? -1 : b.currency === homeCurrency_() ? 1 : (a.currency < b.currency ? -1 : 1); });
    if (!balances.length) return;
    // `covered_on`: the day the payments, in date order, first reached what the statement owed, per currency (the latest of those days
    // when it owed in several). A payment after that pays the next, still-open cycle early (e.g. to free credit line) and does not
    // move it (owner, 2026-11-18). Empty while anything owed is not yet covered.
    var paid = {}, lastPaid = '', coveredBy = {}, owedBy = {};
    balances.forEach(function (b) { if (b.amount < -0.004) owedBy[b.currency] = -b.amount; });
    (paymentsByCard[id] || []).filter(function (e) { return String(e.date) > String(u.period_end); })
      .sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : 0; })
      .forEach(function (e) {
        var d = String(e.date).substring(0, 10);
        paid[e.currency] = Math.round(((paid[e.currency] || 0) + Math.abs(Number(e.amount))) * 100) / 100;
        if (d > lastPaid) lastPaid = d;
        if (owedBy[e.currency] != null && !coveredBy[e.currency] && paid[e.currency] >= owedBy[e.currency] - 0.005) coveredBy[e.currency] = d;
      });
    var owedCurs = Object.keys(owedBy), coveredOn = '';
    if (owedCurs.length && owedCurs.every(function (c) { return coveredBy[c]; })) owedCurs.forEach(function (c) { if (coveredBy[c] > coveredOn) coveredOn = coveredBy[c]; });
    out[id] = { statement_closed: String(u.period_end), balances: balances,
      due: realDueAfter_(closing._due, u.period_end), paid_since: paid, last_paid: lastPaid, covered_on: coveredOn };
  });
  return out;
}

// Every movement that feeds one account's balance, newest first — what
// the balance detail sheet lists so a difference can be traced by hand.
function getPaymentMethodMovements(payload) {
  var pm = getAllRows('Payment Methods').find(function (p) { return p.id === payload.paymentMethodId; });
  if (!pm) throw new Error(tr_('err.paymentMethodNotFound'));
  var allPms = getAllRows('Payment Methods');
  var pmsById = {};
  allPms.forEach(function (p) { pmsById[p.id] = p; });
  var openings = buildOpeningsByPm_(allPms)[pm.id] || [];
  var movements = movementsForPaymentMethod_(pm, openings, confirmedEntries_(), buildInboundTransferIds_());
  movements.sort(function (a, b) { return compareEntriesRecency_(a.entry, b.entry); });
  return movements.map(function (m) {
    var e = m.entry;
    var other = '';
    if (e.type === 'transfer' || e.type === 'investment') {
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
  ensureAccountOpeningBalancesAsOfColumn_();
  var pmSheet = getSheet('Payment Methods');
  var pmHeaders = getHeaders(pmSheet);
  var rowIndex = findRowIndexById(pmSheet, pmHeaders, payload.id);
  if (rowIndex === -1) throw new Error(tr_('err.paymentMethodNotFound'));

  var list = payload.balances || [];
  var seen = {};
  var clean = list.map(function (b) {
    var currency = String(b.currency || homeCurrency_()).toUpperCase();
    if (seen[currency]) throw new Error(tr_('bal.listedOnce', { cur: currency }));
    seen[currency] = true;
    if (b.amount === '' || b.amount === null || b.amount === undefined || isNaN(Number(b.amount))) {
      throw new Error(tr_('bal.validBalance', { cur: currency }));
    }
    if (!b.date) throw new Error(tr_('bal.pickFromDate', { cur: currency }));
    var out = { currency: currency, amount: Number(b.amount), date: String(b.date) };
    if (Array.isArray(b.not_yet)) out.not_yet = b.not_yet.map(String).filter(function (x) { return x && x.indexOf(',') === -1; });
    return out;
  });

  // A row left unchanged (same currency, amount and date) keeps its
  // original snapshot moment — re-saving the account to edit ANOTHER
  // currency must not slide this one's snapshot forward and drop entries
  // that were logged in between.
  var previous = getAllRows('Account Opening Balances').filter(function (r) { return r.payment_method_id === payload.id; });
  var now = nowTimestamp_();
  var today = now.substring(0, 10);
  clean.forEach(function (b) {
    var prev = previous.find(function (r) {
      return String(r.currency).toUpperCase() === b.currency && Number(r.amount) === b.amount && r.date === b.date;
    });
    if (prev && prev.as_of) b.as_of = prev.as_of;
    else b.as_of = b.date === today ? now : '';
    // The "Not yet" marks: what the phone sent, else (a phone on an older release, or an untouched row) what this currency had.
    if (!b.not_yet) {
      var same = previous.find(function (r) { return String(r.currency).toUpperCase() === b.currency && r.date === b.date; });
      b.not_yet = same ? notYetList_(same.not_yet) : [];
    }
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
    var asOfCell = sheet.getRange(sheet.getLastRow(), headers.indexOf('as_of') + 1);
    asOfCell.setNumberFormat('@');
    asOfCell.setValue(b.as_of);
    if (b.not_yet.length) sheet.getRange(sheet.getLastRow(), headers.indexOf('not_yet') + 1).setValue(b.not_yet.join(','));
  });

  ['opening_balance', 'opening_balance_date', 'opening_balance_currency'].forEach(function (col) {
    setCellByRow_(pmSheet, pmHeaders, rowIndex, col, '');
  });
  return { done: true };
}


// ---- "Is this already in your bank's balance?" (owner, 2026-11-11) ----
// When a starting balance is saved, the phone lists this account's entries of the 3 days up to the balance's date that the balance
// would take as already inside it (recorded before the moment it is saved), so the person can mark the ones still in process "Not
// yet". payload: { id, rows: [{ currency, date }] }. Answers { currency: [{ id, date, description, signed, type, created_at }] },
// newest first. Read-only.
var START_NOT_YET_DAYS_ = 3;   // owner, 2026-11-11 (was 5)
function listStartBalanceCandidates(payload) {
  var pm = getAllRows('Payment Methods').find(function (p) { return p.id === payload.id; });
  if (!pm) throw new Error(tr_('err.paymentMethodNotFound'));
  var inboundIds = buildInboundTransferIds_();
  var entries = confirmedEntries_();
  var out = {};
  (payload.rows || []).forEach(function (row) {
    var cur = String(row.currency || homeCurrency_()).toUpperCase(), date = String(row.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    var from = startNotYetFrom_(date);
    var list = [];
    entries.forEach(function (e) {
      var d = String(e.date || '').slice(0, 10);
      if ((e.currency || homeCurrency_()) !== cur || d < from || d > date) return;
      var signed = signedEffectOnPaymentMethod_(e, pm.id, inboundIds);
      if (!signed) return;
      list.push({ id: e.id, date: d, description: String(e.description || ''), type: e.type, signed: Math.round(signed * 100) / 100,
        created_at: String(e.created_at || '') });
    });
    list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.created_at < b.created_at ? 1 : -1); });
    out[cur] = list;
  });
  // Every currency this account has confirmed movements in, at any date: a new account's form asks for each (testers, 2026-11-11).
  var moved = {};
  entries.forEach(function (e) { if (signedEffectOnPaymentMethod_(e, pm.id, inboundIds)) moved[e.currency || homeCurrency_()] = true; });
  out.__moved = Object.keys(moved).sort();
  return out;
}
function startNotYetFrom_(date) {
  var d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (START_NOT_YET_DAYS_ - 1));
  return d.toISOString().slice(0, 10);
}

// A statement's pay-by date only if it is a real calendar day after the statement closed (Ingrid, 2026-11-18: a hand-typed 2026-02-30
// showed as "was due Mar 2"). Anything else is left out, like a date in another format.
function realDueAfter_(due, closed) {
  var d = String(due || '');
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return '';
  var t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (t.getUTCMonth() !== +m[2] - 1 || t.getUTCDate() !== +m[3]) return '';
  return d > String(closed || '').substring(0, 10) ? d : '';
}

// A card's pay-by date typed by the person (owner's plan, 2026-11-18: Diners prints it as something that is not text). The gap in days
// between the newest saved statement that has a pay-by date and that date: the next statement's box is filled with the same gap.
// '' when the card never had one.
function cardDueGapDays_(pmId) {
  var best = null;
  try { ensureStatementUploadsSheet_(); } catch (e) { return ''; }
  getAllRows('Statement Uploads').forEach(function (u) {
    if (String(u.payment_method_id) !== String(pmId) || !u.closing_json) return;
    var c = {};
    try { c = JSON.parse(String(u.closing_json)) || {}; } catch (e) { return; }
    var due = realDueAfter_(c._due, u.period_end);
    if (due && (!best || String(u.period_end) > best.end)) best = { end: String(u.period_end).substring(0, 10), due: due };
  });
  if (!best) return '';
  return Math.round((Date.parse(best.due + 'T12:00:00Z') - Date.parse(best.end + 'T12:00:00Z')) / 86400000);
}
function addDaysIso_(iso, n) {
  var d = new Date(String(iso).substring(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The pay-by date of a card's LAST saved statement, typed on the card's screen (owner's plan, 2026-11-18): for a statement saved without
// one. Only a real day after that statement closed; written into its `closing_json` as `_due`, like a date read from the file.
function setCardStatementDue(payload) {
  var pmId = String((payload && payload.id) || '');
  ensureStatementUploadsSheet_();
  var sheet = getSheet('Statement Uploads');
  var headers = getHeaders(sheet);
  var latest = null;
  getAllRows('Statement Uploads').forEach(function (u) {
    if (String(u.payment_method_id) === pmId && u.closing_json && (!latest || String(u.period_end) > String(latest.period_end))) latest = u;
  });
  if (!latest) throw new Error(tr_('err.cardNoStatement'));
  var due = realDueAfter_(payload.due, latest.period_end);
  if (!due) throw new Error(tr_('err.cardDueAfterClose'));
  var c = {};
  try { c = JSON.parse(String(latest.closing_json)) || {}; } catch (e) { c = {}; }
  c._due = due;
  setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, latest.id), 'closing_json', JSON.stringify(c));
  return { ok: true, due: due };
}
