/**
 * PROTOTYPE ONLY — not part of the real backend (it lives in docs/setup-test/,
 * not backend/). The test setup page adds this file to a NEW person's own copy
 * of the backend, to find out whether a one-tap install works:
 *
 *  - The setup page makes the access code itself and writes it into this file
 *    (PROTO_NEW_CODE), so the code never has to travel back through a link.
 *    The file lives only in the person's own Google account.
 *  - The first visit to the web app link (by the person, signed in) makes Google
 *    ask them to approve the backend's permissions; then doGet builds the sheet
 *    tabs, adds starter data, applies the access code and installs one harmless
 *    hourly timer, and offers a button back to the setup page. Running twice
 *    (Google sometimes loads the page twice right after approval) is harmless.
 *  - ?check=version says which test release is installed (to prove updates
 *    arrive), applies a newly sent code, and when the hourly timer last ran.
 *
 * Nothing here scans Gmail or talks to Telegram.
 */

var PROTO_RELEASE = '__RELEASE__';   // replaced by the setup page on every install/update
var PROTO_NEW_CODE = '__CODE__';     // the access code the setup page made

// Where the "Continue setup" button may point (never anywhere else).
var PROTO_RETURN_PREFIXES_ = [
  'https://jeanpierreesr.github.io/expense-tracker/setup-test/',
  'http://localhost:4180/setup-test/'
];

function doGet(e) {
  var params = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties();
  protoApplyCode_();

  if (params.check === 'version') {
    return protoJson_({
      release: PROTO_RELEASE,
      setUp: props.getProperty('PROTO_SETUP_DONE') === 'yes',
      codeFor: props.getProperty('PROTO_CODE_SET_FOR') || '',
      heartbeat: props.getProperty('PROTO_HEARTBEAT') || ''
    });
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
        ScriptApp.getProjectTriggers().forEach(function (t) {
          if (t.getHandlerFunction() === 'protoHeartbeat') ScriptApp.deleteTrigger(t);
        });
        ScriptApp.newTrigger('protoHeartbeat').timeBased().everyHours(1).create();
        protoHeartbeat();
        props.setProperty('PROTO_SETUP_DONE', 'yes');
        seconds = Math.round((Date.now() - started) / 1000);
      }
    } finally {
      lock.releaseLock();
    }
  }

  var back = String(params['return'] || '');
  var allowed = PROTO_RETURN_PREFIXES_.some(function (p) { return back.indexOf(p) === 0; });
  var button = allowed
    ? '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1a7f5a;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
      protoEsc_(back.split('#')[0] + '#done' + (seconds !== null ? '&secs=' + seconds : '')) + '">Continue setup →</a></p>'
    : '<p>You can close this page and go back to the setup page.</p>';
  return protoPage_('Your tracker is ready',
    '<p>Everything is set up in your own Google account' + (seconds !== null ? ' (' + seconds + ' s)' : '') + '.</p>' + button);
}

// Applies the access code the setup page wrote into this file, once per release.
function protoApplyCode_() {
  var props = PropertiesService.getScriptProperties();
  if (!PROTO_NEW_CODE || PROTO_NEW_CODE.indexOf('__') === 0) return;
  if (props.getProperty('PROTO_CODE_SET_FOR') === PROTO_RELEASE) return;
  props.setProperty('ACCESS_CODE', PROTO_NEW_CODE);
  props.setProperty('PROTO_CODE_SET_FOR', PROTO_RELEASE);
}

// The harmless hourly timer: only records when it last ran.
function protoHeartbeat() {
  PropertiesService.getScriptProperties().setProperty('PROTO_HEARTBEAT', new Date().toISOString());
}

function protoJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function protoPage_(title, bodyHtml) {
  return HtmlService.createHtmlOutput(
    '<div style="font-family:-apple-system,Helvetica,sans-serif;max-width:520px;margin:24px auto;padding:0 16px;line-height:1.45">' +
    '<h2>' + protoEsc_(title) + '</h2>' + bodyHtml + '</div>')
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function protoEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
