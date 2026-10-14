/**
 * PROTOTYPE ONLY — not part of the real backend (it lives in docs/setup-test/,
 * not backend/). The test setup page adds this file to a NEW person's own copy
 * of the backend, to find out whether a one-tap install works:
 *
 *  - The first visit to the web app link (by the person, signed in to their own
 *    Google account) makes Google ask them to approve the backend's
 *    permissions; then doGet builds the sheet tabs, adds starter data, makes an
 *    access code and installs one harmless hourly timer, and sends them back to
 *    the setup page with the code.
 *  - ?check=version answers which test release is installed (to prove updates
 *    arrive) and when the hourly timer last ran.
 *
 * Nothing here scans Gmail or talks to Telegram.
 */

var PROTO_RELEASE = '__RELEASE__';   // replaced by the setup page on every install/update

// Where the access code may be sent back to (anything else gets the code shown
// on screen instead, so it can't be redirected to a stranger's page).
var PROTO_RETURN_PREFIXES_ = [
  'https://jeanpierreesr.github.io/expense-tracker/setup-test/',
  'http://localhost:4180/setup-test/'
];

function doGet(e) {
  var params = (e && e.parameter) || {};
  var props = PropertiesService.getScriptProperties();

  if (params.check === 'version') {
    return protoJson_({
      release: PROTO_RELEASE,
      setUp: props.getProperty('PROTO_SETUP_DONE') === 'yes',
      heartbeat: props.getProperty('PROTO_HEARTBEAT') || ''
    });
  }

  if (props.getProperty('PROTO_SETUP_DONE') === 'yes') {
    return protoPage_('Already set up',
      '<p>This tracker is already set up. You can close this page and go back to the setup page.</p>');
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props.getProperty('PROTO_SETUP_DONE') === 'yes') {
      return protoPage_('Already set up', '<p>This tracker is already set up.</p>');
    }
    var started = Date.now();
    setupSpreadsheet();
    seedStarterData();
    var code = generateAccessCode_();
    props.setProperty('ACCESS_CODE', code);

    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'protoHeartbeat') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('protoHeartbeat').timeBased().everyHours(1).create();
    protoHeartbeat();

    props.setProperty('PROTO_SETUP_DONE', 'yes');
    var seconds = Math.round((Date.now() - started) / 1000);

    var back = String(params['return'] || '');
    var allowed = PROTO_RETURN_PREFIXES_.some(function (p) { return back.indexOf(p) === 0; });
    var link = allowed
      ? '<p><a target="_top" style="display:inline-block;padding:14px 20px;background:#1a7f5a;color:#fff;border-radius:10px;text-decoration:none;font-weight:600" href="' +
        protoEsc_(back.split('#')[0] + '#code=' + code + '&secs=' + seconds) + '">Continue setup →</a></p>'
      : '';
    return protoPage_('Your tracker is ready',
      '<p>Everything was created in your own Google account (' + seconds + ' s).</p>' + link +
      '<p style="color:#666;font-size:14px">If the button doesn\'t work, copy this access code into the setup page:</p>' +
      '<p style="font-family:monospace;font-size:15px;word-break:break-all;background:#f3f3f3;padding:10px;border-radius:8px">' + code + '</p>');
  } finally {
    lock.releaseLock();
  }
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
