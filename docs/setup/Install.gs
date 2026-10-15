/**
 * Install file for a NEW person's own copy of the backend (friends & family rollout, stage 4a).
 *
 * It is NOT part of backend/ (the owner's own backend never gets it): the installer page
 * (docs/setup/index.html) adds it to the new person's project, next to the real backend files,
 * and writes that project's appsscript.json itself so Google is asked for exactly the chosen
 * permissions. What it does:
 *
 *  - The first visit to the web app address is ONLY Google's permission approval; it answers at
 *    once with a "Continue" button. (Building the sheet used to happen here and left the person
 *    staring at a blank Google page for ~50 s.) The installer page then asks for the build with
 *    ?check=build and follows ?check=progress, so the person sees a real progress bar.
 *  - Applies the access code and the list of chosen extras that the installer wrote into the
 *    constants below (once per release): Script Properties ACCESS_CODE and FEATURES
 *    (backend/Features.gs; FEATURES present also makes e-mail reading use the read-only Gmail
 *    service, backend/GmailReader.gs).
 *  - Extras chosen at setup are approved on that same first visit: Google asks for a permission
 *    only when the code actually USES the service, so each chosen extra is touched here and its
 *    real timer is created (keep-awake ping: Triggers.gs pingWebApp_; bank e-mails: runAutomation).
 *  - Extras added LATER are approved on a side copy of the web app (?add=keepawake,gmail) so the
 *    person's app keeps working on the old version until Google's screen is done.
 * Running twice (Google sometimes loads the page twice) is harmless.
 */

var INSTALL_RELEASE = '__RELEASE__';    // replaced by the installer page on every push
var INSTALL_CODE = '__CODE__';          // the access code the installer made
var INSTALL_MAIN_URL = '__MAINURL__';   // this copy's own web address (for the keep-awake ping)
var INSTALL_FEATURES = '__FEATURES__';  // abilities approved so far, e.g. "base,keepawake,gmail"

var INSTALL_RETURN_PREFIXES_ = [
  'https://jeanpierreesr.github.io/expense-tracker/setup/',
  'http://localhost:4180/setup/'
];

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.check === 'ping') return installJson_({ ok: true });
  if (params.check === 'progress') return installJson_(installReadProgress_());
  if (params.check === 'build') { installApplyCode_(); return installJson_(installBuild_()); }

  var props = PropertiesService.getScriptProperties();
  var add = String(params.add || '');
  if (!add) installApplyCode_();   // a side-copy approval must not change the live settings early

  if (params.check === 'version') {
    return installJson_({
      release: INSTALL_RELEASE,
      setUp: props.getProperty('INSTALL_SETUP_DONE') === 'yes',
      codeFor: props.getProperty('INSTALL_CODE_SET_FOR') || '',
      features: props.getProperty('FEATURES') || '',
      keepAwake: installHasTrigger_('pingWebApp_'),
      scanning: installHasTrigger_('runAutomation')
    });
  }
  if (params.check === 'gmail') {
    try {
      if (typeof Gmail === 'undefined') return installJson_({ ok: false, error: 'email reading not turned on' });
      var res = Gmail.Users.Messages.list('me', { q: 'newer_than:7d', maxResults: 500 });
      return installJson_({ ok: true, count: (res.messages || []).length });
    } catch (err) {
      return installJson_({ ok: false, error: String(err && err.message || err) });
    }
  }

  // Extras: chosen at setup (INSTALL_FEATURES) or added later (?add=...). Each is touched here so Google
  // shows its permission now, then its real timer is created.
  var wanted = add ? add.split(',') : String(INSTALL_FEATURES || '').split(',');
  if (wanted.indexOf('keepawake') !== -1) installStartKeepAwake_();
  if (wanted.indexOf('gmail') !== -1) {
    var needGmail = installTouchGmail_();
    if (needGmail) return needGmail;
    installStartScanning_();
  }

  var back = String(params['return'] || '');
  var allowed = INSTALL_RETURN_PREFIXES_.some(function (p) { return back.indexOf(p) === 0; });
  var hash = add ? '#approved=extras' : '#done';
  var button = allowed
    ? '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1a7f5a;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
      installEsc_(back.split('#')[0] + hash) + '">Continue → / Continuar →</a></p>'
    : '<p>You can close this page. / Puedes cerrar esta página.</p>';
  return installPage_('Expense Tracker',
    '<p style="font-size:24px;margin:8px 0">✓ Allowed. / Permitido.</p>' +
    '<p>Tap the green button to go back. / Toca el botón verde para volver.</p>' + button);
}

// Touches Gmail (the mailbox profile: address + message total, no e-mail content) so Google asks for the
// read-only permission now. If Google still did not ask, returns a page with its official approval link.
function installTouchGmail_() {
  try {
    Gmail.Users.getProfile('me');
    return null;
  } catch (err) {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    if (info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED) {
      return installPage_('Expense Tracker',
        '<p>Google needs your approval to read email. / Google necesita tu aprobación para leer correos.</p>' +
        '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1f5fbf;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
        installEsc_(info.getAuthorizationUrl()) + '">Approve in Google / Aprobar en Google</a></p>' +
        '<p style="font-size:15px;color:#555">Then come back to the setup page — it notices by itself and continues. / Luego vuelve a la página de instalación: lo detecta sola y continúa.</p>');
    }
    throw err;
  }
}

// Keep-awake: the real 5-minute ping (Triggers.gs). It uses the outside-connection service, so Google's
// approval is triggered by one harmless call right now (the address may not be known yet at first setup).
function installStartKeepAwake_() {
  removeKeepWarmPingTriggers_();
  ScriptApp.newTrigger('pingWebApp_').timeBased().everyMinutes(5).create();
  try { UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true }); } catch (e) {}
}

// Bank e-mails: the real 15-minute automation (Triggers.gs runAutomation), minus its spreadsheet-menu alert.
function installStartScanning_() {
  removeAutomationTriggers_();
  ScriptApp.newTrigger('runAutomation').timeBased().everyMinutes(15).create();
}

function installHasTrigger_(handler) {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === handler; });
}

// Builds the sheet tabs + starter data. Writes "done/total" into the cache as it goes so the installer can
// show a progress bar. Safe to call twice: the second caller waits, then sees it done.
function installBuild_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('INSTALL_SETUP_DONE') === 'yes') return { ok: true, already: true };
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    if (props.getProperty('INSTALL_SETUP_DONE') === 'yes') return { ok: true, already: true };
    var started = Date.now();
    var cache = CacheService.getScriptCache();
    var tabs = Object.keys(TABLE_DEFINITIONS).length;
    var total = tabs + 5;
    cache.put('INSTALL_PROGRESS', '0/' + total, 900);
    setupSpreadsheet(function (done) { cache.put('INSTALL_PROGRESS', done + '/' + total, 900); });
    seedStarterData(function (done) { cache.put('INSTALL_PROGRESS', (tabs + done) + '/' + total, 900); });
    props.setProperty('INSTALL_SETUP_DONE', 'yes');
    cache.put('INSTALL_PROGRESS', total + '/' + total, 900);
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    lock.releaseLock();
  }
}

function installReadProgress_() {
  var props = PropertiesService.getScriptProperties();
  var raw = CacheService.getScriptCache().get('INSTALL_PROGRESS') || '';
  var m = raw.match(/^(\d+)\/(\d+)$/);
  return {
    setUp: props.getProperty('INSTALL_SETUP_DONE') === 'yes',
    done: m ? Number(m[1]) : 0,
    total: m ? Number(m[2]) : 0
  };
}

// Applies the access code and the extras written into this file, once per release.
function installApplyCode_() {
  var props = PropertiesService.getScriptProperties();
  if (!INSTALL_CODE || INSTALL_CODE.indexOf('__') === 0) return;
  if (props.getProperty('INSTALL_CODE_SET_FOR') === INSTALL_RELEASE) return;
  props.setProperty('ACCESS_CODE', INSTALL_CODE);
  if (INSTALL_FEATURES && INSTALL_FEATURES.indexOf('__') !== 0) props.setProperty('FEATURES', INSTALL_FEATURES);
  if (INSTALL_MAIN_URL && INSTALL_MAIN_URL.indexOf('__') !== 0) props.setProperty('WEB_APP_URL', INSTALL_MAIN_URL);
  props.setProperty('INSTALL_CODE_SET_FOR', INSTALL_RELEASE);
}

function installJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function installPage_(title, bodyHtml) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;line-height:1.45;font-size:18px">' +
    '<h2>' + installEsc_(title) + '</h2>' + bodyHtml + '</div>')
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function installEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
