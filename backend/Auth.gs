/**
 * Access control for the Web App API. The real code lives only in this
 * spreadsheet's Script Properties (never in a file, so it's never in git).
 * Set it once via the "Expense Tracker Setup" menu after opening the Sheet.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Expense Tracker Setup')
    .addItem('1. Build sheet tabs', 'setupSpreadsheet')
    .addItem('2. Seed starter data', 'seedStarterData')
    .addItem('3. Set access code', 'promptSetAccessCode')
    .addItem('4. Reset expense categories', 'resetExpenseCategories')
    .addItem('5. Fix rows missing an ID', 'backfillMissingIds')
    .addItem('6. Reset income categories', 'resetIncomeCategories')
    .addItem('7. Reset banks', 'resetBanks')
    .addItem('8. Link payment methods to banks', 'linkPaymentMethodsToBanks')
    .addItem('9. Set Telegram bot token', 'promptSetTelegramToken')
    .addItem('10. Document parsing rules', 'seedParsingRulesDoc')
    .addItem('11. Run automation now (manual test)', 'runAutomationNow')
    .addItem('12. Enable automatic scanning (every 15 min)', 'enableAutomaticScanning')
    .addItem('13. Disable automatic scanning', 'disableAutomaticScanning')
    .addItem('14. Seed category keywords', 'seedCategoryKeywords')
    .addItem('15. Enable instant Telegram replies (webhook)', 'enableTelegramWebhook')
    .addItem('16. Disable instant Telegram replies (back to polling)', 'disableTelegramWebhook')
    .addItem('17. Set Telegram relay URL (Cloudflare Worker)', 'promptSetTelegramRelayUrl')
    .addItem('18. Set up investment platforms', 'menuSetupInvestmentPlatforms')
    .addItem('19. Enable keep-warm ping (every 5 min)', 'enableKeepWarmPing')
    .addItem('20. Disable keep-warm ping', 'disableKeepWarmPing')
    .addItem('21. Fill transfer descriptions (from X to Y)', 'menuFillTransferDescriptions')
    .addItem('22. Check access code strength', 'menuCheckAccessCodeStrength')
    .addItem('23. Generate a strong access code', 'menuGenerateAccessCode')
    .addItem('24. Protect the Telegram webhook', 'menuProtectTelegramWebhook')
    .addItem('25. Generate a key for the Mac helper', 'menuGenerateHelperKey')
    .addItem('26. Require sign-in sessions (on/off)', 'menuRequireSessions')
    .addItem('27. Sign out all devices', 'menuSignOutAllDevices')
    .addToUi();
}

function promptSetAccessCode() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    'Set Access Code',
    'Paste the access code Claude gave you:',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() === ui.Button.OK) {
    var code = result.getResponseText().trim();
    if (code) {
      var problem = accessCodeProblem_(code);
      if (problem) { ui.alert('Access code NOT saved: ' + problem); return; }
      PropertiesService.getScriptProperties().setProperty('ACCESS_CODE', code);
      ui.alert('Access code saved.');
    }
  }
}

function isValidAccessCode(code) {
  var stored = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
  return !!stored && code === stored;
}

// ---- Protecting the access code ----
// The web app is public and Apps Script can't tell callers apart, so a lockout
// ("N wrong guesses -> reject everyone") would let a stranger lock the owner out
// for good. What actually protects the code is that it's long and random, so
// that is enforced; wrong-guess bursts are reported rather than blocked.

var ACCESS_CODE_MIN_LENGTH_ = 16;

// '' when acceptable, otherwise a plain-language reason.
function accessCodeProblem_(code) {
  code = String(code || '');
  if (code.length < ACCESS_CODE_MIN_LENGTH_) {
    return 'it is too short (' + code.length + ' characters; at least ' + ACCESS_CODE_MIN_LENGTH_ + ' are needed). Use menu item 23 to generate a strong one.';
  }
  var distinct = {};
  code.split('').forEach(function (c) { distinct[c] = true; });
  if (Object.keys(distinct).length < 8) return 'it is too simple (too few different characters). Use menu item 23 to generate a strong one.';
  return '';
}

// 32 random characters (two UUIDs' worth of randomness, ~244 bits).
function generateAccessCode_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 32);
}

function menuCheckAccessCodeStrength() {
  var ui = SpreadsheetApp.getUi();
  var stored = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE') || '';
  var problem = stored ? accessCodeProblem_(stored) : 'no access code is set.';
  ui.alert(!stored
    ? 'No access code is set. Use menu item 23 to generate one.'
    : 'Your access code is ' + stored.length + ' characters long — ' + (problem
      ? 'NOT strong enough: ' + problem
      : 'strong enough. (The code itself is never shown here.)'));
}

function menuGenerateAccessCode() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Generate a new access code?',
    'This REPLACES your current access code immediately. Afterwards you must: (1) enter the new code once in the app on your phone, and (2) put it in the Mac helper\'s config.json (access_code). Until then they will be rejected. Continue?',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  var code = generateAccessCode_();
  PropertiesService.getScriptProperties().setProperty('ACCESS_CODE', code);
  ui.alert('Your new access code (shown only now — copy it somewhere safe, then close this): ' + code);
}

// Counts wrong-code attempts per hour (wrong codes only — a correct code is never
// counted, delayed or blocked) and tells the owner on Telegram when a burst
// starts: at 10, 50 and 250 in an hour. Best effort: it never throws and never
// changes the rejection itself.
var ACCESS_ALERT_LEVELS_ = [10, 50, 250];

function recordFailedAccessAttempt_(source) {
  try {
    var hour = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHH');
    var cache = CacheService.getScriptCache();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(300)) return;
    var count, alertedLevel;
    try {
      count = Number(cache.get('authfail_' + hour) || 0) + 1;
      cache.put('authfail_' + hour, String(count), 7200);
      alertedLevel = Number(cache.get('authfail_alerted_' + hour) || 0);
      var level = 0;
      ACCESS_ALERT_LEVELS_.forEach(function (l) { if (count >= l) level = l; });
      if (level <= alertedLevel) return;
      cache.put('authfail_alerted_' + hour, String(level), 7200);
    } finally {
      lock.releaseLock();
    }
    sendTelegramText_('⚠️ ' + count + ' wrong access-code attempts in the last hour (' + source + '). If that was not you, someone may be guessing your code — check its strength with the sheet menu (item 22) and replace it if it is not long and random (item 23).');
  } catch (err) {
    console.error('recordFailedAccessAttempt_: ' + err);
  }
}


// ---- Sign-in sessions (2026-10-05) ----
// The access code is typed once, to `login`; the app then holds a long random
// session key instead of the code and each device can be signed out. Only the
// sign-in step has a lockout (10 wrong codes -> 10 minutes), so an attacker can
// block NEW sign-ins but never a session that already exists. Telegram's /start
// shares the same lockout. Until sessions are REQUIRED (menu 26) the raw access
// code is still accepted everywhere, so an old copy of the app keeps working.

var SESSION_IDLE_DAYS_ = 90;
var LOGIN_MAX_FAILURES_ = 10;
var LOGIN_LOCK_SECONDS_ = 600;
var CURRENT_SESSION_ID_ = '';   // set per request by authenticateRequest_
// The Mac OCR helper's key opens ONLY these.
var HELPER_ACTIONS_ = { listPhotoJobs: true, getPhotoJob: true, submitPhotoJobText: true, failPhotoJob: true };

function isRequireSessions_() {
  return PropertiesService.getScriptProperties().getProperty('REQUIRE_SESSIONS') === 'true';
}

function isValidHelperKey_(key) {
  var stored = PropertiesService.getScriptProperties().getProperty('HELPER_KEY');
  return !!stored && String(key) === stored;
}

// One decision for every request: a session key, the helper key (its four
// actions only), or the raw access code (unless sessions are required).
function authenticateRequest_(body) {
  CURRENT_SESSION_ID_ = '';
  if (body.sessionToken !== undefined) {
    var id = validateSession_(String(body.sessionToken));
    if (!id) return false;
    CURRENT_SESSION_ID_ = id;
    return true;
  }
  if (body.helperKey !== undefined) {
    return HELPER_ACTIONS_[body.action] === true && isValidHelperKey_(body.helperKey);
  }
  if (isRequireSessions_()) return false;
  return isValidAccessCode(body.accessCode);
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)
    .map(function (b) { var h = (b & 0xff).toString(16); return h.length < 2 ? '0' + h : h; }).join('');
}

function ensureSessionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Sessions')) return;
  var sheet = ss.insertSheet('Sessions');
  var headers = TABLE_DEFINITIONS['Sessions'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // keys/hashes look like numbers to Sheets sometimes; timestamps like dates
  sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
}

// ---- lockout (sign-in and Telegram /start only) ----
function loginLockState_() {
  var until = Number(CacheService.getScriptCache().get('loginlock') || 0);
  if (until > Date.now()) return { locked: true, minutesLeft: Math.max(1, Math.ceil((until - Date.now()) / 60000)) };
  return { locked: false, minutesLeft: 0 };
}

function lockMessage_(state) {
  return 'Too many wrong codes. Try again in ' + state.minutesLeft + ' minute' + (state.minutesLeft === 1 ? '' : 's') + '.';
}

function noteLoginFailure_() {
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  var got = lock.tryLock(500);
  try {
    var n = Number(cache.get('loginfail') || 0) + 1;
    cache.put('loginfail', String(n), LOGIN_LOCK_SECONDS_);
    if (n >= LOGIN_MAX_FAILURES_) cache.put('loginlock', String(Date.now() + LOGIN_LOCK_SECONDS_ * 1000), LOGIN_LOCK_SECONDS_);
  } finally {
    if (got) lock.releaseLock();
  }
}

function clearLoginFailures_() {
  CacheService.getScriptCache().remove('loginfail');
}

// ---- sessions ----
function loginWithCode_(payload) {
  var state = loginLockState_();
  if (state.locked) throw new Error(lockMessage_(state));
  if (!isValidAccessCode(String(payload.code || '').trim())) {
    noteLoginFailure_();
    recordFailedAccessAttempt_('sign-in');
    throw new Error('Wrong access code.');
  }
  clearLoginFailures_();
  return createSession_(payload.deviceName);
}

function idleCutoff_() {
  return Utilities.formatDate(new Date(Date.now() - SESSION_IDLE_DAYS_ * 86400000), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function createSession_(deviceName) {
  ensureSessionsSheet_();
  var cutoff = idleCutoff_();
  deleteRowsWhere_('Sessions', function (r) { return String(r.last_used_at) < cutoff; });   // tidy up forgotten devices

  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');   // 64 hex characters
  var hash = sha256Hex_(token);
  var id = Utilities.getUuid();
  var now = nowTimestamp_();
  appendRowObject('Sessions', {
    id: id, token_hash: hash,
    device_name: String(deviceName || '').trim().substring(0, 60) || 'Unnamed device',
    created_at: now, last_used_at: now
  });
  CacheService.getScriptCache().put('sess_' + hash, id, 3600);
  return { sessionToken: token, sessionId: id };
}

// '' when the key isn't a live session, otherwise the session's id. The
// Sessions sheet is read only when the answer isn't cached (about once an hour
// per device), which is also when last_used_at is refreshed.
function validateSession_(token) {
  if (!/^[0-9a-f]{64}$/.test(token)) return '';
  var hash = sha256Hex_(token);
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sess_' + hash);
  if (hit) return hit;
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions')) return '';
  var row = getAllRows('Sessions').find(function (r) { return String(r.token_hash) === hash; });
  if (!row) return '';
  if (String(row.last_used_at) < idleCutoff_()) {
    deleteRowsWhere_('Sessions', function (r) { return r.id === row.id; });
    return '';
  }
  updateRowFields_('Sessions', row.id, { last_used_at: nowTimestamp_() });
  cache.put('sess_' + hash, row.id, 3600);
  return row.id;
}

// Removes sessions matching `predicate` and kills their cached "valid" marker,
// so a signed-out key stops working at once, not when the cache expires.
function revokeSessionsWhere_(predicate) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions')) return 0;
  var doomed = getAllRows('Sessions').filter(predicate);
  var cache = CacheService.getScriptCache();
  var ids = {};
  doomed.forEach(function (r) { ids[r.id] = true; cache.remove('sess_' + r.token_hash); });
  if (doomed.length) deleteRowsWhere_('Sessions', function (r) { return ids[r.id]; });
  return doomed.length;
}

function logout() {
  if (CURRENT_SESSION_ID_) revokeSessionsWhere_(function (r) { return r.id === CURRENT_SESSION_ID_; });
  return { done: true };
}

function listSessions() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions')) return [];
  return getAllRows('Sessions')
    .map(function (r) {
      return { id: r.id, device_name: r.device_name, created_at: r.created_at, last_used_at: r.last_used_at, current: r.id === CURRENT_SESSION_ID_ };
    })
    .sort(function (a, b) { return a.last_used_at < b.last_used_at ? 1 : -1; });
}

function revokeSession(payload) {
  return { revoked: revokeSessionsWhere_(function (r) { return r.id === payload.id; }) };
}

function revokeOtherSessions() {
  return { revoked: revokeSessionsWhere_(function (r) { return r.id !== CURRENT_SESSION_ID_; }) };
}

// ---- sheet menu: the Mac helper's key, requiring sessions, signing everyone out ----
function menuGenerateHelperKey() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Generate a key for the Mac helper?',
    'The helper then uses its OWN key (good only for reading receipt photos) instead of your access code. If it already has one, the old key stops working. Continue?',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  var key = generateAccessCode_();
  PropertiesService.getScriptProperties().setProperty('HELPER_KEY', key);
  ui.alert('Your Mac helper key (shown only now). On the Mac, open ~/expense-tracker-ocr/config.json and add "helper_key": "' + key + '" — the helper then stops using access_code (you can remove that line afterwards).');
}

function menuRequireSessions() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  if (isRequireSessions_()) {
    var back = ui.alert('Sessions are REQUIRED right now.', 'Allow the raw access code again (the old way)? Signed-in devices keep working either way.', ui.ButtonSet.YES_NO);
    if (back === ui.Button.YES) { props.deleteProperty('REQUIRE_SESSIONS'); ui.alert('The raw access code is accepted again.'); }
    return;
  }
  var helperNote = props.getProperty('HELPER_KEY')
    ? ''
    : ' WARNING: the Mac helper still uses the access code — until you run menu item 25 and put its key in the helper\'s config.json, it will stop working.';
  var answer = ui.alert('Require sign-in sessions?',
    'From now on the app refuses the raw access code on every request; each device must sign in once (the app does it by itself the next time it is opened after the update). Anyone who only has the code can still try to sign in, but sign-in locks for 10 minutes after 10 wrong tries.' + helperNote + ' Continue?',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  props.setProperty('REQUIRE_SESSIONS', 'true');
  ui.alert('Done — sign-in sessions are now required.' + helperNote);
}

function menuSignOutAllDevices() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert('Sign out ALL devices?', 'Every device, including your phone, must sign in again with the access code. Use this if a phone is lost. Continue?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  var n = revokeSessionsWhere_(function () { return true; });
  ui.alert('Signed out ' + n + ' device' + (n === 1 ? '' : 's') + '.');
}
