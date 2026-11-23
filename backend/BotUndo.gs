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
 * How a copy is taken: before the action, every row of Entries, Entry Splits, Entry Tags, Entry Bills, Loans and Settlements is
 * read; after it, again. Only what differs is kept: the rows as they were (`before`) and a short fingerprint of how they are now
 * (`after`). Entries are keyed by id, child rows by their entry, Loans by id, Settlements by their loan. Undo first checks that
 * every fingerprint still matches (nothing changed since, in the app or by a later bot action), then puts the old rows back.
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

// Every row the undo may need, grouped: { e: {id: json}, c: {sheet: {entry_id: json of rows}}, l: {id: json}, s: {loan_id: json} }.
function botWorld_() {
  var w = { e: {}, c: {}, l: {}, s: {} };
  getAllRows('Entries').forEach(function (r) { w.e[String(r.id)] = JSON.stringify(r); });
  var childSheets = ['Entry Splits', 'Entry Tags'];
  if (entryBillsSheetExists_()) childSheets.push('Entry Bills');
  childSheets.forEach(function (name) {
    var groups = {};
    getAllRows(name).forEach(function (r) { var k = String(r.entry_id); (groups[k] = groups[k] || []).push(r); });
    w.c[name] = {};
    Object.keys(groups).forEach(function (k) { w.c[name][k] = JSON.stringify(groups[k]); });
  });
  getAllRows('Loans').forEach(function (r) { w.l[String(r.id)] = JSON.stringify(r); });
  var setts = {};
  getAllRows('Settlements').forEach(function (r) { var k = String(r.loan_id); (setts[k] = setts[k] || []).push(r); });
  Object.keys(setts).forEach(function (k) { w.s[k] = JSON.stringify(setts[k]); });
  return w;
}

// What changed between two worlds: { before: {e, c, l, s} with the old rows (null = did not exist), after: fingerprints (null = gone) }.
function botWorldDiff_(a, b) {
  var before = { e: {}, c: {}, l: {}, s: {} }, after = { e: {}, c: {}, l: {}, s: {} }, any = false;
  var cmp = function (x, y, bOut, aOut) {
    var keys = {};
    Object.keys(x).forEach(function (k) { keys[k] = true; });
    Object.keys(y).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      if (x[k] === y[k]) return;
      any = true;
      bOut[k] = x[k] === undefined ? null : JSON.parse(x[k]);
      aOut[k] = y[k] === undefined ? null : botHash_(y[k]);
    });
  };
  cmp(a.e, b.e, before.e, after.e);
  Object.keys(b.c).forEach(function (name) {
    before.c[name] = {}; after.c[name] = {};
    cmp(a.c[name] || {}, b.c[name], before.c[name], after.c[name]);
  });
  cmp(a.l, b.l, before.l, after.l);
  cmp(a.s, b.s, before.s, after.s);
  // A loan the action made or changed: its repayments are watched too, even when it had none (one recorded later blocks the undo).
  Object.keys(after.l).forEach(function (k) {
    if (after.s[k] !== undefined) return;
    before.s[k] = a.s[k] === undefined ? null : JSON.parse(a.s[k]);
    after.s[k] = b.s[k] === undefined ? null : botHash_(b.s[k]);
  });
  return any ? { before: before, after: after } : null;
}

// ---- recording ----

// Called at a bot door before the action. Returns false when another action is already being recorded in this run.
function botActionBegin_(kind, entryId, msgIds) {
  if (BOT_ACTION_) return false;
  try {
    BOT_ACTION_ = { kind: kind, entryId: String(entryId || ''), msgs: (msgIds || []).filter(Boolean).map(String), world: botWorld_(), batch: '' };
    BOT_MSG_CAPTURE_ = [];
  } catch (err) {
    BOT_ACTION_ = null;   // recording never stops the action itself
    return false;
  }
  return true;
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
    var diff = botWorldDiff_(act.world, botWorld_());
    if (!diff) {
      if (act.batch) deleteRowsWhere_('Deleted Entries', function (r) { return String(r.batch_id) === act.batch; });
      return;
    }
    var before = JSON.stringify(diff.before);
    if (before.length > BOT_UNDO_CELL_MAX_) {
      delete diff.before.c['Entry Bills'];   // a receipt photo is left as it is (the same as the app's safety copy, payload.partial)
      delete diff.after.c['Entry Bills'];
      before = JSON.stringify(diff.before);
      if (before.length > BOT_UNDO_CELL_MAX_) return;   // too big to keep: this one cannot be undone
    }
    ensureBotActionsSheet_();
    purgeOldBotActions_();
    var entryIds = {};
    if (act.entryId) entryIds[act.entryId] = true;
    Object.keys(diff.before.e).forEach(function (k) { entryIds[k] = true; });
    appendRowObject('Bot Actions', {
      id: Utilities.getUuid(), at: nowStamp_(), bot: botIsWa_() ? 'whatsapp' : 'telegram', kind: kind || act.kind,
      entry_ids: Object.keys(entryIds).join(','), msgs: act.msgs.concat(sent).join(','),
      info: JSON.stringify(botActionInfo_(act.entryId, diff)), before: before, after: JSON.stringify(diff.after),
      deleted_batch: act.batch || '', undone_at: '', undo_msgs: ''
    });
  } catch (err) {
    console.error('Bot action not recorded: ' + err);
  }
}

// What the undo answer names: the entry as it was, and the friend whose debts moved.
function botActionInfo_(entryId, diff) {
  var e = diff.before.e[entryId] || null;
  var friendIds = {};
  Object.keys(diff.before.l).forEach(function (id) {
    var row = diff.before.l[id];
    if (row && row.friend_id) friendIds[row.friend_id] = true;
  });
  getAllRows('Loans').forEach(function (l) { if (diff.after.l[String(l.id)] !== undefined && l.friend_id) friendIds[l.friend_id] = true; });
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

// Puts one action back. { ok, text } or { refuse, text }.
function undoBotAction_(row) {
  var before = JSON.parse(String(row.before)), after = JSON.parse(String(row.after));
  var info = {};
  try { info = JSON.parse(String(row.info || '{}')) || {}; } catch (err) { info = {}; }
  var now = botWorld_();
  var fp = function (map, k) { return map[k] === undefined ? null : botHash_(map[k]); };
  var changed = false, debts = false, reappeared = false;
  Object.keys(after.e).forEach(function (k) {
    var cur = fp(now.e, k);
    if (cur === after.e[k]) return;
    changed = true;
    if (after.e[k] === null && cur !== null && before.e[k]) reappeared = true;
  });
  Object.keys(after.c).forEach(function (name) {
    Object.keys(after.c[name]).forEach(function (k) { if (fp(now.c[name] || {}, k) !== after.c[name][k]) changed = true; });
  });
  Object.keys(after.l).forEach(function (k) { if (fp(now.l, k) !== after.l[k]) debts = true; });
  Object.keys(after.s).forEach(function (k) { if (fp(now.s, k) !== after.s[k]) debts = true; });
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[String(f.id)] = true; });
  Object.keys(before.l).forEach(function (k) { var l = before.l[k]; if (l && l.friend_id && !friends[String(l.friend_id)]) debts = true; });
  var what = info.what || tr_('bot.noDescription');
  if (reappeared && (row.kind === 'discard' || row.kind === 'delrep')) return { refuse: 'already', text: tr_('botUndo.already') };
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
  Object.keys(before.c).forEach(function (name) {
    var keys = Object.keys(before.c[name]);
    if (!keys.length || (name === 'Entry Bills' && !entryBillsSheetExists_())) return;
    var kk = {};
    keys.forEach(function (k) { kk[k] = true; });
    deleteRowsWhere_(name, function (r) { return kk[String(r.entry_id)] === true; });
    var rows = [];
    keys.forEach(function (k) { (before.c[name][k] || []).forEach(function (r) { rows.push(r); }); });
    appendObjectsBatch_(name, rows);
  });
  var loanKeys = Object.keys(before.l);
  if (loanKeys.length) {
    var lk = {};
    loanKeys.forEach(function (k) { lk[k] = true; });
    deleteRowsWhere_('Loans', function (r) { return lk[String(r.id)] === true; });
    appendObjectsBatch_('Loans', loanKeys.map(function (k) { return before.l[k]; }).filter(Boolean));
  }
  var settKeys = Object.keys(before.s);
  if (settKeys.length) {
    var sk = {};
    settKeys.forEach(function (k) { sk[k] = true; });
    deleteRowsWhere_('Settlements', function (r) { return sk[String(r.loan_id)] === true; });
    var setts = [];
    settKeys.forEach(function (k) { (before.s[k] || []).forEach(function (r) { setts.push(r); }); });
    appendObjectsBatch_('Settlements', setts);
  }
  if (row.deleted_batch) deleteRowsWhere_('Deleted Entries', function (r) { return String(r.batch_id) === String(row.deleted_batch); });
  return { ok: true, text: botUndoDoneText_(row.kind, info) };
}

function botUndoDoneText_(kind, info) {
  var what = info.what || tr_('bot.noDescription');
  if (kind === 'discard') return tr_('botUndo.discard', { what: what });
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
    botText_(res.text, quoted);
    var entry = getEntryById_(mainId);
    if (entry && entry.status === 'pending') sendTelegramEntryNotification_(entry);
  } finally {
    var sent = BOT_MSG_CAPTURE_ || [];
    BOT_MSG_CAPTURE_ = null;
    var ids = [String(targetId || ''), String(replyTo || '')].concat(sent).filter(Boolean);
    botMarkUndone_(found.row.id, ids);
  }
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
