/**
 * Extra e-mail accounts (More → Email accounts).
 *
 * The app reads bank e-mail from ONE Gmail inbox (the account its backend runs under). A person whose banks write to
 * another Google account installs a tiny "reader" script THERE (text made by addEmailAccount, pasted by the person
 * into script.google.com while signed in to only that account). Every 15 minutes the reader asks this backend which
 * bank senders it knows, which e-mails it has handled already, and PUSHES the new ones; they go through the same parsing
 * rules as the main inbox and land as `pending` in the review queue (CLAUDE.md principle 6).
 *
 * Why push and not pull: reading another person's Gmail from here would need that account's OAuth consent for this
 * project, which Google restricts for Gmail; a script the person runs in their OWN account needs no review and its
 * approval never expires.
 *
 * The reader's request is the second action that needs no sign-in (like BankSamples.gs), so it is checked hard:
 *   - the pairing code is random, shown once inside the reader text, and only its SHA-256 is stored in the sheet;
 *   - the reader reports its own address; if it differs from the one the person typed the push is refused (the
 *     "wrong account" check: several Google accounts in one browser put the script in the default account);
 *   - at most 40 e-mails (50,000 characters each) per push; nothing is accepted from an unknown sender;
 *   - removing the account deletes the row, which cuts the reader off at once.
 * The tab is not in TABLE_DEFINITIONS (like Perf Reports): it is created on first use, and is never exported.
 */

var EMAIL_ACCOUNTS_SHEET_ = 'Email Accounts';
var EMAIL_ACCOUNT_HEADERS_ = ['id', 'address', 'code_hash', 'status', 'created_at', 'linked_at', 'last_seen_at', 'last_error'];
var EMAIL_ACCOUNTS_MAX_ = 5;
var EMAIL_PUSH_MAX_MESSAGES_ = 40;
var EMAIL_PUSH_MAX_BODY_ = 50000;

function ensureEmailAccountsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EMAIL_ACCOUNTS_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(EMAIL_ACCOUNTS_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, EMAIL_ACCOUNT_HEADERS_.length);
  headerRange.setValues([EMAIL_ACCOUNT_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), EMAIL_ACCOUNT_HEADERS_.length).setNumberFormat('@');   // timestamps / hashes stay text
  return sheet;
}

function emailAccountRows_() {
  ensureEmailAccountsSheet_();
  return getAllRows(EMAIL_ACCOUNTS_SHEET_);
}

function normalizeAddress_(raw) {
  var s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  return /^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(s) && s.length <= 120 ? s : '';
}

// What the app may see: never the code hash.
function publicEmailAccount_(r) {
  return {
    id: String(r.id), address: String(r.address), status: String(r.status || 'waiting'),
    linked_at: String(r.linked_at || ''), last_seen_at: String(r.last_seen_at || ''), last_error: String(r.last_error || '')
  };
}

function listEmailAccounts() {
  return { accounts: emailAccountRows_().map(publicEmailAccount_) };
}

/**
 * Starts pairing a new account. payload: { address, apiUrl }. Returns { account, script } — the script text holds the
 * only copy of the pairing code (the sheet keeps its hash), so a lost script means remove + add again.
 */
function addEmailAccount(payload) {
  if (!featureOn_('gmail')) throw new Error(tr_('feature.gmailOff'));
  var address = normalizeAddress_(payload && payload.address);
  if (!address) throw new Error(tr_('emailAcct.badAddress'));
  var url = String((payload && payload.apiUrl) || '');
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw new Error(tr_('emailAcct.noUrl'));
  var rows = emailAccountRows_();
  if (rows.length >= EMAIL_ACCOUNTS_MAX_) throw new Error(tr_('emailAcct.tooMany', { n: EMAIL_ACCOUNTS_MAX_ }));
  if (rows.some(function (r) { return String(r.address) === address; })) throw new Error(tr_('emailAcct.duplicate'));
  var id = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  var code = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  appendRowObject(EMAIL_ACCOUNTS_SHEET_, {
    id: id, address: address, code_hash: sha256Hex_(code), status: 'waiting', created_at: nowTimestamp_(),
    linked_at: '', last_seen_at: '', last_error: ''
  });
  return { account: publicEmailAccount_({ id: id, address: address, status: 'waiting' }), script: emailReaderScript_(url, id, code) };
}

function removeEmailAccount(payload) {
  var id = String((payload && payload.id) || '');
  var before = emailAccountRows_().length;
  deleteRowsWhere_(EMAIL_ACCOUNTS_SHEET_, function (r) { return String(r.id) === id; });
  if (emailAccountRows_().length === before) throw new Error(tr_('emailAcct.notFound'));
  return { removed: true };
}

// ---- The reader's requests (no sign-in; the pairing code is the key) ----

function constantTimeEquals_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function emailReaderError_(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/**
 * payload: { id, code, address, step: 'hello' | 'push', messages? }
 *   hello -> { senders, handled }  (marks the account connected after the wrong-account check)
 *   push  -> { created, skipped, duplicates, unparsed, errors }
 */
function emailReaderRequest_(payload) {
  payload = payload || {};
  if (!featureOn_('gmail')) throw emailReaderError_('off', 'E-mail reading is not turned on for this app.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var id = String(payload.id || '');
    var row = emailAccountRows_().filter(function (r) { return String(r.id) === id; })[0];
    if (!row || !constantTimeEquals_(sha256Hex_(String(payload.code || '')), row.code_hash)) {
      recordFailedAccessAttempt_('email reader');
      throw emailReaderError_('unknown_account', 'This reader is not paired with the app (it may have been removed).');
    }
    var actual = normalizeAddress_(payload.address);
    if (actual !== String(row.address)) {
      updateRowFields_(EMAIL_ACCOUNTS_SHEET_, id, { status: 'wrong_account', last_seen_at: nowTimestamp_(), last_error: actual || '?' });
      throw emailReaderError_('wrong_account', 'This script is running in ' + (actual || 'an unknown account') + ', but the app expects ' + row.address + '. Open script.google.com in a private window signed in to ' + row.address + ' only.');
    }
    var fields = { status: 'connected', last_seen_at: nowTimestamp_(), last_error: '' };
    if (!row.linked_at) fields.linked_at = nowTimestamp_();
    updateRowFields_(EMAIL_ACCOUNTS_SHEET_, id, fields);

    if (payload.step === 'hello') {
      var prefix = 'x' + id + ':';
      var handled = [];
      Object.keys(loadProcessedEmailIds_()).forEach(function (k) {
        if (k.indexOf(prefix) === 0) handled.push(k.slice(prefix.length));
      });
      return { senders: uniqueSenders_(), handled: handled };
    }
    return processPushedEmails_(id, payload.messages);
  } finally {
    lock.releaseLock();
  }
}

// Same pipeline as processEmails, for e-mails the reader pushed (ids are namespaced per account).
function processPushedEmails_(accountId, messages) {
  var results = { created: 0, skipped: 0, duplicates: 0, unparsed: 0, errors: 0, unparsedSubjects: [] };
  if (!Array.isArray(messages)) return results;
  var senders = uniqueSenders_();
  var existingExternalIds = {};
  getAllRows('Entries').forEach(function (e) { if (e.external_id) existingExternalIds[e.external_id] = true; });
  var banks = getAllRows('Banks');
  var paymentMethods = getAllRows('Payment Methods');
  ensureEntriesMerchantColumn_();
  ensureEntriesToPaymentMethodColumn_();
  var guessCtx = buildGuessContext_();
  var handled = loadProcessedEmailIds_();

  messages.slice(0, EMAIL_PUSH_MAX_MESSAGES_).forEach(function (m) {
    if (!m || typeof m !== 'object') { results.errors++; return; }
    var rawId = String(m.id || '');
    var date = new Date(Number(m.date));
    if (!/^[A-Za-z0-9]{6,40}$/.test(rawId) || isNaN(date.getTime())) { results.errors++; return; }
    var messageId = 'x' + accountId + ':' + rawId;
    if (handled[messageId]) return;
    var from = String(m.from || '').toLowerCase();
    var sender = senders.filter(function (s) { return from.indexOf(s.toLowerCase()) >= 0; })[0];
    if (!sender) { results.skipped++; return; }   // never a bank we have a rule for: ignore, and do not even remember it
    var message = {
      getId: function () { return messageId; },
      getSubject: function () { return String(m.subject || '').slice(0, 300); },
      getFrom: function () { return String(m.from || ''); },
      getDate: function () { return date; },
      getPlainBody: function () { return String(m.body || '').slice(0, EMAIL_PUSH_MAX_BODY_); }
    };
    try {
      processOneMessage_(message, sender, results, existingExternalIds, banks, paymentMethods, guessCtx);
      recordProcessedEmail_(messageId);
      handled[messageId] = true;
    } catch (err) {
      results.errors++;
      console.error('processPushedEmails_: ' + err);
    }
  });
  return results;
}

// ---- The text the person pastes into script.google.com ----

function emailReaderScript_(url, id, code) {
  return EMAIL_READER_TEMPLATE_.replace('__URL__', url).replace('__ID__', id).replace('__CODE__', code);
}

// Plain ES5 on purpose; the person can read it. It only READS this account's inbox and SENDS to the app's address.
var EMAIL_READER_TEMPLATE_ = [
  "// Bank e-mail reader for your Expense tracker app.",
  "// It reads bank e-mails from THIS Google account and sends them to YOUR app. It changes nothing in your mailbox.",
  "var APP_URL = '__URL__';",
  "var ACCOUNT_ID = '__ID__';",
  "var CODE = '__CODE__';",
  "",
  "function call_(step, extra) {",
  "  var body = { action: 'emailReader', payload: { id: ACCOUNT_ID, code: CODE, step: step,",
  "    address: Session.getEffectiveUser().getEmail(), messages: extra || [] } };",
  "  var res = UrlFetchApp.fetch(APP_URL, { method: 'post', contentType: 'application/json',",
  "    payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: true });",
  "  var out = JSON.parse(res.getContentText());",
  "  if (!out.ok) throw new Error(out.error || 'The app did not accept this reader.');",
  "  return out.data;",
  "}",
  "",
  "function sendNewMails() {",
  "  var hello = call_('hello');",
  "  if (!hello.senders.length) return;",
  "  var known = {};",
  "  hello.handled.forEach(function (id) { known[id] = true; });",
  "  var query = 'from:(' + hello.senders.join(' OR ') + ') newer_than:3d';",
  "  var fresh = [];",
  "  GmailApp.search(query, 0, 100).forEach(function (thread) {",
  "    thread.getMessages().forEach(function (m) {",
  "      if (known[m.getId()] || fresh.length >= 40) return;",
  "      fresh.push({ id: m.getId(), from: m.getFrom(), subject: m.getSubject(),",
  "        date: m.getDate().getTime(), body: m.getPlainBody().slice(0, 50000) });",
  "    });",
  "  });",
  "  if (fresh.length) Logger.log(JSON.stringify(call_('push', fresh)));",
  "}",
  "",
  "// Press Run on THIS function once: it checks the account and then repeats every 15 minutes by itself.",
  "function setup() {",
  "  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });",
  "  sendNewMails();",
  "  ScriptApp.newTrigger('sendNewMails').timeBased().everyMinutes(15).create();",
  "  Logger.log('Connected. You can close this page.');",
  "}",
  ""
].join('\n');
