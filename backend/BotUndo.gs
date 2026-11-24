/**
 * Undo on the bots (owner's plan "Undo on WhatsApp and Telegram - plan (DRAFT 2026-11-22)", approved the same day).
 * specs/review-telegram-email.md § Undo on the bots.
 *
 * Every bot action that changes something (Confirm, Discard, an edit by tap or by words, the tag / Programmed-item answers,
 * "Delete the whole repayment", "Income I was waiting for", turning an entry into a repayment or a loan) is recorded in the
 * "Bot Actions" tab with a copy of what it touched, for 30 days (the same as the app's safety copy, DELETED_ENTRIES_DAYS_).
 * The person undoes one by writing "deshacer" / "deshaz" / "undo" (the word on its own): as a reply, about the message replied
 * to; without replying, about the bot's last message (the bot's "last message" rule). There is no Undo button (owner).
 *
 * How a copy is taken: before the action, the transaction's own rows (see botScopeIds_) and every Loan with its per-loan rows are
 * read; after it, again. Only what differs is kept: the rows as they were (`before`) and a short fingerprint of how they are now
 * (`after`). Entries are keyed by id, child rows by their entry, Loans by id, Settlements and Loan Installments by their loan.
 * Undo first checks that every fingerprint still matches (nothing changed since, in the app or by a later bot action), then puts
 * the old rows back.
 */
var BOT_ACTIONS_HEADERS_ = ['id', 'at', 'bot', 'kind', 'entry_ids', 'msgs', 'info', 'before', 'after', 'deleted_batch', 'undone_at', 'undo_msgs'];
var BOT_UNDO_CELL_MAX_ = 45000;   // a cell holds 50,000 characters
var BOT_ACTION_ = null;           // the action being recorded in this run (one at a time; a nested door adds nothing)
var BOT_MSG_CAPTURE_ = null;      // message ids the bot sends while an action or an undo runs (whatsappGraphSend_, telegramNoteSent_)

function botUndoWord_(text) {
  return /^(?:deshacer|deshaz|undo)$/i.test(String(text || '').trim().replace(/[.!¡\s]+$/, ''));
}

function botNoteSentId_(id) {
  if (BOT_MSG_CAPTURE_ && id) BOT_MSG_CAPTURE_.push(String(id));
}

function ensureBotActionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Bot Actions');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Bot Actions');
  sheet.getRange(1, 1, 1, BOT_ACTIONS_HEADERS_.length).setValues([BOT_ACTIONS_HEADERS_]).setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), BOT_ACTIONS_HEADERS_.length).setNumberFormat('@');
  sheet.setFrozenRows(1);
  return sheet;
}

function botUndoCutoff_() {
  return Utilities.formatDate(new Date(Date.now() - DELETED_ENTRIES_DAYS_ * 86400000), 'UTC', "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
}

function purgeOldBotActions_() {
  var cutoff = botUndoCutoff_();
  deleteRowsWhere_('Bot Actions', function (r) { return String(r.at) < cutoff; });
}

function botHash_(text) {
  var h = 5381;
  for (var i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + text.length;
}

// ---- the copy ----
// Only the transaction's own rows are copied (owner's go, 2026-11-22, "Undo on the bots - risks to fix early" fixes 1-3): the
// entry, its exchange partner, the loans made from it or paid with it, their repayments and the entries those point to (a
// repayment's money entry and extra). A bank e-mail or an Apple Pay entry saved at the same moment is never part of it. Loans and
// their per-loan rows are compared whole (they are small), under the script lock the app's saves take too, so a phone save cannot
// land in the middle. Fingerprints leave out the last-changed stamp: only a real change refuses an undo.
var BOT_PER_LOAN_SHEETS_ = ['Settlements', 'Loan Installments'];
var BOT_UNDO_V_ = 2;

function botStrip_(rows) {
  var one = function (r) { var c = {}; Object.keys(r).forEach(function (k) { if (k !== 'updated_at') c[k] = r[k]; }); return c; };
  return JSON.stringify(Array.isArray(rows) ? rows.map(one) : one(rows));
}
function botCell_(rows) { return { raw: JSON.stringify(rows), fp: botHash_(botStrip_(rows)), old: botHash_(JSON.stringify(rows)) }; }

// The id (and currency-exchange pair) of every entry, from two columns: no whole-tab read.
function botEntryIndex_() {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  var idx = { sheet: sheet, headers: sheet.getRange(1, 1, 1, lastCol).getValues()[0], lastCol: lastCol, row: {}, pair: {}, byPair: {} };
  if (lastRow < 2) return idx;
  var idCol = headers.indexOf('id'), pairCol = headers.indexOf('exchange_pair');
  var ids = sheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  var pairs = pairCol === -1 ? null : sheet.getRange(2, pairCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0] === null || ids[i][0] === undefined ? '' : ids[i][0]);
    if (!id) continue;
    idx.row[id] = i + 2;
    var pr = pairs ? String(pairs[i][0] || '') : '';
    if (pr) { idx.pair[id] = pr; (idx.byPair[pr] = idx.byPair[pr] || []).push(id); }
  }
  return idx;
}
function botEntryRow_(idx, id) {
  var r = idx.row[id];
  if (!r) return null;
  var vals = idx.sheet.getRange(r, 1, 1, idx.lastCol).getValues()[0];
  return cleanSheetRow_('Entries', rowToObject_(idx.headers, vals, sheetDateTz_(), {}), idx.headers, r);
}

// The transaction's entries: the seed, exchange partners, and what its loans and repayments point to.
function botScopeIds_(seed, idx, loans, setts) {
  var ids = {};
  var add = function (id) { if (id) ids[String(id)] = true; };
  (seed || []).forEach(add);
  for (var round = 0; round < 3; round++) {
    Object.keys(ids).forEach(function (id) { (idx.byPair[idx.pair[id]] || []).forEach(add); });
    var loanIds = {};
    loans.forEach(function (l) { if (ids[String(l.entry_id)] || ids[String(l.transfer_entry_id)]) loanIds[String(l.id)] = true; });
    setts.forEach(function (s) { if (ids[String(s.transfer_entry_id)] || ids[String(s.gap_entry_id)]) loanIds[String(s.loan_id)] = true; });
    setts.forEach(function (s) { if (loanIds[String(s.loan_id)]) { add(s.transfer_entry_id); add(s.gap_entry_id); } });
    loans.forEach(function (l) { if (loanIds[String(l.id)]) { if (l.origin === 'entry') add(l.entry_id); add(l.transfer_entry_id); } });
  }
  return ids;
}

function botChildSheets_() {
  var names = ['Entry Splits', 'Entry Tags'];
  if (entryBillsSheetExists_()) names.push('Entry Bills');
  // A company copy: an entry's split between projects (ProjectSplits.gs; owner's go, 2026-11-22).
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Project Splits')) names.push('Project Splits');
  return names;
}
function botPerLoanSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return BOT_PER_LOAN_SHEETS_.filter(function (n) { return n === 'Settlements' || !!ss.getSheetByName(n); });
}

// { w: { e: {id: cell}, c: {sheet: {entry_id: cell}}, l: {id: cell}, p: {sheet: {loan_id: cell}} }, known: {entry id: row} }.
function botWorld_(seed, alsoIds) {
  var idx = botEntryIndex_();
  var loans = getAllRows('Loans'), setts = getAllRows('Settlements');
  var ids = botScopeIds_(seed, idx, loans, setts);
  (alsoIds || []).forEach(function (id) { ids[String(id)] = true; });
  var w = { e: {}, c: {}, l: {}, p: {} };
  Object.keys(ids).forEach(function (id) { var row = botEntryRow_(idx, id); if (row) w.e[id] = botCell_(row); });
  botChildSheets_().forEach(function (name) {
    var groups = {};
    getAllRows(name).forEach(function (r) { var k = String(r.entry_id); if (ids[k]) (groups[k] = groups[k] || []).push(r); });
    w.c[name] = {};
    Object.keys(groups).forEach(function (k) { w.c[name][k] = botCell_(groups[k]); });
  });
  loans.forEach(function (r) { w.l[String(r.id)] = botCell_(r); });
  botPerLoanSheets_().forEach(function (name) {
    var groups = {};
    (name === 'Settlements' ? setts : getAllRows(name)).forEach(function (r) { var k = String(r.loan_id); (groups[k] = groups[k] || []).push(r); });
    w.p[name] = {};
    Object.keys(groups).forEach(function (k) { w.p[name][k] = botCell_(groups[k]); });
  });
  return { w: w, ids: ids, known: idx.row };
}

// What changed: { before: old rows (null = did not exist), after: fingerprints (null = gone) }, or null when nothing did.
// knownBefore: every entry id that existed before; an entry seen only afterwards that already existed is left alone.
function botWorldDiff_(a, b, knownBefore) {
  var before = { e: {}, c: {}, l: {}, p: {} }, after = { v: BOT_UNDO_V_, e: {}, c: {}, l: {}, p: {} }, any = false;
  var cmp = function (x, y, bOut, aOut, skip) {
    var keys = {};
    Object.keys(x).forEach(function (k) { keys[k] = true; });
    Object.keys(y).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (skip && skip(k)) return;
      var xf = x[k] ? x[k].fp : null, yf = y[k] ? y[k].fp : null;
      if (xf === yf) return;
      any = true;
      bOut[k] = x[k] ? JSON.parse(x[k].raw) : null;
      aOut[k] = yf;
    });
  };
  var unknown = function (k) { return a.e[k] === undefined && knownBefore && knownBefore[k]; };
  cmp(a.e, b.e, before.e, after.e, unknown);
  Object.keys(b.c).forEach(function (name) {
    before.c[name] = {}; after.c[name] = {};
    cmp(a.c[name] || {}, b.c[name], before.c[name], after.c[name], unknown);
  });
  cmp(a.l, b.l, before.l, after.l);
  Object.keys(b.p).forEach(function (name) {
    before.p[name] = {}; after.p[name] = {};
    cmp(a.p[name] || {}, b.p[name], before.p[name], after.p[name]);
    // A loan the action made or changed: its rows here are watched too, even when it had none (a repayment recorded later on
    // a loan the bot made blocks the undo).
    Object.keys(after.l).forEach(function (k) {
      if (after.p[name][k] !== undefined) return;
      before.p[name][k] = a.p[name] && a.p[name][k] ? JSON.parse(a.p[name][k].raw) : null;
      after.p[name][k] = b.p[name][k] ? b.p[name][k].fp : null;
    });
  });
  return any ? { before: before, after: after } : null;
}

// The world after the action: the same entries, plus any entry a loan or repayment the action made or changed points to (a new
// loan's money entry, a repayment's extra), which the seed no longer reaches once the original entry is gone.
function botWorldAfter_(act) {
  var a = act.snap.w;
  var b = botWorld_(act.seed, Object.keys(a.e));
  var more = {};
  var note = function (id) { if (id && !b.ids[String(id)]) more[String(id)] = true; };
  (act.made || []).forEach(note);   // every entry this run created during the action (an overpayment owed to nobody has no link)
  Object.keys(b.w.l).forEach(function (k) {
    if (a.l[k] && a.l[k].fp === b.w.l[k].fp) return;
    var l = JSON.parse(b.w.l[k].raw);
    note(l.transfer_entry_id); if (l.origin === 'entry') note(l.entry_id);
  });
  Object.keys(b.w.p.Settlements || {}).forEach(function (k) {
    var was = a.p.Settlements && a.p.Settlements[k];
    if (was && was.fp === b.w.p.Settlements[k].fp) return;
    JSON.parse(b.w.p.Settlements[k].raw).forEach(function (st) { note(st.transfer_entry_id); note(st.gap_entry_id); });
  });
  var extra = Object.keys(more);
  return extra.length ? botWorld_(act.seed, Object.keys(a.e).concat(extra)).w : b.w;
}

// ---- recording ----

// Called at a bot door before the action. Returns false when another action is already being recorded in this run, or when
// the copy cannot be taken (the action then runs unrecorded, as before).
function botActionBegin_(kind, entryId, msgIds) {
  if (BOT_ACTION_) return false;
  var lock = LockService.getScriptLock(), ownsLock = false;
  try {
    if (!lock.hasLock()) { lock.waitLock(20000); ownsLock = true; }
    var seed = [String(entryId || '')].filter(Boolean);
    var snap = botWorld_(seed);
    BOT_ACTION_ = { kind: kind, entryId: String(entryId || ''), seed: seed, msgs: (msgIds || []).filter(Boolean).map(String), snap: snap, made: [], habits: [], batch: '', ownsLock: ownsLock, lock: lock };
    BOT_MSG_CAPTURE_ = [];
  } catch (err) {
    BOT_ACTION_ = null;   // recording never stops the action itself
    if (ownsLock) { try { lock.releaseLock(); } catch (e) { /* already released */ } }
    return false;
  }
  return true;
}

// A row this run writes while an action is recorded: a new entry (an overpayment owed to nobody links to nothing else), and what
// a conversion teaches ("Payee Habits": the next payment from that place is offered as a loan / repayment), which Undo takes back
// too (owner, 2026-11-22). Category guessing needs nothing: it learns from confirmed entries as they are now.
function botActionNoteRow_(sheetName, obj) {
  if (sheetName === 'Entries' && obj.id) BOT_ACTION_.made.push(String(obj.id));
  if (sheetName === 'Payee Habits') BOT_ACTION_.habits.push({ key: String(obj.key || ''), kind: String(obj.kind || ''), created_at: String(obj.created_at || '') });
}

// Discard: the same 30-day safety copy as the app's bulk Discard, so the entry also shows in Recently deleted.
function botActionSafetyCopy_(ids) {
  if (!BOT_ACTION_ || typeof snapshotEntriesForUndo_ !== 'function') return;
  try { BOT_ACTION_.batch = snapshotEntriesForUndo_(ids); } catch (err) { /* the undo still has its own copy */ }
}

// Called at the same door after the action and its answers. Records nothing when nothing changed.
function botActionEnd_(kind) {
  var act = BOT_ACTION_;
  var sent = BOT_MSG_CAPTURE_ || [];
  BOT_ACTION_ = null;
  BOT_MSG_CAPTURE_ = null;
  if (!act) return;
  try {
    var diff = botWorldDiff_(act.snap.w, botWorldAfter_(act), act.snap.known);
    if (!diff) {
      if (act.batch) deleteRowsWhere_('Deleted Entries', function (r) { return String(r.batch_id) === act.batch; });
      return;
    }
    var before = JSON.stringify(diff.before), billsDropped = false;
    if (before.length > BOT_UNDO_CELL_MAX_) {
      // A receipt photo is left out (the same as the app's safety copy, payload.partial); Discard brings it back from that copy.
      billsDropped = Object.keys(diff.before.c['Entry Bills'] || {}).length > 0;
      delete diff.before.c['Entry Bills'];
      delete diff.after.c['Entry Bills'];
      before = JSON.stringify(diff.before);
      if (before.length > BOT_UNDO_CELL_MAX_) return;   // too big to keep: this one cannot be undone
    }
    ensureBotActionsSheet_();
    purgeOldBotActions_();
    var entryIds = {};
    if (act.entryId) entryIds[act.entryId] = true;
    Object.keys(diff.before.e).forEach(function (k) { entryIds[k] = true; });
    var info = botActionInfo_(act.entryId, diff, act.friends);
    if (billsDropped) info.billsDropped = true;
    if (act.habits.length) info.habits = act.habits;
    appendRowObject('Bot Actions', {
      id: Utilities.getUuid(), at: nowStamp_(), bot: botIsWa_() ? 'whatsapp' : 'telegram', kind: kind || act.kind,
      entry_ids: Object.keys(entryIds).join(','), msgs: act.msgs.concat(sent).join(','),
      info: JSON.stringify(info), before: before, after: JSON.stringify(diff.after),
      deleted_batch: act.batch || '', undone_at: '', undo_msgs: ''
    });
  } catch (err) {
    console.error('Bot action not recorded: ' + err);
  } finally {
    if (act.ownsLock) { try { act.lock.releaseLock(); } catch (e) { /* already released */ } }
  }
  if (diff) BOT_ALERTS_DUE_ = BOT_ALERTS_DUE_ || 'change';
}

// What the undo answer names: the entry as it was, and the friend whose debts moved.
function botActionInfo_(entryId, diff, alsoFriends) {
  var e = diff.before.e[entryId] || null;
  var friendIds = {};
  (alsoFriends || []).forEach(function (id) { friendIds[id] = true; });   // an overpayment owed to nobody touches no loan
  Object.keys(diff.before.l).forEach(function (id) {
    var row = diff.before.l[id];
    if (row && row.friend_id) friendIds[row.friend_id] = true;
  });
  // A repayment often changes only the Settlements of a loan (grouped by loan_id), not the loan row: those loans count too, so the
  // answer names the friend (testers, 2026-11-22: "the repayment is removed" without the name).
  var touchedLoans = {};
  [diff.before.p || {}, diff.after.p || {}].forEach(function (p) {
    Object.keys(p).forEach(function (name) { Object.keys(p[name] || {}).forEach(function (k) { touchedLoans[k] = true; }); });
  });
  getAllRows('Loans').forEach(function (l) {
    if ((diff.after.l[String(l.id)] !== undefined || touchedLoans[String(l.id)]) && l.friend_id) friendIds[l.friend_id] = true;
  });
  var names = getAllRows('Friends').filter(function (f) { return friendIds[f.id]; }).map(function (f) { return f.name; });
  var fields = [];
  var now = getEntryById_(entryId);
  if (e && now) {
    ['amount', 'description', 'category_id', 'payment_method_id', 'to_payment_method_id', 'date', 'currency', 'paid_by', 'type', 'trip_id'].forEach(function (f) {
      if (String(e[f] == null ? '' : e[f]) !== String(now[f] == null ? '' : now[f])) fields.push(f);
    });
  }
  return { what: e ? botUndoWhat_(e) : '', friend: names.join(', '), fields: fields, wasPending: !!(e && e.status === 'pending'), nowConfirmed: !!(now && now.status === 'confirmed') };
}

function botUndoWhat_(e) {
  return (e.description || tr_('bot.noDescription')) + ' · ' + formatAmountText_(e.amount, e.currency);
}

// Runs fn as one recorded action (the doors that have no natural "end" of their own).
function botRecorded_(kind, entryId, msgIds, fn) {
  var mine = botActionBegin_(kind, entryId, msgIds);
  try { return fn(); } finally { if (mine) botActionEnd_(kind); }
}

// ---- undoing ----

function botActionRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bot Actions')) return [];
  return getAllRows('Bot Actions');
}

// The action a "deshacer" is about. targetId = the message replied to, or the bot's last message.
// { row } to undo, or { refuse: 'nothing' | 'already' | 'tooOld' }.
function botUndoFind_(targetId) {
  targetId = String(targetId || '');
  if (!targetId) return { refuse: 'nothing' };
  var cutoff = botUndoCutoff_();
  var rows = botActionRows_();
  var has = function (list, id) { return String(list || '').split(',').indexOf(id) !== -1; };
  var best = null, bestAt = '', viaUndo = false;
  rows.forEach(function (r) {
    if (has(r.msgs, targetId) && String(r.at) >= bestAt) { best = r; bestAt = String(r.at); viaUndo = false; }
    if (r.undone_at && has(r.undo_msgs, targetId) && String(r.undone_at) >= bestAt) { best = r; bestAt = String(r.undone_at); viaUndo = true; }
  });
  if (best) {
    if (viaUndo || best.undone_at) return { refuse: 'already' };
    if (String(best.at) < cutoff) return { refuse: 'tooOld' };
    return { row: best };
  }
  // A message about a transaction that no action names (an older card): the newest action on that transaction still undoable.
  var link = getAllRows('Telegram Messages').find(function (m) { return String(m.message_id) === targetId; });
  if (!link) return { refuse: 'nothing' };
  var mine = rows.filter(function (r) { return has(r.entry_ids, String(link.entry_id)); })
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  var open = mine.find(function (r) { return !r.undone_at && String(r.at) >= cutoff; });
  if (open) return { row: open };
  if (mine.length && mine.some(function (r) { return r.undone_at; })) return { refuse: 'already' };
  if (String(link.created_at || '') && String(link.created_at) < cutoff) return { refuse: 'tooOld' };
  return { refuse: 'nothing' };
}

// Rows recorded before version 2 kept a Settlements map `s` and fingerprints that included the last-changed stamp.
function botUndoShape_(before, after) {
  if (!before.p) { before.p = { Settlements: before.s || {} }; delete before.s; }
  if (!after.p) { after.p = { Settlements: after.s || {} }; delete after.s; }
  return after.v === BOT_UNDO_V_ ? 'fp' : 'old';
}

// Puts one action back. { ok, text } or { refuse, text }.
function undoBotAction_(row) {
  var before = JSON.parse(String(row.before)), after = JSON.parse(String(row.after));
  var key = botUndoShape_(before, after);
  var info = {};
  try { info = JSON.parse(String(row.info || '{}')) || {}; } catch (err) { info = {}; }
  var watch = {};
  Object.keys(after.e).forEach(function (k) { watch[k] = true; });
  Object.keys(after.c || {}).forEach(function (n) { Object.keys(after.c[n]).forEach(function (k) { watch[k] = true; }); });
  var now = botWorld_([], Object.keys(watch)).w;
  var fp = function (map, k) { return map && map[k] ? map[k][key] : null; };
  var changed = false, debts = false, reappeared = false;
  Object.keys(after.e).forEach(function (k) {
    var cur = fp(now.e, k);
    if (cur === after.e[k]) return;
    changed = true;
    if (after.e[k] === null && cur !== null && before.e[k]) reappeared = true;
  });
  Object.keys(after.c || {}).forEach(function (name) {
    Object.keys(after.c[name]).forEach(function (k) { if (fp(now.c[name], k) !== after.c[name][k]) changed = true; });
  });
  Object.keys(after.l).forEach(function (k) { if (fp(now.l, k) !== after.l[k]) debts = true; });
  Object.keys(after.p).forEach(function (name) {
    Object.keys(after.p[name]).forEach(function (k) { if (fp(now.p[name], k) !== after.p[name][k]) debts = true; });
  });
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[String(f.id)] = true; });
  Object.keys(before.l).forEach(function (k) { var l = before.l[k]; if (l && l.friend_id && !friends[String(l.friend_id)]) debts = true; });
  var what = info.what || tr_('bot.noDescription');
  if (reappeared && (row.kind === 'discard' || row.kind === 'delrep')) return { refuse: 'already', text: tr_('botUndo.already') };
  if (row.deleted_batch && !reappeared && !botSafetyCopyLeft_(row.deleted_batch)) return { refuse: 'forgotten', text: tr_('botUndo.forgotten', { what: what }) };
  if (changed) return { refuse: 'changed', text: tr_('botUndo.changed', { what: what }) };
  if (debts) return { refuse: 'debts', text: tr_(info.friend ? 'botUndo.debts' : 'botUndo.debtsNoName', { friend: info.friend }) };

  // Entries first (removing an entry row never removes its children here: those are put back group by group below).
  var entryKeys = Object.keys(before.e);
  if (entryKeys.length) {
    var ek = {};
    entryKeys.forEach(function (k) { ek[k] = true; });
    deleteRowsWhere_('Entries', function (r) { return ek[String(r.id)] === true; });
    var back = entryKeys.map(function (k) { return before.e[k]; }).filter(Boolean);
    appendObjectsBatch_('Entries', back);
    var backIds = {};
    back.forEach(function (e) { backIds[String(e.id)] = true; });
    if (back.length) deleteRowsWhere_('Entry Deletions', function (r) { return backIds[String(r.entry_id)] === true; });
  }
  var putBack = function (name, groups, col) {
    var keys = Object.keys(groups || {});
    if (!keys.length || !SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)) return;
    var kk = {};
    keys.forEach(function (k) { kk[k] = true; });
    deleteRowsWhere_(name, function (r) { return kk[String(r[col])] === true; });
    var rows = [];
    keys.forEach(function (k) { (groups[k] || []).forEach(function (r) { rows.push(r); }); });
    appendObjectsBatch_(name, rows);
  };
  Object.keys(before.c || {}).forEach(function (name) { putBack(name, before.c[name], 'entry_id'); });
  var loanKeys = Object.keys(before.l);
  if (loanKeys.length) {
    var lk = {};
    loanKeys.forEach(function (k) { lk[k] = true; });
    deleteRowsWhere_('Loans', function (r) { return lk[String(r.id)] === true; });
    appendObjectsBatch_('Loans', loanKeys.map(function (k) { return before.l[k]; }).filter(Boolean));
  }
  Object.keys(before.p).forEach(function (name) { putBack(name, before.p[name], 'loan_id'); });
  if (info.habits && info.habits.length && SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payee Habits')) {
    var learned = {};
    info.habits.forEach(function (h) { learned[h.key + '|' + h.kind + '|' + h.created_at] = true; });
    deleteRowsWhere_('Payee Habits', function (r) { return learned[String(r.key) + '|' + String(r.kind) + '|' + String(r.created_at)] === true; });
  }
  var text = botUndoDoneText_(row.kind, info);
  if (info.billsDropped) {
    // The photo was too big for the bot's copy: a Discard has it in the app's safety copy; anything else says so.
    if (!(row.deleted_batch && botBillsFromSafetyCopy_(row.deleted_batch))) text += ' ' + tr_('botUndo.noPhoto');
  }
  if (row.deleted_batch) deleteRowsWhere_('Deleted Entries', function (r) { return String(r.batch_id) === String(row.deleted_batch); });
  return { ok: true, text: text };
}

// A Discard's Recently deleted copy is still there. "Delete for good" there removes it, and then the bot's own copy may not bring it back.
function botSafetyCopyLeft_(batchId) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Deleted Entries')) return false;
  return getAllRows('Deleted Entries').some(function (r) { return String(r.batch_id) === String(batchId); });
}

// "Delete for good" in Recently deleted: the bot's copy of a Discard whose safety copy is now gone is deleted too (same promise:
// "It can't be restored after this").
function forgetBotActionsOfBatches_(batchIds) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!batchIds.length || !ss.getSheetByName('Bot Actions')) return;
  var left = {};
  if (ss.getSheetByName('Deleted Entries')) getAllRows('Deleted Entries').forEach(function (r) { left[String(r.batch_id)] = true; });
  var gone = {};
  batchIds.forEach(function (b) { if (b && !left[String(b)]) gone[String(b)] = true; });
  if (!Object.keys(gone).length) return;
  deleteRowsWhere_('Bot Actions', function (r) { return gone[String(r.deleted_batch)] === true; });
}

// The receipt photos of a Discard's safety copy, put back where they are missing. True when every one came back.
function botBillsFromSafetyCopy_(batchId) {
  if (!entryBillsSheetExists_()) return false;
  var have = {};
  getAllRows('Entry Bills').forEach(function (b) { have[String(b.entry_id)] = true; });
  var rows = [], whole = true;
  getAllRows('Deleted Entries').forEach(function (r) {
    if (String(r.batch_id) !== String(batchId)) return;
    var p;
    try { p = JSON.parse(String(r.payload)); } catch (err) { whole = false; return; }
    if (p.partial === 'bill') whole = false;
    (p.bills || []).forEach(function (b) { if (!have[String(b.entry_id)]) rows.push(b); });
  });
  appendObjectsBatch_('Entry Bills', rows);
  return whole;
}

// The 30 days are kept even on a copy whose bot goes quiet (runAutomation, hourly).
function purgeOldBotActionsIfAny_() {
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bot Actions')) purgeOldBotActions_();
}

function botUndoDoneText_(kind, info) {
  var what = info.what || tr_('bot.noDescription');
  if (kind === 'discard') return tr_(info.wasPending === false ? 'botUndo.discardBack' : 'botUndo.discard', { what: what });   // a "borrar" of a confirmed entry: back in the history, not waiting
  if (kind === 'delrep') return tr_('botUndo.delrep', { friend: info.friend || '' });
  if (kind === 'repayment' || kind === 'loan' || kind === 'waitpay') {
    return tr_(info.friend ? 'botUndo.' + kind : 'botUndo.' + kind + 'NoName', { what: what, friend: info.friend || '' });
  }
  if (kind === 'confirm') return tr_('botUndo.confirm', { what: what });
  var fields = (info.fields || []).map(function (f) { return tr_('botUndo.f.' + f); });
  var text = fields.length
    ? tr_(fields.length === 1 ? 'botUndo.editOne' : 'botUndo.editMany', { fields: botUndoList_(fields), what: what })
    : tr_('botUndo.edit', { what: what });
  if (info.wasPending && info.nowConfirmed) text += ' ' + tr_('botUndo.waitingAgain');
  return text;
}

function botUndoList_(items) {
  if (items.length < 2) return items.join('');
  return items.slice(0, -1).join(', ') + ' ' + tr_('botUndo.and') + ' ' + items[items.length - 1];
}

// "deshacer" on either bot. targetId = the message replied to, else the bot's last message; replyTo = the person's message.
function botUndoMessage_(targetId, replyTo) {
  var found = botUndoFind_(targetId);
  if (!found.row) return botText_(tr_('botUndo.' + found.refuse), replyTo);
  var res = withScriptLockOnce_(function () { return undoBotAction_(found.row); });
  if (!res.ok) return botText_(res.text, replyTo);
  BOT_MSG_CAPTURE_ = [];
  try {
    // Quoting the transaction's message links the answer to it, so a second "deshacer" right after is about this undo.
    var mainId = String(found.row.entry_ids || '').split(',')[0];
    var quoted = targetId && getAllRows('Telegram Messages').some(function (m) { return String(m.message_id) === String(targetId); }) ? targetId : (whatsappCardFor_(mainId) || replyTo);
    var entry = getEntryById_(mainId);
    var still = entry && entry.status === 'confirmed' && found.row.kind !== 'discard' && found.row.kind !== 'delrep';
    botText_(still ? res.text + '\n' + tr_('botUndo.stillThere', { what: botUndoWhat_(entry) }) : res.text, quoted);
    // The transaction's card again, as it is now (owner, 2026-11-23): waiting, with its buttons; confirmed, without them. A plain
    // message after the undo then refers to it, as after any card.
    if (entry) sendTelegramEntryNotification_(entry);
    // A repayment waiting for its loans again: its list of loans comes back under the card (testers 2.68.2).
    var back = entry ? getEntryById_(entry.id) : null;
    if (back && back.status === 'pending' && repayIntentOf_(back)) botRepayLoanList_(back.id, whatsappCardFor_(back.id) || quoted);
  } finally {
    var sent = BOT_MSG_CAPTURE_ || [];
    BOT_MSG_CAPTURE_ = null;
    var ids = [String(targetId || ''), String(replyTo || '')].concat(sent).filter(Boolean);
    botMarkUndone_(found.row.id, ids);
  }
  BOT_ALERTS_DUE_ = 'force';
}

// ---- "borrar" / "delete" on either bot (owner, 2026-11-23: testers found no way to remove a wrong entry from the chat) ----
// As a reply to a transaction's card, or plain (the transaction of the bot's last message). A waiting one is discarded (as the
// Discard button); a confirmed one is deleted with the app's own safety copy (Recently deleted, 30 days). Both are recorded, so
// "deshacer" brings it back. A part of a loan or repayment is never deleted here: the app knows its debts.
function botDeleteWord_(text) {
  return /^\s*(?:borrar|b[oó]rralo|eliminar|elim[ií]nalo|delete|delete it|remove)\s*[.!]?\s*$/i.test(String(text || ''));
}

function botDeleteMessage_(targetId, replyTo) {
  var entryId = targetId ? whatsappCardEntry_(targetId) : '';
  var entry = entryId ? getEntryById_(entryId) : null;
  if (!entryId) return botText_(tr_('botDelete.which'), replyTo);
  if (!entry) return botText_(tr_('bot.entryGone'), replyTo);
  if (repaymentPartInfo_(entryId) || (entry.status !== 'pending' && entryBulkVerdict_(entry))) return botText_(tr_('botDelete.kept', { what: botUndoWhat_(entry) }), replyTo);
  var what = botUndoWhat_(entry);
  var recording = botActionBegin_('discard', entryId, [targetId, replyTo]);
  var reply;
  try {
    if (entry.status === 'pending') {
      var pair = pendingExchangePair_(entry);
      if (recording) botActionSafetyCopy_(pair ? [pair.out.id, pair['in'].id] : [entryId]);
      discardEntryWithRepayments_(entryId);
      if (pair) discardEntryWithRepayments_(pair.out.id === entryId ? pair['in'].id : pair.out.id);
    } else {
      var res = deleteEntries({ ids: [entryId] });
      if (!res.deleted.length) { reply = tr_('botDelete.kept', { what: what }); }
      else if (BOT_ACTION_) BOT_ACTION_.batch = res.batch_id || '';
    }
    if (!reply) reply = tr_('botDelete.deleted', { what: what });
    botText_(reply, replyTo);
  } catch (err) {
    botText_(tr_('bot.notDiscarded', { error: err.message }), replyTo);
  } finally {
    if (recording) botActionEnd_('discard');
  }
}

// After a bot action or its undo, the alerts are looked at again (as the app does a few seconds after a save): a budget that went
// over gets its alert now, and one back under loses its notice (testers, 2026-11-22: the red notice stayed after "deshacer").
// Never inside the action's lock: each check takes and releases the script lock itself.
// Set by a recorded bot action ('change') or an undo ('force'); run by doPost once the bot's answer is sent and no lock is held.
var BOT_ALERTS_DUE_ = '';
function botAlertsIfDue_() {
  var due = BOT_ALERTS_DUE_;
  BOT_ALERTS_DUE_ = '';
  if (due) botAlertsAfter_(due === 'force');
}

// force (an undo, rare): even when a check ran a moment ago, since that check saw the world before the undo.
function botAlertsAfter_(force) {
  try {
    if (typeof checkAlertsGuarded_ !== 'function') return;
    if (force) PropertiesService.getScriptProperties().deleteProperty(ALERT_CHECK_LAST_KEY_);
    checkAlertsGuarded_('change');
  } catch (err) { console.error('bot alerts: ' + err); }
}

function botMarkUndone_(id, msgIds) {
  var sheet = getSheet('Bot Actions');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex === -1) return;
  sheet.getRange(rowIndex, headers.indexOf('undone_at') + 1).setValue(nowStamp_());
  sheet.getRange(rowIndex, headers.indexOf('undo_msgs') + 1).setValue(msgIds.join(','));
  if (ROWS_MEMO_) delete ROWS_MEMO_['Bot Actions'];
}
