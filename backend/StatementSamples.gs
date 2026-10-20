/**
 * "Send this statement": bank STATEMENTS the app cannot read yet, sent to the owner so a statement reader can be written by hand
 * (friends & family rollout; the sibling of BankSamples.gs, which does the same for bank e-mails).
 *
 * The phone reads the PDF itself (pdf.js, docs/statements.js), turns its rows into text, hides the private details and shows the
 * person exactly what would leave (docs/statement-sample.js). Only that TEXT is sent: never the PDF, never its password.
 *
 *   reportStatementSample_(p)  OWNER'S COPY, no sign-in (a friend's phone is not signed in to it; same door as reportBankSample):
 *                              stores the already-redacted text in the Sheet tab "Statement Samples" (a statement is LONG, so it is
 *                              split into parts of at most STATEMENT_SAMPLE_PART_ characters, one row each: a Sheets cell holds 50,000)
 *                              and sends the owner a short heads-up on Telegram (size and where to read it, not the text itself).
 *                              A friend's own copy refuses it.
 *
 * Nothing here trusts the phone: every field's shape is checked, every digit but 9 becomes 9 again, every e-mail address becomes
 * [email], control characters go, and size / per-phone-per-day / row counts are capped. The tab is written only here.
 */

var STATEMENT_SAMPLES_SHEET_ = 'Statement Samples';
var STATEMENT_SAMPLE_HEADERS_ = ['received_at', 'install_id', 'label', 'bank', 'kind', 'language', 'app_version', 'part', 'parts', 'chars', 'text'];
var STATEMENT_SAMPLE_MAX_TEXT_ = 200000;     // a whole statement (several pages)
var STATEMENT_SAMPLE_MIN_TEXT_ = 200;        // anything shorter is not a statement
var STATEMENT_SAMPLE_PART_ = 40000;          // under the 50,000-character limit of a Sheets cell
var STATEMENT_SAMPLE_MAX_PER_INSTALL_PER_DAY_ = 10;   // owner: each kind of statement helps, and a person may have several banks
var STATEMENT_SAMPLE_MAX_ROWS_ = 600;

function ensureStatementSamplesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATEMENT_SAMPLES_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(STATEMENT_SAMPLES_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, STATEMENT_SAMPLE_HEADERS_.length);
  headerRange.setValues([STATEMENT_SAMPLE_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // text only: nothing a sample says may ever be read as a date, a number or a formula
  sheet.getRange(1, 1, sheet.getMaxRows(), STATEMENT_SAMPLE_HEADERS_.length).setNumberFormat('@');
  return sheet;
}

// Cuts a long text into parts at line breaks (a part never ends in the middle of a row).
function statementSampleParts_(text) {
  var parts = [];
  var rest = text;
  while (rest.length > STATEMENT_SAMPLE_PART_) {
    var cut = rest.lastIndexOf('\n', STATEMENT_SAMPLE_PART_);
    if (cut < STATEMENT_SAMPLE_PART_ / 2) cut = STATEMENT_SAMPLE_PART_;
    parts.push(rest.substring(0, cut));
    rest = rest.substring(cut).replace(/^\n/, '');
  }
  parts.push(rest);
  return parts;
}

function reportStatementSample_(p) {
  if (isFriendCopy_()) throw codedError_('sample_not_collected', 'This copy does not collect statement samples.');
  p = p || {};
  var install = String(p.install || '');
  if (!/^[0-9a-f-]{16,36}$/.test(install)) throw codedError_('sample_bad_report', 'Not a statement sample.');
  var bank = perfLabel_(p.bank);
  if (!bank) throw codedError_('sample_bad_report', 'Not a statement sample.');
  var text = bankSampleScrub_(p.text, '', STATEMENT_SAMPLE_MAX_TEXT_).trim();
  if (text.length < STATEMENT_SAMPLE_MIN_TEXT_) throw codedError_('sample_bad_report', 'Not a statement sample.');
  var label = perfLabel_(p.label) || '(no name)';
  var language = p.language === 'es' ? 'es' : 'en';
  var app = /^[0-9A-Za-z:.\-]{1,30}$/.test(String(p.app || '')) ? String(p.app) : '';
  var kind = p.kind === 'unverified' ? 'unverified' : 'unrecognised';
  var parts = statementSampleParts_(text);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw codedError_('sample_busy', 'Busy, try again in a moment.');
  var receivedAt;
  try {
    var cache = CacheService.getScriptCache();
    receivedAt = perfIso_(Date.now());
    var dayKey = 'stmtsampleday:' + install + ':' + receivedAt.substring(0, 10);
    var today = Number(cache.get(dayKey) || 0);
    if (today >= STATEMENT_SAMPLE_MAX_PER_INSTALL_PER_DAY_) throw codedError_('sample_busy', 'Too many samples today, try again tomorrow.');
    var sheet = ensureStatementSamplesSheet_();
    if (sheet.getLastRow() - 1 + parts.length > STATEMENT_SAMPLE_MAX_ROWS_) throw codedError_('sample_full', 'The statement samples tab is full.');
    var rows = parts.map(function (part, i) {
      return [receivedAt, install, label, bank, kind, language, app, String(i + 1), String(parts.length), String(part.length), part];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, STATEMENT_SAMPLE_HEADERS_.length).setValues(rows);
    cache.put(dayKey, String(today + 1), 90000);
  } finally {
    lock.releaseLock();
  }

  // The Sheet rows are the record; Telegram only says that one arrived (a statement is far too long for a message).
  try {
    sendTelegramText_(tr_('statementSample.notice', { label: label, bank: bank, kind: kind, chars: text.length, parts: parts.length }));
  } catch (err) {
    console.error('statement sample notice: ' + err);
  }
  return { stored: true, parts: parts.length };
}
