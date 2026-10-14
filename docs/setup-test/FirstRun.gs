/**
 * PROTOTYPE ONLY — not part of the real backend (it lives in docs/setup-test/,
 * not backend/). The test setup page adds this file to a NEW person's own copy
 * of the backend (and writes that copy's appsscript.json itself, to control
 * exactly which Google permissions are asked for at each step):
 *
 *  - Step 1 ("base"): only "this spreadsheet". The first visit to the web app
 *    link is ONLY the permission approval — it answers at once with a
 *    "Continue" button (it used to build the sheet while the person stared at a
 *    blank Google page for ~50 s). The setup page then asks for the build with
 *    ?check=build and follows it with ?check=progress, so the person sees a
 *    real progress bar. Applies the access code the setup page wrote into
 *    PROTO_NEW_CODE.
 *  - "keepawake": adds "run while you're away" + "connect to an external
 *    service"; the approval visit (?stage=keepawake) starts a 5-minute timer
 *    that pings the main web app, like the real keep-warm ping.
 *  - "gmail": adds read-only Gmail; ?check=gmail only COUNTS the emails of the
 *    last 7 days (it never opens one).
 * Running twice (Google sometimes loads the page twice) is harmless.
 */

var PROTO_RELEASE = '__RELEASE__';   // replaced by the setup page on every push
var PROTO_NEW_CODE = '__CODE__';     // the access code the setup page made
var PROTO_MAIN_URL = '__MAINURL__';  // the main web app address (for the keep-awake ping)

var PROTO_RETURN_PREFIXES_ = [
  'https://jeanpierreesr.github.io/expense-tracker/setup-test/',
  'http://localhost:4180/setup-test/'
];

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (params.check === 'ping') return protoJson_({ ok: true });
  if (params.check === 'progress') return protoJson_(protoReadProgress_());
  if (params.check === 'build') { protoApplyCode_(); return protoJson_(protoBuild_()); }

  var props = PropertiesService.getScriptProperties();
  protoApplyCode_();

  if (params.check === 'version') {
    return protoJson_({
      release: PROTO_RELEASE,
      setUp: props.getProperty('PROTO_SETUP_DONE') === 'yes',
      codeFor: props.getProperty('PROTO_CODE_SET_FOR') || '',
      keepAwake: props.getProperty('PROTO_KEEPAWAKE_ON') === 'yes',
      heartbeat: props.getProperty('PROTO_HEARTBEAT') || ''
    });
  }
  if (params.check === 'gmail') {
    try {
      if (typeof Gmail === 'undefined') return protoJson_({ ok: false, error: 'email reading not turned on' });
      var res = Gmail.Users.Messages.list('me', { q: 'newer_than:7d', maxResults: 500 });
      return protoJson_({ ok: true, count: (res.messages || []).length });
    } catch (err) {
      return protoJson_({ ok: false, error: String(err && err.message || err) });
    }
  }

  var stage = String(params.stage || '');
  if (stage === 'keepawake') protoStartKeepAwake_();
  if (stage === 'gmail') {
    // Google only asks for a new permission when the code actually USES it, so
    // touch Gmail here (the mailbox profile: address + message total, no email
    // content). If Google still didn't ask, offer its official approval link.
    try {
      Gmail.Users.getProfile('me');
    } catch (err) {
      var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
      if (info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED) {
        return protoPage_('Expense Tracker',
          '<p>Google needs your approval to read email. / Google necesita tu aprobación para leer correos.</p>' +
          '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1f5fbf;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
          protoEsc_(info.getAuthorizationUrl()) + '">Approve in Google / Aprobar en Google</a></p>' +
          '<p style="font-size:15px;color:#555">Then come back to the setup page — it notices by itself and continues. / Luego vuelve a la página de instalación: lo detecta sola y continúa.</p>');
      }
      throw err;
    }
  }

  var back = String(params['return'] || '');
  var allowed = PROTO_RETURN_PREFIXES_.some(function (p) { return back.indexOf(p) === 0; });
  var hash = stage ? '#approved=' + encodeURIComponent(stage) : '#done';
  var button = allowed
    ? '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1a7f5a;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
      protoEsc_(back.split('#')[0] + hash) + '">Continue → / Continuar →</a></p>'
    : '<p>You can close this page. / Puedes cerrar esta página.</p>';
  return protoPage_('Expense Tracker',
    '<p style="font-size:24px;margin:8px 0">✓ ' + 'Allowed. / Permitido.' + '</p>' +
    '<p>Tap the green button to go back. / Toca el botón verde para volver.</p>' + button);
}

// Builds the sheet tabs + starter data (what step 2 used to do on Google's blank
// page). Writes "done/total" into the cache as it goes so the setup page can show
// a progress bar. Safe to call twice: the second caller waits, then sees it done.
function protoBuild_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PROTO_SETUP_DONE') === 'yes') return { ok: true, already: true };
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    if (props.getProperty('PROTO_SETUP_DONE') === 'yes') return { ok: true, already: true };
    var started = Date.now();
    var cache = CacheService.getScriptCache();
    var tabs = Object.keys(TABLE_DEFINITIONS).length;
    var total = tabs + 5;
    cache.put('PROTO_PROGRESS', '0/' + total, 900);
    setupSpreadsheet(function (done) { cache.put('PROTO_PROGRESS', done + '/' + total, 900); });
    seedStarterData(function (done) { cache.put('PROTO_PROGRESS', (tabs + done) + '/' + total, 900); });
    props.setProperty('PROTO_SETUP_DONE', 'yes');
    cache.put('PROTO_PROGRESS', total + '/' + total, 900);
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000) };
  } finally {
    lock.releaseLock();
  }
}

function protoReadProgress_() {
  var props = PropertiesService.getScriptProperties();
  var raw = CacheService.getScriptCache().get('PROTO_PROGRESS') || '';
  var m = raw.match(/^(\d+)\/(\d+)$/);
  return {
    setUp: props.getProperty('PROTO_SETUP_DONE') === 'yes',
    done: m ? Number(m[1]) : 0,
    total: m ? Number(m[2]) : 0
  };
}

// Applies the access code the setup page wrote into this file, once per release.
function protoApplyCode_() {
  var props = PropertiesService.getScriptProperties();
  if (!PROTO_NEW_CODE || PROTO_NEW_CODE.indexOf('__') === 0) return;
  if (props.getProperty('PROTO_CODE_SET_FOR') === PROTO_RELEASE) return;
  props.setProperty('ACCESS_CODE', PROTO_NEW_CODE);
  props.setProperty('PROTO_CODE_SET_FOR', PROTO_RELEASE);
}

function protoStartKeepAwake_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'protoPing') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('protoPing').timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().setProperty('PROTO_KEEPAWAKE_ON', 'yes');
  protoPing();
}

// The keep-awake timer: pings the main web app (like the real keep-warm ping)
// and notes when it last ran.
function protoPing() {
  if (PROTO_MAIN_URL && PROTO_MAIN_URL.indexOf('__') !== 0) {
    try { UrlFetchApp.fetch(PROTO_MAIN_URL + '?check=ping', { muteHttpExceptions: true }); } catch (e) {}
  }
  PropertiesService.getScriptProperties().setProperty('PROTO_HEARTBEAT', new Date().toISOString());
}

function protoJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function protoPage_(title, bodyHtml) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;line-height:1.45;font-size:18px">' +
    '<h2>' + protoEsc_(title) + '</h2>' + bodyHtml + '</div>')
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function protoEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
