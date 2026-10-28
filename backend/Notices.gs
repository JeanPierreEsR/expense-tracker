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

// ---- Alerts only from now on ----
// When a copy that already exists is updated to this version, budgets may already be over a limit and loans already overdue. Alerting for
// all of that at once would be a burst of old news, so the FIRST run of each check on such a copy only writes those down as already
// alerted (the same log rows a real alert writes) and says nothing; from then on only new crossings alert. A fresh install and the test
// data are marked done at setup (markAlertBaselineDone_ in seedStarterData), as there is nothing old to hide. Script Property
// ALERTS_BASELINE_DONE = JSON {budgets, trips, loans}. A run that dies before finishing leaves its part unmarked, so the next run redoes
// it (writing the same log rows is harmless).
var ALERT_BASELINE_KEY_ = 'ALERTS_BASELINE_DONE';
var ALERT_BASELINE_PARTS_ = ['budgets', 'trips', 'loans'];

function alertBaselineRead_() {
  try {
    var done = JSON.parse(PropertiesService.getScriptProperties().getProperty(ALERT_BASELINE_KEY_) || '{}');
    return (done && typeof done === 'object') ? done : {};
  } catch (err) { return {}; }
}

function alertBaselinePending_(part) {
  return alertBaselineRead_()[part] !== true;
}

function markAlertBaselineDone_(part) {
  var done = alertBaselineRead_();
  (part ? [part] : ALERT_BASELINE_PARTS_).forEach(function (p) { done[p] = true; });
  PropertiesService.getScriptProperties().setProperty(ALERT_BASELINE_KEY_, JSON.stringify(done));
}

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

// ---- Checking alerts when the app is used (and by the "open faster" timer) ----
// The three alert checks (budgets, trip budgets, overdue loans) used to run only inside the bank-e-mail job (runAutomation, about once an
// hour for these steps), which a copy gets only if its person took the bank-e-mail extra. Without it nothing ever looked, so a friend's Alerts
// card stayed empty. Now the app asks for a check when it is opened, brought back, pulled down, and a few seconds after a change that can cross
// an alert (checkAlertsNow), and the "open faster" timer (pingWebApp_) runs it at most every 50 minutes. No Google approval is needed: the
// checks only read and write the Sheet (and send to Telegram when linked). Each check takes the script lock itself and reads its own alert log
// inside it, so the timer, the app and a second phone can overlap without alerting twice. Script Property ALERT_CHECK_LAST_AT is written BEFORE
// the checks run, so two near-simultaneous callers do the work once. The checks are slow on a real Google Sheet (seconds, not milliseconds),
// hence the gaps; the app asks in the background and never waits for the answer to show itself.
var ALERT_CHECK_LAST_KEY_ = 'ALERT_CHECK_LAST_AT';
var ALERT_CHECK_APP_GAP_MS_ = 2 * 60 * 1000;      // opening, coming back, pulling down
var ALERT_CHECK_CHANGE_GAP_MS_ = 30 * 1000;       // a few seconds after the person saved something that can cross an alert: sooner, so it shows up fast
var ALERT_CHECK_TIMER_GAP_MS_ = 50 * 60 * 1000;   // the same rhythm as runAutomation's hourly steps (Triggers.gs heavyStepsDue_)

// source: 'app', 'change' (the app, right after a save) or 'timer'. Returns { ran: false, reason: 'recent' } or
// { ran: true, failed: <how many of the three threw> }; never throws.
function checkAlertsGuarded_(source) {
  var props = PropertiesService.getScriptProperties();
  var gap = source === 'timer' ? ALERT_CHECK_TIMER_GAP_MS_ : source === 'change' ? ALERT_CHECK_CHANGE_GAP_MS_ : ALERT_CHECK_APP_GAP_MS_;
  var now = Date.now();
  var last = Number(props.getProperty(ALERT_CHECK_LAST_KEY_) || 0);
  if (last && now >= last && now - last < gap) return { ran: false, reason: 'recent' };
  props.setProperty(ALERT_CHECK_LAST_KEY_, String(now));
  var failed = 0;
  [checkBudgets, checkTripBudgets, checkOverdueLoans].forEach(function (check) {
    try { check(); } catch (err) { failed++; console.error('alert check: ' + err); }   // one failing check must not stop the others
  });
  return { ran: true, failed: failed };
}

// ---- What the app calls ----

// The app's "look at my alerts now" call: runs the checks (unless one ran a moment ago) and answers with the open notices, so the app needs
// one request instead of two. A failed check is never an error for the person. payload.after_change: the app asks right after a save.
function checkAlertsNow(payload) {
  var run = checkAlertsGuarded_(payload && payload.after_change === true ? 'change' : 'app');
  var out = listNotices();
  out.ran = run.ran;
  if (!run.ran) out.reason = run.reason;
  return out;
}

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
