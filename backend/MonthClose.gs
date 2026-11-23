/**
 * Business 2, Phase 2, piece 8 (owner's plan "Fase 2 en detalle", approved 2026-11-23): CLOSING A MONTH. Company copies only.
 *
 * Closing a month that has ended: first the app-vs-bank check (for each account with a starting balance, the person types what the
 * bank says on the month's last day and the app shows the difference; a difference can still be closed, it stays written down), the
 * items of that month still waiting in Needs review are named, then the month's figures are kept: account balances on its last day,
 * totals per category and currency, what is owed to each lender and partner. With them, a FINGERPRINT of the month (a short code made
 * from all its entries and what hangs on them). If anything in the month changes afterwards, through the app or by hand in the Sheet,
 * the fingerprint no longer matches and the app says "changed after the close", listing the change log's lines for that month made
 * after the close (none listed = it was edited by hand in the Sheet).
 *
 * A closed month can be reopened (owner, 2026-11-23); reopening is written in the change log with its date. Still to ask the company
 * (owner's note): whether any legal record is kept month by month, which decides how strict reopening must be.
 *
 * Tab 'Month Closes': id, month (YYYY-MM, text), status ('closed' | 'reopened'), closed_at, reopened_at, fingerprint, figures (JSON),
 * bank_check (JSON), pending_count, note.
 */

var MONTH_CLOSE_HEADERS_ = ['id', 'month', 'status', 'closed_at', 'reopened_at', 'fingerprint', 'figures', 'bank_check', 'pending_count', 'note',
  'package_sent_at', 'package_to', 'package_fingerprint'];   // piece 10: the accountant's package (AccountantPackage.gs)

function ensureMonthClosesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Month Closes');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Month Closes');
  sheet.getRange(1, 1, 1, MONTH_CLOSE_HEADERS_.length).setValues([MONTH_CLOSE_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), MONTH_CLOSE_HEADERS_.length).setNumberFormat('@');   // "2026-11" must stay text
  sheet.setFrozenRows(1);
  return sheet;
}

function monthCloseRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Month Closes')) return [];
  return getAllRows('Month Closes').map(function (r) {
    var o = {};
    MONTH_CLOSE_HEADERS_.forEach(function (h) { o[h] = changeText_(r[h]); });
    return o;
  });
}

// Months closed right now (for the app's "this month is closed" question). [] outside a company copy.
function closedMonths_() {
  if (!isCompanyCopy_()) return [];
  return monthCloseRows_().filter(function (r) { return r.status === 'closed'; }).map(function (r) { return r.month; }).sort();
}

function monthLastDay_(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  var d = new Date(Date.UTC(y, m, 0));
  return month + '-' + ('0' + d.getUTCDate()).slice(-2);
}

// 'YYYY-MM' when the period is exactly one calendar month, else ''.
function wholeMonthOf_(startDate, endDate) {
  var s = String(startDate || '').slice(0, 10), e = String(endDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-01$/.test(s)) return '';
  return monthLastDay_(s.slice(0, 7)) === e ? s.slice(0, 7) : '';
}

function validMonth_(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) throw new Error(tr_('close.badMonth'));
  return String(month);
}

// The month's entries (waiting ones included: confirming one changes the month) and what hangs on them, as one short code.
function monthFingerprint_(month) {
  var entries = getAllRows('Entries').filter(function (e) {
    return String(e.date).slice(0, 7) === month && (e.status === 'confirmed' || e.status === 'pending');
  });
  var ids = {};
  entries.forEach(function (e) { ids[e.id] = true; });
  var parts = entries.map(function (e) {
    return ['id', 'type', 'date', 'amount', 'currency', 'category_id', 'description', 'payment_method_id', 'to_payment_method_id',
      'paid_by', 'status', 'company_id', 'project_id', 'igv_amount'].map(function (k) { return changeText_(e[k]); }).join('|');
  });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ['Entry Splits', 'Project Splits', 'Contributions', 'Distributions'].forEach(function (t) {
    if (!ss.getSheetByName(t)) return;
    getAllRows(t).forEach(function (r) {
      if (!ids[r.entry_id]) return;
      parts.push(t + ':' + Object.keys(r).sort().map(function (k) { return k + '=' + changeText_(r[k]); }).join('|'));
    });
  });
  parts.sort();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, parts.join('\n'), Utilities.Charset ? Utilities.Charset.UTF_8 : undefined);
  return digest.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? '0' + v : v; }).join('').slice(0, 32);
}

// Each account with a starting balance, its balance per currency at the end of `day` (same rule as the Balances card).
function accountBalancesAt_(day) {
  var allPms = getAllRows('Payment Methods');
  var openingsByPm = buildOpeningsByPm_(allPms);
  var entries = confirmedEntries_().filter(function (e) { return String(e.date).slice(0, 10) <= day; });
  var inboundIds = buildInboundTransferIds_();
  var out = [];
  allPms.forEach(function (pm) {
    var openings = (openingsByPm[pm.id] || []).filter(function (o) { return !o.date || String(o.date).slice(0, 10) <= day; });
    if (!openings.length) return;
    var totals = {};
    openings.forEach(function (o) { totals[o.currency] = (totals[o.currency] || 0) + Number(o.amount); });
    movementsForPaymentMethod_(pm, openings, entries, inboundIds).forEach(function (m) {
      var cur = m.entry.currency || homeCurrency_();
      totals[cur] = (totals[cur] || 0) + m.signed;
    });
    Object.keys(totals).sort().forEach(function (cur) {
      out.push({ payment_method_id: pm.id, nickname: String(pm.nickname || ''), currency: cur, amount: round2_(totals[cur]) });
    });
  });
  return out;
}

// What the close keeps: balances on the last day, totals per category and currency (never converted), lenders and partners owed.
function monthFigures_(month) {
  var totals = {};
  var cats = {};
  getAllRows('Categories').forEach(function (c) { cats[c.id] = c; });
  confirmedEntries_().forEach(function (e) {
    if (String(e.date).slice(0, 7) !== month || (e.type !== 'expense' && e.type !== 'income')) return;
    var k = e.type + '|' + (e.category_id || '') + '|' + e.currency;
    totals[k] = round2_((totals[k] || 0) + Number(e.amount));
  });
  var byCategory = Object.keys(totals).sort().map(function (k) {
    var p = k.split('|');
    return { type: p[0], category_id: p[1], category: cats[p[1]] ? String(cats[p[1]].name) : '', currency: p[2], amount: totals[k] };
  });
  var owed = [];
  listLoanBalances({}).forEach(function (f) {
    if (f.role !== 'lender' && f.role !== 'partner') return;
    f.balances.forEach(function (b) { if (Math.abs(b.net) > 0.004) owed.push({ name: f.friend_name, role: f.role, currency: b.currency, net: round2_(b.net) }); });
  });
  return { balances: accountBalancesAt_(monthLastDay_(month)), byCategory: byCategory, owed: owed };
}

function monthPendingCount_(month) {
  return getAllRows('Entries').filter(function (e) { return e.status === 'pending' && String(e.date).slice(0, 7) === month; }).length;
}

// The state of one month for the app: { month, ended, close (the row, figures parsed) | null, closed, changed, hand_edited,
// changes (change-log lines about the month after the close, newest first, at most 50), pending_count, accounts (balances on the
// last day, for the bank check) }.
function monthCloseState_(month) {
  var today = Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd');
  var ended = monthLastDay_(month) < today;
  var row = monthCloseRows_().filter(function (r) { return r.month === month; })[0] || null;
  var closed = !!row && row.status === 'closed';
  var changed = false, changes = [];
  if (closed) {
    changed = monthFingerprint_(month) !== row.fingerprint;
    if (changed) {
      changes = listChangeLog({ month: month, limit: 1000 }).lines.filter(function (l) { return l.at > row.closed_at && l.table !== 'Month Closes'; }).slice(0, 50);
    }
  }
  var parse = function (s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  return {
    month: month, ended: ended, closed: closed, changed: changed, hand_edited: changed && !changes.length, changes: changes,
    close: row ? { status: row.status, closed_at: row.closed_at, reopened_at: row.reopened_at, figures: parse(row.figures),
      bank_check: parse(row.bank_check) || [], pending_count: Number(row.pending_count) || 0, note: row.note } : null,
    pending_count: monthPendingCount_(month),
    package: packageState_(month),   // piece 10 (AccountantPackage.gs)
    accounts: ended && !closed ? accountBalancesAt_(monthLastDay_(month)) : []
  };
}

function requireCompanyClose_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
}

function getMonthClose(payload) {
  requireCompanyClose_();
  return monthCloseState_(validMonth_(payload && payload.month));
}

/**
 * payload: { month, bank: [{ payment_method_id, currency, bank_amount }], note }. Only a month that has ended. A bank amount left
 * blank is "not checked". Returns the month's new state.
 */
function closeMonth(payload) {
  requireCompanyClose_();
  return withScriptLockOnce_(function () {
    var month = validMonth_(payload && payload.month);
    var state = monthCloseState_(month);
    if (!state.ended) throw new Error(tr_('close.notEnded'));
    if (state.closed) return state;   // a repeat
    var appBalances = {};
    accountBalancesAt_(monthLastDay_(month)).forEach(function (b) { appBalances[b.payment_method_id + '|' + b.currency] = b; });
    var bank = (payload.bank || []).map(function (b) {
      var app = appBalances[b.payment_method_id + '|' + b.currency];
      if (!app) return null;
      var typed = b.bank_amount === '' || b.bank_amount == null ? null : Number(b.bank_amount);
      if (typed !== null && !isFinite(typed)) throw new Error(tr_('err.validAmount'));
      return { payment_method_id: app.payment_method_id, nickname: app.nickname, currency: app.currency, app_amount: app.amount,
        bank_amount: typed === null ? null : round2_(typed), difference: typed === null ? null : round2_(typed - app.amount) };
    }).filter(Boolean);
    var sheet = ensureMonthClosesSheet_();
    var fields = { status: 'closed', closed_at: nowStamp_(), reopened_at: '', fingerprint: monthFingerprint_(month),
      figures: JSON.stringify(monthFigures_(month)), bank_check: JSON.stringify(bank), pending_count: String(state.pending_count),
      note: String(payload.note || '').slice(0, 500) };
    var existing = monthCloseRows_().filter(function (r) { return r.month === month; })[0];
    if (existing) updateRowFields_('Month Closes', existing.id, fields);
    else appendRowObject('Month Closes', Object.assign({ id: Utilities.getUuid(), month: month }, fields));
    if (ROWS_MEMO_) delete ROWS_MEMO_['Month Closes'];
    var off = bank.filter(function (b) { return b.difference !== null && Math.abs(b.difference) > 0.004; }).length;
    changeNoteEvent_('close', month, JSON.stringify({ differences: off, pending: state.pending_count }));
    return monthCloseState_(month);
  });
}

function reopenMonth(payload) {
  requireCompanyClose_();
  return withScriptLockOnce_(function () {
    var month = validMonth_(payload && payload.month);
    var row = monthCloseRows_().filter(function (r) { return r.month === month; })[0];
    if (!row || row.status !== 'closed') return monthCloseState_(month);
    updateRowFields_('Month Closes', row.id, { status: 'reopened', reopened_at: nowStamp_() });
    if (ROWS_MEMO_) delete ROWS_MEMO_['Month Closes'];
    changeNoteEvent_('reopen', month, '');
    return monthCloseState_(month);
  });
}
