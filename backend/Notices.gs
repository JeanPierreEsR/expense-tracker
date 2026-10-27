/**
 * Notices — the in-app place where alerts land (specs/review-telegram-email.md § Notices; plan 2 of "New-user complications").
 *
 * Budget crossings, trip budgets and overdue loans used to go ONLY to Telegram. A friend has no Telegram, so for them the alert
 * was computed every 15 minutes, never sent and never logged. Now every alert goes through deliverNotice_:
 *
 *   1. it is written to the `Notices` tab (what the Home "Alerts" card shows), and
 *   2. if a Telegram chat is linked, it is also sent there — the same text, as before. Later channels (WhatsApp) plug in at the
 *      same place.
 *
 * Contract with the callers (checkBudgets, checkTripBudgets, checkOverdueLoans): deliverNotice_ returns true when the alert
 * reached the person, so the caller writes its own alert-log row; false means "try again next cycle", exactly as when Telegram
 * was the only channel. A linked Telegram that refuses is false (retried; the in-app notice is not duplicated, see below). With
 * no Telegram linked, the in-app notice alone counts as delivered.
 *
 * One OPEN (unseen) notice per `key`: a second alert with the same key (the 50% and then the 80% of the same budget) updates the
 * open notice's text and time instead of adding a line, so the person always reads the latest figure. After they dismiss it, a
 * new alert with that key adds a new one. Text is stored already written, in the language of the moment.
 *
 * Tab `Notices`: id, created_at, kind ('budget' | 'trip' | 'loan'), key, text, seen ('' or 'yes'). Created on first use. Dismissed
 * notices are kept for 30 days, then removed whenever a notice is added. Not in STRUCTURE_SHEETS_ (no phone reload on a write).
 */

var NOTICE_COLUMNS_ = ['id', 'created_at', 'kind', 'key', 'text', 'seen'];
var NOTICE_KEEP_SEEN_DAYS_ = 30;
var NOTICE_MAX_SHOWN_ = 20;

function ensureNoticesSheet_() {
  ensureStatementSheet_('Notices', NOTICE_COLUMNS_, ['id', 'created_at', 'key']);
}

// A bot token alone is not a linked chat: both are needed to send anything.
function telegramLinked_() {
  return !!(getTelegramToken_() && getOwnerTelegramChatId_());
}

// Returns true when the notice is stored (new, or an open one updated).
function addNotice_(kind, key, text) {
  ensureNoticesSheet_();
  var now = nowTimestamp_();
  var rows = getAllRows('Notices');
  var open = rows.filter(function (r) { return String(r.key) === String(key) && String(r.seen) !== 'yes'; })[0];
  if (open) return updateRowFields_('Notices', open.id, { text: text, created_at: now });
  appendRowObject('Notices', { id: Utilities.getUuid(), created_at: now, kind: kind, key: key, text: text, seen: '' });
  pruneNotices_(rows);
  return true;
}

function pruneNotices_(rows) {
  var cutoff = Utilities.formatDate(new Date(Date.now() - NOTICE_KEEP_SEEN_DAYS_ * 86400000), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  if (!rows.some(function (r) { return String(r.seen) === 'yes' && String(r.created_at) < cutoff; })) return;
  deleteRowsWhere_('Notices', function (r) { return String(r.seen) === 'yes' && String(r.created_at) < cutoff; });
}

function deliverNotice_(kind, key, text) {
  var stored = false;
  try { stored = addNotice_(kind, key, text); } catch (err) { console.error('notice: ' + err); }
  if (!telegramLinked_()) return stored;
  return sendTelegramText_(text);
}

// ---- What the app calls ----

// Unseen notices, newest first. Reads nothing (and creates nothing) until a first notice exists.
function listNotices() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notices')) return { notices: [] };
  var open = getAllRows('Notices').filter(function (r) { return String(r.seen) !== 'yes'; });
  open.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
  return {
    notices: open.slice(0, NOTICE_MAX_SHOWN_).map(function (r) { return { id: r.id, kind: r.kind, text: r.text, created_at: r.created_at }; }),
    more: Math.max(0, open.length - NOTICE_MAX_SHOWN_)
  };
}

// payload: { ids: [...] } or { all: true }
function markNoticesSeen(payload) {
  payload = payload || {};
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Notices')) return { marked: 0 };
  var ids = {};
  (Array.isArray(payload.ids) ? payload.ids : []).forEach(function (id) { ids[String(id)] = true; });
  var marked = 0;
  getAllRows('Notices').forEach(function (r) {
    if (String(r.seen) === 'yes') return;
    if (payload.all === true || ids[String(r.id)]) { updateRowFields_('Notices', r.id, { seen: 'yes' }); marked++; }
  });
  return { marked: marked };
}
