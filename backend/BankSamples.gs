/**
 * "My bank isn't supported yet": e-mails from banks the app cannot read, sent to the owner so a parsing rule can be
 * written (friends & family rollout). Two halves:
 *
 *   FRIEND'S COPY (signed in, reads the person's OWN Gmail):
 *     listSampleEmails({sender})  recent e-mails from one address: id, subject, date — no contents
 *     getSampleEmail({id, sender}) the text of ONE e-mail the person picked, handed to the phone, which hides the
 *                                  private details and shows the result before anything is sent (docs/bank-sample.js)
 *   OWNER'S COPY (needs no sign-in, like reportPerf — friends' phones are not signed in to it):
 *     reportBankSample_(p)         stores the already-redacted text in the Sheet tab "Bank Samples" and sends it to
 *                                  the owner on Telegram. Friends' own copies refuse it.
 *
 * The phone redacts, but nothing here trusts that: reportBankSample_ checks every field's shape, turns every digit
 * but 9 into 9 again, replaces any e-mail address other than the bank's own, strips control characters, and caps
 * the size and the number per phone per day. The tab is written only here (not in TABLE_DEFINITIONS).
 */

var BANK_SAMPLES_SHEET_ = 'Bank Samples';
var BANK_SAMPLE_HEADERS_ = ['received_at', 'install_id', 'label', 'sender', 'subject', 'language', 'app_version', 'how', 'text'];
var BANK_SAMPLE_MAX_TEXT_ = 6000;
var BANK_SAMPLE_MAX_SUBJECT_ = 200;
var BANK_SAMPLE_MAX_PER_INSTALL_PER_DAY_ = 10;
var BANK_SAMPLE_MAX_ROWS_ = 3000;
var BANK_SAMPLE_TELEGRAM_CHARS_ = 3600;   // Telegram refuses a message over 4,096 characters
var BANK_SAMPLE_ADDRESS_ = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function ensureBankSamplesSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BANK_SAMPLES_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(BANK_SAMPLES_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, BANK_SAMPLE_HEADERS_.length);
  headerRange.setValues([BANK_SAMPLE_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // text only: nothing a sample says may ever be read as a date, a number or a formula
  sheet.getRange(1, 1, sheet.getMaxRows(), BANK_SAMPLE_HEADERS_.length).setNumberFormat('@');
  return sheet;
}

function bankSampleSender_(raw) {
  var s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return BANK_SAMPLE_ADDRESS_.test(s) ? s : '';
}

// The same promise the phone makes, enforced again here.
function bankSampleScrub_(text, sender, maxChars) {
  var s = String(text === undefined || text === null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi, function (m) { return m.toLowerCase() === sender ? m : '[email]'; })
    .replace(/[0-8]/g, '9');
  return s.length > maxChars ? s.substring(0, maxChars) : s;
}

// ---- friend's copy: pick an e-mail from their own Gmail ----

function listSampleEmails(p) {
  requireFeature_('gmail', 'err.bankSampleGmailOff');
  var sender = bankSampleSender_(p && p.sender);
  if (!sender) throw codedError_('sample_bad_sender', tr_('err.bankSampleBadSender'));
  var msgs = gmailSearchMessages_('from:' + sender + ' newer_than:180d', { max: 15 });
  return msgs.map(function (m) {
    return {
      id: m.getId(),
      subject: String(m.getSubject() || '').substring(0, BANK_SAMPLE_MAX_SUBJECT_),
      date: Utilities.formatDate(m.getDate(), 'UTC', "yyyy-MM-dd")
    };
  });
}

function getSampleEmail(p) {
  requireFeature_('gmail', 'err.bankSampleGmailOff');
  var sender = bankSampleSender_(p && p.sender);
  var id = String((p && p.id) || '');
  if (!sender || !/^[A-Za-z0-9_-]{2,64}$/.test(id)) throw codedError_('sample_bad_sender', tr_('err.bankSampleBadSender'));
  // only mail from the address the person named: this screen is not a general e-mail reader. The check is "was it in the
  // list this screen showed" (the same search), not a read of the From header, which Gmail may write in another form.
  var listed = gmailSearchMessages_('from:' + sender + ' newer_than:180d', { max: 15 }).some(function (x) { return x.getId() === id; });
  if (!listed) throw codedError_('sample_wrong_sender', tr_('err.bankSampleWrongSender'));
  var m = gmailGetMessage_(id);
  return {
    subject: String(m.getSubject() || '').substring(0, BANK_SAMPLE_MAX_SUBJECT_),
    body: String(m.getPlainBody() || '').substring(0, 20000)
  };
}

// ---- friend's copy: which bank addresses the app can read now ----
// The phone remembers the sender address of every e-mail the person sent as a sample (docs/bank-sample.js). When a newer
// backend version has a rule for that address, the app tells the person their bank is ready. Only the addresses (and the
// bank each rule belongs to) are listed — nothing of what a rule does. A sender that only has "ignore" rules is not listed.
function listSupportedSenders() {
  var seen = {};
  var out = [];
  EMAIL_RULES.forEach(function (r) {
    if (r.skip || !r.sender) return;
    var sender = String(r.sender).toLowerCase();
    if (seen[sender]) return;
    seen[sender] = true;
    out.push({ sender: sender, bank: String(r.bank || '') });
  });
  // Built-in statement senders count too: a friend who sent a STATEMENT sample waits for the same "your bank is ready" message.
  STATEMENT_SENDERS_.forEach(function (s) {
    if (seen[s.address]) return;
    seen[s.address] = true;
    out.push({ sender: s.address, bank: String(s.label || '') });
  });
  return out;
}

// ---- owner's copy: receive a redacted sample ----

function reportBankSample_(p) {
  if (isFriendCopy_()) throw codedError_('sample_not_collected', 'This copy does not collect bank samples.');
  p = p || {};
  var install = String(p.install || '');
  if (!/^[0-9a-f-]{16,36}$/.test(install)) throw codedError_('sample_bad_report', 'Not a bank sample.');
  var sender = bankSampleSender_(p.sender);
  if (!sender) throw codedError_('sample_bad_report', 'Not a bank sample.');
  var text = bankSampleScrub_(p.text, sender, BANK_SAMPLE_MAX_TEXT_).trim();
  if (text.length < 20) throw codedError_('sample_bad_report', 'Not a bank sample.');
  var subject = bankSampleScrub_(p.subject, sender, BANK_SAMPLE_MAX_SUBJECT_).replace(/\s+/g, ' ').trim();
  var label = perfLabel_(p.label) || '(no name)';
  var language = p.language === 'es' ? 'es' : 'en';
  var app = /^[0-9A-Za-z:.\-]{1,30}$/.test(String(p.app || '')) ? String(p.app) : '';
  var how = p.how === 'pasted' ? 'pasted' : 'picked';

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw codedError_('sample_busy', 'Busy, try again in a moment.');
  var sheet, receivedAt;
  try {
    var cache = CacheService.getScriptCache();
    receivedAt = perfIso_(Date.now());
    var dayKey = 'sampleday:' + install + ':' + receivedAt.substring(0, 10);
    var today = Number(cache.get(dayKey) || 0);
    if (today >= BANK_SAMPLE_MAX_PER_INSTALL_PER_DAY_) throw codedError_('sample_busy', 'Too many samples today, try again tomorrow.');
    sheet = ensureBankSamplesSheet_();
    if (sheet.getLastRow() - 1 >= BANK_SAMPLE_MAX_ROWS_) throw codedError_('sample_full', 'The bank samples tab is full.');
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, BANK_SAMPLE_HEADERS_.length)
      .setValues([[receivedAt, install, label, sender, subject, language, app, how, text]]);
    cache.put(dayKey, String(today + 1), 90000);
  } finally {
    lock.releaseLock();
  }

  // The Sheet row is the record; the Telegram message is the heads-up. A Telegram failure never loses the sample.
  try {
    var shown = text.length > BANK_SAMPLE_TELEGRAM_CHARS_ ? text.substring(0, BANK_SAMPLE_TELEGRAM_CHARS_) + '\n[…]' : text;
    sendTelegramText_(tr_('bankSample.notice', { label: label, sender: sender, subject: subject || '-', text: shown }));
  } catch (err) {
    console.error('bank sample notice: ' + err);
  }
  return { stored: true };
}
