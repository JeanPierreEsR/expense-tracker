/**
 * "Send feedback to JP": a short note a friend writes on purpose, collected in the owner's Sheet tab "Feedback" and
 * announced on his Telegram. Same door and rules as the other reports (no sign-in; every field checked here again):
 *   - the kind is one of three words, the screen one of the app's own screen names (BETA_SCREENS_), the language en/es;
 *   - the text is cut to 1,000 characters, control characters are removed, e-mail addresses become [email] and long digit
 *     runs [number] (the phone does the same before it shows the person what will be sent — docs/perf-share.js);
 *   - 10 notes per install per day, 3,000 rows in total (the Sheet row is the record; a Telegram failure loses nothing);
 *   - a friend's own copy refuses it. The tab is written only here, all text-formatted.
 * No screenshots: they would show money.
 */

var FEEDBACK_SHEET_ = 'Feedback';
var FEEDBACK_HEADERS_ = ['received_at', 'install_id', 'label', 'kind', 'screen', 'language', 'app_version', 'device', 'text'];
var FEEDBACK_KINDS_ = { broke: 1, confused: 1, idea: 1 };
var FEEDBACK_MAX_TEXT_ = 1000;
var FEEDBACK_MIN_TEXT_ = 5;
var FEEDBACK_MAX_PER_INSTALL_PER_DAY_ = 10;
var FEEDBACK_MAX_ROWS_ = 3000;

function ensureFeedbackSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(FEEDBACK_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(FEEDBACK_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, FEEDBACK_HEADERS_.length);
  headerRange.setValues([FEEDBACK_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), FEEDBACK_HEADERS_.length).setNumberFormat('@');   // text only, never a formula or a date
  return sheet;
}

// The promise the phone makes, enforced again here.
function feedbackScrub_(text) {
  var s = String(text === undefined || text === null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, '[email]')
    .replace(/\d(?:[\s.\-]?\d){7,}/g, '[number]');
  return s.trim().substring(0, FEEDBACK_MAX_TEXT_);
}

// Called by doPost BEFORE the sign-in check (see Api.gs).
function reportFeedback_(p) {
  if (isFriendCopy_()) throw codedError_('feedback_not_collected', 'This copy does not collect feedback.');
  p = p || {};
  var install = String(p.install || '');
  if (!/^[0-9a-f-]{16,36}$/.test(install)) throw codedError_('feedback_bad_report', 'Not a feedback note.');
  var kind = String(p.kind || '');
  if (!FEEDBACK_KINDS_.hasOwnProperty(kind)) throw codedError_('feedback_bad_report', 'Not a feedback note.');
  var text = feedbackScrub_(p.text);
  if (text.length < FEEDBACK_MIN_TEXT_) throw codedError_('feedback_bad_report', 'Not a feedback note.');
  var label = perfLabel_(p.label) || '(no name)';
  var screen = BETA_SCREENS_.hasOwnProperty(String(p.screen || '')) ? String(p.screen) : '';
  var language = p.language === 'es' ? 'es' : 'en';
  var app = /^[0-9A-Za-z:.\-]{1,30}$/.test(String(p.app || '')) ? String(p.app) : '';
  var device = PERF_DEVICES_[String(p.device || '')] ? String(p.device) : 'Other';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw codedError_('feedback_busy', 'Busy, try again in a moment.');
  var receivedAt;
  try {
    var cache = CacheService.getScriptCache();
    receivedAt = perfIso_(Date.now());
    var dayKey = 'feedbackday:' + install + ':' + receivedAt.substring(0, 10);
    var today = Number(cache.get(dayKey) || 0);
    if (today >= FEEDBACK_MAX_PER_INSTALL_PER_DAY_) throw codedError_('feedback_busy', 'Too many notes today, try again tomorrow.');
    var sheet = ensureFeedbackSheet_();
    if (sheet.getLastRow() - 1 >= FEEDBACK_MAX_ROWS_) throw codedError_('feedback_full', 'The feedback tab is full.');
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, FEEDBACK_HEADERS_.length)
      .setValues([[receivedAt, install, label, kind, screen, language, app, device, text]]);
    cache.put(dayKey, String(today + 1), 90000);
  } finally {
    lock.releaseLock();
  }

  try {
    sendTelegramText_(tr_('feedback.notice', { label: label, kind: kind, screen: screen || '-', text: text }));
  } catch (err) {
    console.error('feedback notice: ' + err);
  }
  return { stored: true };
}
