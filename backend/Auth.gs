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
