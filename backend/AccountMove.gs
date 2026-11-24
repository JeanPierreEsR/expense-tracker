/**
 * Move an account's history to another account (owner, 2026-11-23: a credit card upgrade — "users have reported this to be easier than
 * knowing which transactions refer to each credit card").
 *
 * Everything that points at the OLD account points at the NEW one afterwards: entries (either end of a transfer), loans, repayments,
 * statement uploads and their differences, starting balances (only in a currency where the new account has none: one starting balance
 * per account and currency), and the Yape / Plin links (only where the new account can carry that wallet, railAllowsAccount_; otherwise
 * the link is dropped and the window says so). A transfer between the two accounts would become a transfer from an account to itself:
 * it is deleted (through the bulk delete, so its safety copy goes to "Recently deleted"); one tied to a repayment or an exchange is kept
 * (moved, as everything else). Then the old account is deleted.
 *
 * Limits decided with the owner after the map of possibilities (2026-11-23):
 *  - Same kind only: a card into a card, a bank account into a bank account (a debit's history on a credit card reads wrong).
 *  - Old digits: the new account remembers the old account's last 4 digits WITH its bank and the move date ("1234|<bank id>|<date>" in
 *    `old_last_4`); they count only for that bank and only for 6 months (pmsWithLast4_). An old account with no bank: the window asks for
 *    it; left empty, the digits are not remembered at all.
 *  - A save that still carries the deleted account's id (another phone, a waiting save, a bot's Undo) is sent to the new account
 *    (Settings `pm_forward`, applied by the sheet writers: pmForwardId_).
 *  - Company copies: a move that would touch a CLOSED month is refused (reopen it first), and every row it changes is written in the
 *    change log, so a month close never reads "edited by hand".
 *  - Each move is kept 30 days in More → My data → Recently deleted (tab "Account Moves"), with Restore; the toast's Undo is the same.
 *
 *   previewAccountMove({ from, to })               -> { from, to, counts, selfTransfers, closedMonths, droppedLinks, needsBank }
 *   moveAccountHistory({ from, to, old_bank_id? }) -> { counts, from, to, move_id }
 *   undoAccountMove({ move_id })                   -> { restored: true, entriesBack }   (= restoreAccountMove)
 *   listAccountMoves()                             -> { days, moves: [{ id, moved_at, from_name, to_name, counts }] }
 *   forgetAccountMove({ move_id })                 -> { forgotten: true }
 */

var ACCOUNT_MOVE_SHEETS_ = [['Loans', 'payment_method_id'], ['Settlements', 'payment_method_id'],
  ['Statement Uploads', 'payment_method_id'], ['Statement Gaps', 'payment_method_id']];
var ACCOUNT_MOVES_DAYS_ = 30;
var ACCOUNT_MOVES_HEADERS_ = ['id', 'moved_at', 'part', 'from_name', 'to_name', 'summary', 'data'];
var ACCOUNT_MOVE_CHUNK_ = 40000;   // characters per cell of the stored Undo (a cell holds 50,000)

// card | bank | the type itself (wallet, cash, investment): what may take another account's history.
function accountMoveKind_(pm) {
  var t = String(pm.type || '');
  if (t === 'credit') return 'card';
  if (t === 'debit' || t === 'transfer') return 'bank';
  return t;
}

function accountMovePair_(payload) {
  var fromId = String((payload && payload.from) || ''), toId = String((payload && payload.to) || '');
  var pms = getAllRows('Payment Methods');
  var from = pms.find(function (p) { return String(p.id) === fromId; });
  var to = pms.find(function (p) { return String(p.id) === toId; });
  if (!from || !to) throw new Error(tr_('err.pmNotFound'));
  if (fromId === toId) throw new Error(tr_('err.moveSame'));
  if (isBasicCashAccount_(fromId)) throw new Error(tr_('err.pmCashBasic'));
  if (isPracticeAccount_(from) || isPracticeAccount_(to)) throw new Error(tr_('err.pmNotFound'));
  if (accountMoveKind_(from) !== accountMoveKind_(to)) throw new Error(tr_('err.moveKind'));
  return { from: from, to: to, fromId: fromId, toId: toId };
}

// The transfers between the two accounts that the bulk delete would take (no repayment / exchange behind them).
function accountMoveSelfTransfers_(fromId, toId) {
  return getAllRows('Entries').filter(function (e) {
    var a = String(e.payment_method_id || ''), b = String(e.to_payment_method_id || '');
    return e.type === 'transfer' && ((a === fromId && b === toId) || (a === toId && b === fromId)) && !entryBulkVerdict_(e);
  });
}

function accountMoveMonth_(d) {
  var s = changeText_(d);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : '';
}

// Company copies: the closed months these rows fall in (moving them would change a closed month). [] elsewhere.
function accountMoveClosedHit_(rowsByTable) {
  var closed = {};
  (closedMonths_() || []).forEach(function (m) { closed[m] = true; });
  if (!Object.keys(closed).length) return [];
  var hit = {};
  Object.keys(rowsByTable).forEach(function (t) {
    rowsByTable[t].forEach(function (r) { var m = accountMoveMonth_(r.date); if (closed[m]) hit[m] = true; });
  });
  return Object.keys(hit).sort();
}

// The wallet links on the old account: { moved: [key], dropped: [key] } (railAllowsAccount_ decides, as in the account window).
function accountMoveRailPlan_(fromId, to, settings) {
  var out = { moved: [], dropped: [] };
  RAIL_LINK_KEYS_.forEach(function (k) {
    if (String(settings[k] || '') !== fromId) return;
    (railAllowsAccount_(k.indexOf('yape') === 0 ? 'yape' : 'plin', to) ? out.moved : out.dropped).push(k);
  });
  if (plinMoreIds_(settings).indexOf(fromId) !== -1) (railAllowsAccount_('plin', to) ? out.moved : out.dropped).push(PLIN_MORE_KEY_);
  return out;
}
function railLinkName_(key) { return key.indexOf('yape') === 0 ? 'Yape' : 'Plin'; }

function accountMoveCounts_(p) {
  var fromId = p.fromId, toId = p.toId;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var self = accountMoveSelfTransfers_(fromId, toId);
  var selfIds = {};
  self.forEach(function (e) { selfIds[String(e.id)] = true; });
  var c = { entries: 0, loans: 0, repayments: 0, statements: 0, balances: 0, balancesDropped: 0, links: 0, selfTransfers: self.length };
  var touched = { Entries: self.slice(), Loans: [], Settlements: [] };
  getAllRows('Entries').forEach(function (e) {
    if (selfIds[String(e.id)]) return;
    if (String(e.payment_method_id || '') === fromId || String(e.to_payment_method_id || '') === fromId) { c.entries++; touched.Entries.push(e); }
  });
  if (ss.getSheetByName('Loans')) { touched.Loans = getAllRows('Loans').filter(function (r) { return String(r.payment_method_id || '') === fromId; }); c.loans = touched.Loans.length; }
  if (ss.getSheetByName('Settlements')) { touched.Settlements = getAllRows('Settlements').filter(function (r) { return String(r.payment_method_id || '') === fromId; }); c.repayments = touched.Settlements.length; }
  if (ss.getSheetByName('Statement Uploads')) c.statements = getAllRows('Statement Uploads').filter(function (r) { return String(r.payment_method_id || '') === fromId; }).length;
  ensureAccountOpeningBalancesSheet_();
  var toCur = {};
  getAllRows('Account Opening Balances').forEach(function (r) { if (String(r.payment_method_id) === toId) toCur[String(r.currency)] = true; });
  getAllRows('Account Opening Balances').forEach(function (r) {
    if (String(r.payment_method_id) !== fromId) return;
    if (toCur[String(r.currency)]) c.balancesDropped++; else c.balances++;
  });
  var rails = accountMoveRailPlan_(fromId, p.to, getSettingsMap());
  c.links = rails.moved.length;
  return { counts: c, self: self, rails: rails, closedMonths: accountMoveClosedHit_(touched), balanceChoices: accountMoveBalanceChoices_(p, selfIds) };
}

// Where the new account keeps its OWN starting balance in a currency, the old account's entries before that date stop counting
// (owner's test, 2026-11-23: PEN 490.15 the old card owed vanished). The app cannot know whether that starting balance already held the
// old card's debt, so the window asks with the two results (owner chose "choose the result"): per currency { currency, date, old_owed,
// keep, add } — keep = the new account's balance with its starting balance as it is; add = the same plus what the old account held on
// that date (preselected: the two balances added together, nothing disappears). Same rules as the Balances card (Balances.gs).
function accountMoveBalanceChoices_(p, selfIds) {
  var pms = getAllRows('Payment Methods');
  var openingsByPm = buildOpeningsByPm_(pms);
  var fromOpen = openingsByPm[p.fromId], toOpen = openingsByPm[p.toId];
  if (!fromOpen || !toOpen) return [];
  var inbound = buildInboundTransferIds_();
  var entries = confirmedEntries_().filter(function (e) { return !selfIds[String(e.id)]; });
  var round = function (n) { return Math.round(n * 100) / 100; };
  var out = [];
  toOpen.forEach(function (o) {
    var cur = o.currency;
    var fromOwn = fromOpen.find(function (x) { return x.currency === cur; });
    var oldAt = fromOwn ? fromOwn.amount : 0, keep = o.amount;
    entries.forEach(function (e) {
      if ((e.currency || homeCurrency_()) !== cur) return;
      var onFrom = signedEffectOnPaymentMethod_(e, p.fromId, inbound), onTo = signedEffectOnPaymentMethod_(e, p.toId, inbound);
      if (!onFrom && !onTo) return;
      var afterTo = entryCountsAfterOpening_(e, o);
      if (afterTo) keep += onFrom + onTo;   // after the move both count on the new account from its own date on
      else if (onFrom && entryCountsAfterOpening_(e, openingForCurrency_(fromOpen, cur))) oldAt += onFrom;   // the old account's, before that date
    });
    if (Math.abs(oldAt) < 0.005) return;
    out.push({ currency: cur, date: String(o.date || ''), old_owed: round(oldAt), keep: round(keep), add: round(keep + oldAt) });
  });
  return out;
}

function accountMoveNeedsBank_(from) {
  return /^\d{4}$/.test(covKey_(from.last_4)) && !String(from.bank_id || '');
}

function previewAccountMove(payload) {
  var p = accountMovePair_(payload);
  var r = accountMoveCounts_(p);
  return {
    from: { id: p.fromId, nickname: String(p.from.nickname) }, to: { id: p.toId, nickname: String(p.to.nickname) }, counts: r.counts,
    selfTransfers: r.self.map(function (e) { return { id: String(e.id), date: String(e.date), amount: Number(e.amount), currency: String(e.currency), description: String(e.description || '') }; }),
    closedMonths: r.closedMonths,
    movedLinks: r.rails.moved.map(railLinkName_).filter(function (n, i, a) { return a.indexOf(n) === i; }),   // "Yape" or "Plin" (Yape soles + dollars = one Yape)
    droppedLinks: r.rails.dropped.map(railLinkName_).filter(function (n, i, a) { return a.indexOf(n) === i; }),
    needsBank: accountMoveNeedsBank_(p.from),
    balanceChoices: r.balanceChoices
  };
}

// Every row of a sheet whose `field` is `fromId` gets `toId`, in one read and one write of that column. Answers the ids changed.
function accountMoveColumn_(sheetName, field, fromId, toId, onlyIds) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var headers = getHeaders(sheet);
  var idCol = headers.indexOf('id'), col = headers.indexOf(field);
  if (idCol === -1 || col === -1) return [];
  var n = sheet.getLastRow() - 1;
  var ids = sheet.getRange(2, idCol + 1, n, 1).getValues();
  var vals = sheet.getRange(2, col + 1, n, 1).getValues();
  var done = [];
  for (var i = 0; i < n; i++) {
    if (String(vals[i][0] || '') !== fromId) continue;
    if (onlyIds && !onlyIds[String(ids[i][0])]) continue;
    vals[i][0] = toId;
    done.push(String(ids[i][0]));
  }
  if (!done.length) return [];
  sheet.getRange(2, col + 1, n, 1).setValues(vals);
  if (ROWS_MEMO_) delete ROWS_MEMO_[sheetName];
  accountMoveLog_(sheetName, field, done, fromId, toId);
  return done;
}

// One of the entries' account columns, for the rows (in `only`, when given) that hold `fromId`; updated_at stamped so every phone
// picks the change up. Answers the ids changed.
function accountMoveEntriesField_(field, fromId, toId, only) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var col = headers.indexOf(field), n = sheet.getLastRow() - 1;
  if (col === -1 || n < 1) return [];
  var updatedCol = ensureEntriesUpdatedAtColumn_();
  var ids = sheet.getRange(2, headers.indexOf('id') + 1, n, 1).getValues();
  var vals = sheet.getRange(2, col + 1, n, 1).getValues();
  var stamps = sheet.getRange(2, updatedCol, n, 1).getValues();
  var stamp = nowStamp_(), done = [];
  for (var i = 0; i < n; i++) {
    if (String(vals[i][0] || '') !== fromId) continue;
    if (only && !only[String(ids[i][0])]) continue;
    vals[i][0] = toId;
    stamps[i][0] = stamp;
    done.push(String(ids[i][0]));
  }
  if (!done.length) return [];
  sheet.getRange(2, col + 1, n, 1).setValues(vals);
  sheet.getRange(2, updatedCol, n, 1).setValues(stamps);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Entries'];
  bumpVersion_('ENTRIES_VERSION');
  accountMoveLog_('Entries', field, done, fromId, toId);
  return done;
}

// Company copies: one change-log line per row the move changed (the column writes above go below the usual cell hooks).
function accountMoveLog_(table, field, ids, before, after) {
  if (!ids.length || !changeLogOn_(table)) return;
  var byId = {};
  getAllRows(table).forEach(function (r) { byId[String(r.id)] = r; });
  ids.forEach(function (id) { changeNote_('update', table, id, field, before, after, changeMonthOf_(byId[id])); });
}

// ---- Old digits (see the header) ----
var OLD_LAST4_MONTHS_ = 6;

function ensurePaymentMethodOldLast4Column_() {
  ensureColumn_('Payment Methods', 'old_last_4');
}

function pmOldLast4Items_(pm) {
  return String((pm && pm.old_last_4) || '').split(',').map(function (part) {
    var bits = part.trim().split('|');
    return { digits: covKey_(bits[0]), bank: String(bits[1] || ''), date: String(bits[2] || '') };
  }).filter(function (it) { return /^\d{4}$/.test(it.digits); });
}
function pmOldLast4Value_(items) {
  return items.map(function (it) { return [it.digits, it.bank || '', it.date || ''].join('|'); }).join(',');
}
// Every old digit, whatever its bank or age: ["1234", …] (the coverage list never waits for a replaced card's statements).
function pmOldLast4List_(pm) {
  return pmOldLast4Items_(pm).map(function (it) { return it.digits; });
}

function oldLast4Cutoff_() {
  var d = new Date();
  d.setMonth(d.getMonth() - OLD_LAST4_MONTHS_);
  return Utilities.formatDate(d, personTz_(), 'yyyy-MM-dd');
}

// Does one remembered old digit count for this source? src: { bankId?, bankName?, anyTime? } — a source that names a bank must be the old
// card's bank; one with no bank (Apple Pay, an e-mail rule with no bank) is not "another bank". anyTime: a record already saved (its label).
function oldLast4Counts_(it, src, cutoff) {
  src = src || {};
  if (!src.anyTime && it.date && it.date < cutoff) return false;
  if (!it.bank || (!src.bankId && !src.bankName)) return true;
  if (src.bankId) return String(src.bankId) === it.bank;
  var bank = getAllRows('Banks').find(function (b) { return String(b.id) === it.bank; });
  return !!bank && plainNickname_(bank.name) === plainNickname_(src.bankName);
}

// The accounts that HAD these digits (old_last_4) and may still be found by them from this source.
function pmsWithOldLast4_(pms, digits, src) {
  var k = covKey_(digits);
  if (!/^\d{4}$/.test(k)) return [];
  var cutoff = oldLast4Cutoff_();
  return pms.filter(function (pm) {
    return !isPracticeAccount_(pm) && pmOldLast4Items_(pm).some(function (it) { return it.digits === k && oldLast4Counts_(it, src, cutoff); });
  });
}

// The accounts with these last 4 digits: the ones whose CURRENT digits match, else the ones that had them before (see above).
function pmsWithLast4_(pms, digits, src) {
  var k = covKey_(digits);
  if (!/^\d{4}$/.test(k)) return [];
  var now = pms.filter(function (pm) { return covKey_(pm.last_4) === k; });
  if (now.length) return now;
  return pmsWithOldLast4_(pms, k, src);
}

// Every old key of every account: { "1234": pm }. src as above; { all: true } = every one, whatever its bank or age.
function pmOldKeyMap_(pms, src) {
  var out = {}, cutoff = oldLast4Cutoff_();
  pms.forEach(function (pm) {
    if (isPracticeAccount_(pm)) return;
    pmOldLast4Items_(pm).forEach(function (it) { if (!out[it.digits] && (src && src.all || oldLast4Counts_(it, src, cutoff))) out[it.digits] = pm; });
  });
  return out;
}

function setPmOldLast4_(pmId, value) {
  ensurePaymentMethodOldLast4Column_();
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var row = findRowIndexById(sheet, headers, pmId);
  if (row === -1) return;
  sheet.getRange(row, headers.indexOf('old_last_4') + 1).setNumberFormat('@');
  setCellByRow_(sheet, headers, row, 'old_last_4', value);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
}

// ---- Forwarding: a deleted account's id → the account that took its history (Settings pm_forward = "old:new,old:new") ----
var PM_FORWARD_KEY_ = 'pm_forward';
var PM_FORWARD_TABLES_ = { 'Entries': true, 'Loans': true, 'Settlements': true, 'Account Opening Balances': true, 'Statement Uploads': true, 'Statement Gaps': true };
var PM_FORWARD_FIELDS_ = { payment_method_id: true, to_payment_method_id: true };

function pmForwardMap_() {
  if (ROWS_MEMO_ && ROWS_MEMO_['@pmfwd']) return ROWS_MEMO_['@pmfwd'];
  var map = {};
  String(getSettingsMap()[PM_FORWARD_KEY_] || '').split(',').forEach(function (pair) {
    var bits = pair.split(':');
    if (bits.length === 2 && bits[0] && bits[1]) map[bits[0]] = bits[1];
  });
  if (ROWS_MEMO_) ROWS_MEMO_['@pmfwd'] = map;
  return map;
}
// The id a save should really write (follows a chain of moves, A → B → C).
function pmForwardId_(id) {
  var v = String(id === null || id === undefined ? '' : id);
  if (!v) return id;
  var map = pmForwardMap_();
  if (!map[v]) return id;
  for (var hops = 0; map[v] && hops < 10; hops++) v = map[v];
  return v;
}
// What a sheet writer should store for this cell (only account columns of the tabs above).
function pmForwardCell_(sheetName, field, value) {
  return PM_FORWARD_TABLES_[sheetName] && PM_FORWARD_FIELDS_[field] ? pmForwardId_(value) : value;
}
// An object about to be appended: its account columns forwarded in place (so what the caller hands back is right too).
function pmForwardObject_(sheetName, obj) {
  if (!PM_FORWARD_TABLES_[sheetName] || !obj) return;
  Object.keys(PM_FORWARD_FIELDS_).forEach(function (f) { if (obj[f]) obj[f] = pmForwardId_(obj[f]); });
}
function setPmForward_(fromId, toId) {
  var map = {};
  var cur = pmForwardMap_();
  Object.keys(cur).forEach(function (k) { map[k] = cur[k]; });
  if (toId) map[fromId] = toId; else delete map[fromId];
  setSetting_(PM_FORWARD_KEY_, Object.keys(map).map(function (k) { return k + ':' + map[k]; }).join(','));
  if (ROWS_MEMO_) delete ROWS_MEMO_['@pmfwd'];
}

// ---- The move ----
function moveAccountHistory(payload) {
  return withScriptLockOnce_(function () {
    var p = accountMovePair_(payload);
    var fromId = p.fromId, toId = p.toId;
    var r = accountMoveCounts_(p);
    if (r.closedMonths.length) throw new Error(tr_('err.moveClosed', { months: r.closedMonths.join(', ') }));
    // The old account's bank, for its digits: its own, or the one picked in the window (an account saved without one).
    var oldBank = String(p.from.bank_id || '');
    if (!oldBank && payload.old_bank_id) {
      var b = getAllRows('Banks').find(function (x) { return String(x.id) === String(payload.old_bank_id); });
      if (b) oldBank = String(b.id);
    }
    var undo = { from: Object.assign({}, p.from), toId: toId, entries: {}, sheets: {}, balancesMoved: [], balancesDropped: [],
      rails: { moved: r.rails.moved, dropped: r.rails.dropped }, settingsBefore: {}, addedDigits: [], forwardsBefore: {} };
    // 1. Transfers between the two: deleted first (safety copy in "Recently deleted"), so they are not moved onto a card-to-itself.
    if (r.self.length) {
      var del = deleteEntries({ ids: r.self.map(function (e) { return e.id; }) });
      undo.deletedBatch = del.batch_id || '';
    }
    // 2. Entries, loans, repayments, statements.
    ['payment_method_id', 'to_payment_method_id'].forEach(function (f) { undo.entries[f] = accountMoveEntriesField_(f, fromId, toId); });
    ACCOUNT_MOVE_SHEETS_.forEach(function (s) { undo.sheets[s[0]] = accountMoveColumn_(s[0], s[1], fromId, toId); });
    // 3. Starting balances: moved where the new account has none in that currency; the old one's is dropped (kept for Undo) where it has.
    ensureAccountOpeningBalancesSheet_();
    var toCur = {};
    getAllRows('Account Opening Balances').forEach(function (bal) { if (String(bal.payment_method_id) === toId) toCur[String(bal.currency)] = true; });
    var move = {};
    getAllRows('Account Opening Balances').forEach(function (bal) {
      if (String(bal.payment_method_id) !== fromId) return;
      if (toCur[String(bal.currency)]) undo.balancesDropped.push(Object.assign({}, bal));
      else move[String(bal.id)] = true;
    });
    undo.balancesMoved = accountMoveColumn_('Account Opening Balances', 'payment_method_id', fromId, toId, move);
    // 3b. The person's answer per currency ("both cards added together", the default, or "already included"): the new account's own
    //     starting balance takes what the old account held on its date, so the result is the one shown in the window.
    var keepCur = {};
    (Array.isArray(payload.keep_balances) ? payload.keep_balances : []).forEach(function (cur) { keepCur[String(cur).toUpperCase()] = true; });
    undo.openingAdjust = [];
    r.balanceChoices.forEach(function (ch) {
      if (keepCur[ch.currency]) return;
      var row = getAllRows('Account Opening Balances').find(function (bal) { return String(bal.payment_method_id) === toId && String(bal.currency).toUpperCase() === ch.currency; });
      if (!row) return;
      var before = Number(row.amount) || 0, after = Math.round((before + ch.old_owed) * 100) / 100;
      updateRowFields_('Account Opening Balances', row.id, { amount: after });
      if (ROWS_MEMO_) delete ROWS_MEMO_['Account Opening Balances'];
      undo.openingAdjust.push({ id: String(row.id), before: before, after: after });
    });
    // 4. Yape / Plin: moved where the new account can carry the wallet, dropped otherwise.
    var settings = getSettingsMap();
    RAIL_LINK_KEYS_.concat([PLIN_MORE_KEY_]).forEach(function (k) { undo.settingsBefore[k] = String(settings[k] || ''); });
    RAIL_LINK_KEYS_.forEach(function (k) {
      if (String(settings[k] || '') !== fromId) return;
      setSetting_(k, r.rails.moved.indexOf(k) !== -1 ? toId : '');
    });
    var more = plinMoreIds_(settings);
    if (more.indexOf(fromId) !== -1) {
      var keepMore = r.rails.moved.indexOf(PLIN_MORE_KEY_) !== -1;
      var main = String(getSettingsMap().plin_pen || '');
      var next = more.map(function (id) { return id === fromId ? (keepMore ? toId : '') : id; })
        .filter(function (id, i, a) { return id && a.indexOf(id) === i && id !== main; });
      setSetting_(PLIN_MORE_KEY_, next.join(','));
    }
    undo.settingsAfter = {};
    var after = getSettingsMap();
    RAIL_LINK_KEYS_.concat([PLIN_MORE_KEY_]).forEach(function (k) { undo.settingsAfter[k] = String(after[k] || ''); });
    // 5. The new account answers to the old digits too: with the old card's bank and today's date (only that bank, 6 months).
    //    No bank known (none saved, none picked): the digits are not remembered (owner, 2026-11-23).
    var today = Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd');
    var items = pmOldLast4Items_(p.to);
    var add = function (it) {
      if (!/^\d{4}$/.test(it.digits) || !it.bank || it.digits === covKey_(p.to.last_4)) return;
      items = items.filter(function (x) { return x.digits !== it.digits; });
      items.push(it);
      undo.addedDigits.push(it);
    };
    pmOldLast4Items_(p.from).forEach(add);   // a chain of moves: each keeps its own bank and date
    add({ digits: covKey_(p.from.last_4), bank: oldBank, date: today });
    var value = pmOldLast4Value_(items);
    if (value !== String(p.to.old_last_4 || '')) setPmOldLast4_(toId, value);
    // 6. Saves that still carry the old id go to the new account (other phones, waiting saves, a bot's Undo); a chain follows.
    var fwd = pmForwardMap_();
    Object.keys(fwd).forEach(function (k) { if (fwd[k] === fromId) { undo.forwardsBefore[k] = fromId; setPmForward_(k, toId); } });
    setPmForward_(fromId, toId);
    // 7. The old account goes (its leftover starting balances with it), and the move is kept 30 days for Restore.
    deletePaymentMethod({ id: fromId });
    var moveId = Utilities.getUuid();
    saveAccountMove_(moveId, String(p.from.nickname), String(p.to.nickname), r.counts, undo);
    bumpStructureVersion_();
    return { counts: r.counts, from: { id: fromId, nickname: String(p.from.nickname) }, to: { id: toId, nickname: String(p.to.nickname) }, move_id: moveId };
  });
}

// ---- Recently deleted: the moves of the last 30 days (tab "Account Moves", one row per part of the stored Undo) ----
function ensureAccountMovesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Account Moves');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Account Moves');
  sheet.getRange(1, 1, 1, ACCOUNT_MOVES_HEADERS_.length).setValues([ACCOUNT_MOVES_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), ACCOUNT_MOVES_HEADERS_.length).setNumberFormat('@');   // the stored Undo stays text
  sheet.setFrozenRows(1);
  return sheet;
}

function saveAccountMove_(id, fromName, toName, counts, undo) {
  var sheet = ensureAccountMovesSheet_();
  var text = JSON.stringify(undo), at = nowStamp_(), rows = [];
  for (var i = 0, part = 0; i < text.length || part === 0; i += ACCOUNT_MOVE_CHUNK_, part++) {
    rows.push([id, at, String(part), fromName, toName, JSON.stringify(counts), text.slice(i, i + ACCOUNT_MOVE_CHUNK_)]);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, ACCOUNT_MOVES_HEADERS_.length).setValues(rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Account Moves'];
}

function purgeOldAccountMoves_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Account Moves')) return;
  var d = new Date();
  d.setDate(d.getDate() - ACCOUNT_MOVES_DAYS_);
  var cutoff = Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
  deleteRowsWhere_('Account Moves', function (r) { return String(r.moved_at) < cutoff; });
}

function accountMoveRecord_(id) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Account Moves')) return null;
  var parts = getAllRows('Account Moves').filter(function (r) { return String(r.id) === String(id); })
    .sort(function (a, b) { return Number(a.part) - Number(b.part); });
  if (!parts.length) return null;
  var undo;
  try { undo = JSON.parse(parts.map(function (r) { return String(r.data); }).join('')); } catch (e) { return null; }
  // A row typed or changed by hand that is not a whole move: treated as gone (testers 2.68.2: a raw error on Restore).
  if (!undo || !undo.from || !undo.from.id || !undo.toId || !undo.entries) return null;
  return { id: String(id), undo: undo, from_name: String(parts[0].from_name), to_name: String(parts[0].to_name) };
}

function listAccountMoves() {
  purgeOldAccountMoves_();
  var out = [];
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Account Moves')) {
    getAllRows('Account Moves').forEach(function (r) {
      if (String(r.part) !== '0') return;
      var counts = {};
      try { counts = JSON.parse(String(r.summary)) || {}; } catch (e) { counts = {}; }
      out.push({ id: String(r.id), moved_at: String(r.moved_at), from_name: String(r.from_name), to_name: String(r.to_name), counts: counts });
    });
  }
  out.sort(function (a, b) { return a.moved_at < b.moved_at ? 1 : -1; });
  return { days: ACCOUNT_MOVES_DAYS_, moves: out };
}

function forgetAccountMove(payload) {
  var id = String((payload && payload.move_id) || '');
  deleteRowsWhere_('Account Moves', function (r) { return String(r.id) === id; });
  return { forgotten: true };
}

// The toast's Undo and Recently deleted's Restore: everything back that is still where the move left it.
function undoAccountMove(payload) { return restoreAccountMove(payload); }

function restoreAccountMove(payload) {
  return withScriptLockOnce_(function () {
    var rec = accountMoveRecord_(payload && payload.move_id);
    if (!rec) throw new Error(tr_('err.moveUndoGone'));
    var u = rec.undo;
    var fromId = String(u.from.id), toId = String(u.toId);
    var ids = function (list) { var o = {}; (list || []).forEach(function (id) { o[String(id)] = true; }); return o; };
    // Company copies: putting rows back must not change a month closed since the move.
    var touched = { Entries: [], Loans: [], Settlements: [] };
    var eIds = ids((u.entries.payment_method_id || []).concat(u.entries.to_payment_method_id || []));
    touched.Entries = getAllRows('Entries').filter(function (e) { return eIds[String(e.id)]; });
    ['Loans', 'Settlements'].forEach(function (t) {
      var only = ids(u.sheets && u.sheets[t]);
      if (Object.keys(only).length) touched[t] = getAllRows(t).filter(function (row) { return only[String(row.id)]; });
    });
    var closedHit = accountMoveClosedHit_(touched);
    if (closedHit.length) throw new Error(tr_('err.moveClosed', { months: closedHit.join(', ') }));
    // 1. No more forwarding to the new account for these ids (before anything is written back with the old id).
    setPmForward_(fromId, '');
    Object.keys(u.forwardsBefore || {}).forEach(function (k) { setPmForward_(k, u.forwardsBefore[k]); });
    // 2. The old account comes back as it was (same id, digits as text).
    if (!getAllRows('Payment Methods').some(function (pm) { return String(pm.id) === fromId; })) {
      var row = Object.assign({}, u.from);
      var last4 = String(row.last_4 || '');
      row.last_4 = '';
      appendRowObject('Payment Methods', row);
      if (last4) { var sheet = getSheet('Payment Methods'), headers = getHeaders(sheet); setPaymentMethodLast4_(sheet, headers, findRowIndexById(sheet, headers, fromId), last4); }
      if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
    }
    // 3. What moved goes back: only those rows, and only while they still point at the new account.
    var back = 0;
    ['payment_method_id', 'to_payment_method_id'].forEach(function (f) {
      var only = ids(u.entries && u.entries[f]);
      if (Object.keys(only).length) back += accountMoveEntriesField_(f, toId, fromId, only).length;
    });
    ACCOUNT_MOVE_SHEETS_.forEach(function (s) { var only = ids(u.sheets && u.sheets[s[0]]); if (Object.keys(only).length) accountMoveColumn_(s[0], s[1], toId, fromId, only); });
    var movedBal = ids(u.balancesMoved);
    if (Object.keys(movedBal).length) accountMoveColumn_('Account Opening Balances', 'payment_method_id', toId, fromId, movedBal);
    (u.openingAdjust || []).forEach(function (adj) {   // the new account's starting balance, while it is still what the move made it
      var row = getAllRows('Account Opening Balances').find(function (bal) { return String(bal.id) === adj.id; });
      if (row && Math.abs((Number(row.amount) || 0) - adj.after) < 0.005) { updateRowFields_('Account Opening Balances', adj.id, { amount: adj.before }); if (ROWS_MEMO_) delete ROWS_MEMO_['Account Opening Balances']; }
    });
    var have = ids(getAllRows('Account Opening Balances').map(function (bal) { return bal.id; }));
    var dropped = (u.balancesDropped || []).filter(function (bal) { return !have[String(bal.id)]; });
    if (dropped.length) appendObjectsBatch_('Account Opening Balances', dropped);
    // 4. Wallet links: each one back where it still is as the move left it.
    var now = getSettingsMap();
    Object.keys(u.settingsAfter || {}).forEach(function (k) {
      if (String(now[k] || '') === String(u.settingsAfter[k]) && String(u.settingsBefore[k] || '') !== String(u.settingsAfter[k])) setSetting_(k, u.settingsBefore[k] || '');
    });
    // 5. The digits this move added leave the new account (others it had, or got later, stay).
    var to = getAllRows('Payment Methods').find(function (pm) { return String(pm.id) === toId; });
    if (to) {
      var added = {};
      (u.addedDigits || []).forEach(function (it) { added[it.digits + '|' + it.date] = true; });
      var keep = pmOldLast4Items_(to).filter(function (it) { return !added[it.digits + '|' + it.date]; });
      var value = pmOldLast4Value_(keep);
      if (value !== String(to.old_last_4 || '')) setPmOldLast4_(toId, value);
    }
    // 6. The transfers between the two accounts come back (while they are still in Recently deleted).
    if (u.deletedBatch) restoreDeletedEntries({ batch_id: u.deletedBatch });
    deleteRowsWhere_('Account Moves', function (r) { return String(r.id) === rec.id; });
    bumpStructureVersion_();
    return { restored: true, entriesBack: back, from_name: rec.from_name, to_name: rec.to_name };
  });
}
