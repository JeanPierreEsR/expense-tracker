/**
 * Move an account's history to another account (owner, 2026-11-23: a credit card upgrade — "users have reported this to be easier than
 * knowing which transactions refer to each credit card").
 *
 * Everything that points at the OLD account points at the NEW one afterwards: entries (either end of a transfer), loans, repayments,
 * statement uploads and their differences, the Yape / Plin links, and starting balances (only in a currency where the new account has
 * none: one starting balance per account and currency). A transfer between the two accounts would become a transfer from an account to
 * itself: it is deleted (through the bulk delete, so its safety copy goes to "Recently deleted"); one tied to a repayment or an exchange
 * is kept (moved, as everything else). The new account also keeps the old account's last 4 digits in `old_last_4`, so a late e-mail,
 * Apple Pay notice or statement of the old card still finds it (owner, 2026-11-23). Then the old account is deleted.
 *
 *   previewAccountMove({ from, to })  -> { from: {id,nickname}, to: {id,nickname}, counts: { entries, loans, repayments, statements,
 *                                          balances, balancesDropped, links, selfTransfers }, selfTransfers: [{ id, date, amount, currency, description }] }
 *   moveAccountHistory({ from, to })  -> the same counts + { undo }  (undo = everything undoAccountMove needs to put it back)
 *   undoAccountMove({ undo })         -> { restored: true, entriesBack: n }
 */

var ACCOUNT_MOVE_SHEETS_ = [['Loans', 'payment_method_id'], ['Settlements', 'payment_method_id'],
  ['Statement Uploads', 'payment_method_id'], ['Statement Gaps', 'payment_method_id']];

function accountMovePair_(payload) {
  var fromId = String((payload && payload.from) || ''), toId = String((payload && payload.to) || '');
  var pms = getAllRows('Payment Methods');
  var from = pms.find(function (p) { return String(p.id) === fromId; });
  var to = pms.find(function (p) { return String(p.id) === toId; });
  if (!from || !to) throw new Error(tr_('err.pmNotFound'));
  if (fromId === toId) throw new Error(tr_('err.moveSame'));
  if (isBasicCashAccount_(fromId)) throw new Error(tr_('err.pmCashBasic'));
  if (isPracticeAccount_(from) || isPracticeAccount_(to)) throw new Error(tr_('err.pmNotFound'));
  return { from: from, to: to, fromId: fromId, toId: toId };
}

// The transfers between the two accounts that the bulk delete would take (no repayment / exchange behind them).
function accountMoveSelfTransfers_(fromId, toId) {
  return getAllRows('Entries').filter(function (e) {
    var a = String(e.payment_method_id || ''), b = String(e.to_payment_method_id || '');
    return e.type === 'transfer' && ((a === fromId && b === toId) || (a === toId && b === fromId)) && !entryBulkVerdict_(e);
  });
}

function accountMoveCounts_(fromId, toId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var self = accountMoveSelfTransfers_(fromId, toId);
  var selfIds = {};
  self.forEach(function (e) { selfIds[String(e.id)] = true; });
  var c = { entries: 0, loans: 0, repayments: 0, statements: 0, balances: 0, balancesDropped: 0, links: 0, selfTransfers: self.length };
  getAllRows('Entries').forEach(function (e) {
    if (selfIds[String(e.id)]) return;
    if (String(e.payment_method_id || '') === fromId || String(e.to_payment_method_id || '') === fromId) c.entries++;
  });
  if (ss.getSheetByName('Loans')) c.loans = getAllRows('Loans').filter(function (r) { return String(r.payment_method_id || '') === fromId; }).length;
  if (ss.getSheetByName('Settlements')) c.repayments = getAllRows('Settlements').filter(function (r) { return String(r.payment_method_id || '') === fromId; }).length;
  if (ss.getSheetByName('Statement Uploads')) c.statements = getAllRows('Statement Uploads').filter(function (r) { return String(r.payment_method_id || '') === fromId; }).length;
  ensureAccountOpeningBalancesSheet_();
  var toCur = {};
  getAllRows('Account Opening Balances').forEach(function (r) { if (String(r.payment_method_id) === toId) toCur[String(r.currency)] = true; });
  getAllRows('Account Opening Balances').forEach(function (r) {
    if (String(r.payment_method_id) !== fromId) return;
    if (toCur[String(r.currency)]) c.balancesDropped++; else c.balances++;
  });
  var settings = getSettingsMap();
  RAIL_LINK_KEYS_.forEach(function (k) { if (String(settings[k] || '') === fromId) c.links++; });
  if (plinMoreIds_(settings).indexOf(fromId) !== -1) c.links++;
  return { counts: c, self: self };
}

function previewAccountMove(payload) {
  var p = accountMovePair_(payload);
  var r = accountMoveCounts_(p.fromId, p.toId);
  return {
    from: { id: p.fromId, nickname: String(p.from.nickname) }, to: { id: p.toId, nickname: String(p.to.nickname) }, counts: r.counts,
    selfTransfers: r.self.map(function (e) { return { id: String(e.id), date: String(e.date), amount: Number(e.amount), currency: String(e.currency), description: String(e.description || '') }; })
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
  return done;
}

// The entries' two account columns, with updated_at stamped so every phone picks the change up.
function accountMoveEntries_(fromId, toId, onlyIds) {
  var updatedCol = ensureEntriesUpdatedAtColumn_();
  ensureEntriesToPaymentMethodColumn_();
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var n = sheet.getLastRow() - 1;
  var out = { payment_method_id: [], to_payment_method_id: [] };
  if (n < 1) return out;
  var ids = sheet.getRange(2, headers.indexOf('id') + 1, n, 1).getValues();
  var stamps = sheet.getRange(2, updatedCol, n, 1).getValues();
  var stamp = nowStamp_(), any = false;
  ['payment_method_id', 'to_payment_method_id'].forEach(function (f) {
    var col = headers.indexOf(f);
    if (col === -1) return;
    var vals = sheet.getRange(2, col + 1, n, 1).getValues();
    var changed = false;
    for (var i = 0; i < n; i++) {
      if (String(vals[i][0] || '') !== fromId) continue;
      if (onlyIds && !onlyIds[String(ids[i][0])]) continue;
      vals[i][0] = toId;
      stamps[i][0] = stamp;
      out[f].push(String(ids[i][0]));
      changed = true;
    }
    if (changed) { sheet.getRange(2, col + 1, n, 1).setValues(vals); any = true; }
  });
  if (any) {
    sheet.getRange(2, updatedCol, n, 1).setValues(stamps);
    if (ROWS_MEMO_) delete ROWS_MEMO_['Entries'];
    bumpVersion_('ENTRIES_VERSION');
  }
  return out;
}

function ensurePaymentMethodOldLast4Column_() {
  ensureColumn_('Payment Methods', 'old_last_4');
}

// The old digits an account also answers to (a card replaced by this one). Stored in `old_last_4` as "1234|<bank id>|<moved on>", comma
// separated. Owner, 2026-11-23: they count ONLY for the old card's bank (an e-mail or statement of another bank never uses them) and
// ONLY for 6 months after the move (late e-mails and a last statement arrive within that; for longer it was too open).
var OLD_LAST4_MONTHS_ = 6;

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

function moveAccountHistory(payload) {
  return withScriptLockOnce_(function () {
    var p = accountMovePair_(payload);
    var fromId = p.fromId, toId = p.toId;
    var r = accountMoveCounts_(fromId, toId);
    var undo = { from: Object.assign({}, p.from), toId: toId, toOldLast4: String(p.to.old_last_4 || ''), entries: {}, sheets: {}, balancesMoved: [], balancesDropped: [], settings: {} };
    // 1. Transfers between the two: deleted first (safety copy in "Recently deleted"), so they are not moved onto a card-to-itself.
    if (r.self.length) {
      var del = deleteEntries({ ids: r.self.map(function (e) { return e.id; }) });
      undo.deletedBatch = del.batch_id || '';
      undo.deletedIds = del.deleted || [];
    }
    // 2. Entries, loans, repayments, statements.
    undo.entries = accountMoveEntries_(fromId, toId);
    ACCOUNT_MOVE_SHEETS_.forEach(function (s) { undo.sheets[s[0]] = accountMoveColumn_(s[0], s[1], fromId, toId); });
    // 3. Starting balances: moved where the new account has none in that currency; the old one's is dropped (kept for Undo) where it has.
    ensureAccountOpeningBalancesSheet_();
    var toCur = {};
    getAllRows('Account Opening Balances').forEach(function (b) { if (String(b.payment_method_id) === toId) toCur[String(b.currency)] = true; });
    var move = {};
    getAllRows('Account Opening Balances').forEach(function (b) {
      if (String(b.payment_method_id) !== fromId) return;
      if (toCur[String(b.currency)]) undo.balancesDropped.push(Object.assign({}, b));
      else move[String(b.id)] = true;
    });
    undo.balancesMoved = accountMoveColumn_('Account Opening Balances', 'payment_method_id', fromId, toId, move);
    // 4. Yape / Plin links.
    var settings = getSettingsMap();
    RAIL_LINK_KEYS_.forEach(function (k) { if (String(settings[k] || '') === fromId) { undo.settings[k] = fromId; setSetting_(k, toId); } });
    var more = plinMoreIds_(settings);
    if (more.indexOf(fromId) !== -1) {
      undo.settings[PLIN_MORE_KEY_] = more.join(',');
      var next = more.map(function (id) { return id === fromId ? toId : id; }).filter(function (id, i, a) { return a.indexOf(id) === i && id !== String(getSettingsMap().plin_pen || ''); });
      setSetting_(PLIN_MORE_KEY_, next.join(','));
    }
    // 5. The new account answers to the old digits too.
    // (with the old card's bank and today's date: they count for that bank only, for 6 months; a newer copy of the same digits wins)
    var today = Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd');
    var items = [];
    var keep = function (it) { if (/^\d{4}$/.test(it.digits) && it.digits !== covKey_(p.to.last_4)) { items = items.filter(function (x) { return x.digits !== it.digits; }); items.push(it); } };
    pmOldLast4Items_(p.to).forEach(keep);
    pmOldLast4Items_(p.from).forEach(keep);
    keep({ digits: covKey_(p.from.last_4), bank: String(p.from.bank_id || ''), date: today });
    var value = pmOldLast4Value_(items);
    if (value !== String(p.to.old_last_4 || '')) setPmOldLast4_(toId, value);
    // 6. The old account goes (its leftover starting balances with it).
    deletePaymentMethod({ id: fromId });
    bumpStructureVersion_();
    return { counts: r.counts, from: { id: fromId, nickname: String(p.from.nickname) }, to: { id: toId, nickname: String(p.to.nickname) }, undo: undo };
  });
}

function undoAccountMove(payload) {
  return withScriptLockOnce_(function () {
    var u = payload && payload.undo;
    if (!u || !u.from || !u.from.id || !u.toId) throw new Error(tr_('err.moveUndoGone'));
    var fromId = String(u.from.id), toId = String(u.toId);
    // 1. The old account comes back as it was (same id, digits as text).
    if (!getAllRows('Payment Methods').some(function (pm) { return String(pm.id) === fromId; })) {
      var row = Object.assign({}, u.from);
      var last4 = String(row.last_4 || '');
      row.last_4 = '';
      appendRowObject('Payment Methods', row);
      if (last4) { var sheet = getSheet('Payment Methods'), headers = getHeaders(sheet); setPaymentMethodLast4_(sheet, headers, findRowIndexById(sheet, headers, fromId), last4); }
      if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
    }
    // 2. What moved goes back: only the rows that moved, and only while they still point at the new account.
    var ids = function (list) { var o = {}; (list || []).forEach(function (id) { o[String(id)] = true; }); return o; };
    var back = 0;
    ['payment_method_id', 'to_payment_method_id'].forEach(function (f) {
      var only = ids(u.entries && u.entries[f]);
      if (!Object.keys(only).length) return;
      var moved = accountMoveEntriesField_(f, toId, fromId, only);
      back += moved;
    });
    ACCOUNT_MOVE_SHEETS_.forEach(function (s) { accountMoveColumn_(s[0], s[1], toId, fromId, ids(u.sheets && u.sheets[s[0]])); });
    accountMoveColumn_('Account Opening Balances', 'payment_method_id', toId, fromId, ids(u.balancesMoved));
    if ((u.balancesDropped || []).length) appendObjectsBatch_('Account Opening Balances', u.balancesDropped);
    Object.keys(u.settings || {}).forEach(function (k) { setSetting_(k, String(u.settings[k])); });
    setPmOldLast4_(toId, String(u.toOldLast4 || ''));
    if (u.deletedBatch) restoreDeletedEntries({ batch_id: u.deletedBatch });
    bumpStructureVersion_();
    return { restored: true, entriesBack: back };
  });
}

// One of the entries' account columns, for the rows in `only` that hold `fromId`.
function accountMoveEntriesField_(field, fromId, toId, only) {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var col = headers.indexOf(field), n = sheet.getLastRow() - 1;
  if (col === -1 || n < 1) return 0;
  var updatedCol = ensureEntriesUpdatedAtColumn_();
  var ids = sheet.getRange(2, headers.indexOf('id') + 1, n, 1).getValues();
  var vals = sheet.getRange(2, col + 1, n, 1).getValues();
  var stamps = sheet.getRange(2, updatedCol, n, 1).getValues();
  var stamp = nowStamp_(), done = 0;
  for (var i = 0; i < n; i++) {
    if (!only[String(ids[i][0])] || String(vals[i][0] || '') !== fromId) continue;
    vals[i][0] = toId;
    stamps[i][0] = stamp;
    done++;
  }
  if (!done) return 0;
  sheet.getRange(2, col + 1, n, 1).setValues(vals);
  sheet.getRange(2, updatedCol, n, 1).setValues(stamps);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Entries'];
  bumpVersion_('ENTRIES_VERSION');
  return done;
}
