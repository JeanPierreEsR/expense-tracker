/**
 * PROTOTYPE ONLY — not part of the real backend (it lives in docs/setup-test/,
 * not backend/). The test setup page adds this file to a NEW person's own copy
 * of the backend (and writes that copy's appsscript.json itself, to control
 * exactly which Google permissions are asked for at each step):
 *
 *  - Step 1 ("base"): only "this spreadsheet". The first visit to the web app
 *    link asks for that approval, then builds the sheet tabs + starter data and
 *    applies the access code the setup page wrote into PROTO_NEW_CODE.
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

  var seconds = null;
  if (props.getProperty('PROTO_SETUP_DONE') !== 'yes') {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (props.getProperty('PROTO_SETUP_DONE') !== 'yes') {
        var started = Date.now();
        setupSpreadsheet();
        seedStarterData();
        props.setProperty('PROTO_SETUP_DONE', 'yes');
        seconds = Math.round((Date.now() - started) / 1000);
      }
    } finally {
      lock.releaseLock();
    }
  }

  var stage = String(params.stage || '');
  if (stage === 'keepawake') protoStartKeepAwake_();

  var back = String(params['return'] || '');
  var allowed = PROTO_RETURN_PREFIXES_.some(function (p) { return back.indexOf(p) === 0; });
  var hash = stage ? '#approved=' + encodeURIComponent(stage) : '#done' + (seconds !== null ? '&secs=' + seconds : '');
  var button = allowed
    ? '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1a7f5a;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
      protoEsc_(back.split('#')[0] + hash) + '">Continue → / Continuar →</a></p>'
    : '<p>You can close this page. / Puedes cerrar esta página.</p>';
  return protoPage_('Expense Tracker', '<p>✓</p>' + button);
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
