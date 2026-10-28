/**
 * Scheduled automation: reads Gmail for new transactions and checks
 * Telegram for replies/button-taps, on one combined timer.
 */

function runAutomation() {
  // Keep-warm ping, folded in here (2026-09-27) so it starts working the
  // moment this file is pushed, with no menu click needed — see
  // pingWebApp_'s own comment below for what/why. This trigger (IF
  // already enabled via menu item 12) already runs every 15 minutes, so
  // this rides along for free; the dedicated 5-minute ping (menu item 19)
  // is still there too, for finer-grained warming when it's convenient to
  // turn on. If automatic scanning was never enabled, this line never
  // runs either — check via menu item 12/13's wording, or the Apps
  // Script project's Triggers page, to confirm one of the two is active.
  AUTOMATION_RUN_ = { at: new Date().toISOString(), t0: Date.now(), steps: {} };
  runAutomationStep_('ping', [], pingWebApp_);
  var failures = [];
  // Each ability that needs an optional Google approval runs only if it was given (Features.gs).
  // The scan is skipped when the app (or an earlier run) scanned a moment ago — see scanEmailsGuarded_.
  var scan = featureOn_('gmail') ? runAutomationStep_('emails', failures, function () { return scanEmailsGuarded_('timer'); }) : null;
  var emailResults = scan && scan.ran ? scan.results : null;
  runAutomationStep_('telegram', failures, pollTelegramUpdates);
  // The slower housekeeping (budget alerts, trip budgets, loan reminders, investment categories) takes 15-25 s a run and
  // changes little within 15 minutes, so it runs about once an hour; e-mail, Telegram and the statement inbox stay every run.
  if (heavyStepsDue_()) {
    runAutomationStep_('budgets', failures, checkBudgets);
    runAutomationStep_('trip budgets', failures, checkTripBudgets);
    runAutomationStep_('loan reminders', failures, checkOverdueLoans);
    runAutomationStep_('investment categories', failures, backfillInvestmentCategories_);
  }
  if (featureOn_('gmail')) runAutomationStep_('statement inbox', failures, function () { scanStatementInbox_(); retryStatementInboxNudges_(); });
  else runAutomationStep_('statement inbox', failures, retryStatementInboxNudges_);

  if (emailResults && (emailResults.unparsed || emailResults.errors)) {
    failures.push('emails: ' + emailResults.unparsed + ' could not be read'
      + (emailResults.errors ? ', ' + emailResults.errors + ' errored (will retry)' : '')
      + (emailResults.unparsedSubjects.length ? ' — e.g. "' + emailResults.unparsedSubjects[0] + '"' : ''));
  }
  recordAutomationTimings_();
  if (failures.length) alertAutomationFailures_(failures);
  else PropertiesService.getScriptProperties().setProperty('LAST_AUTOMATION_OK', new Date().toISOString());
}

// ---- The hourly part of the timer ----
// True when the heavy steps should run now: the last time they ran was HEAVY_STEPS_GAP_MS_ ago or more (or never). The gap is a
// little under an hour so the 15-minute timer's small start-time jitter never pushes it to every 75 minutes. The time is noted
// BEFORE they run, so a crash or a failure waits for the next hour instead of repeating every 15 minutes (failures are reported).
var HEAVY_STEPS_LAST_KEY_ = 'HEAVY_STEPS_LAST_AT';
var HEAVY_STEPS_GAP_MS_ = 50 * 60 * 1000;
function heavyStepsDue_() {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty(HEAVY_STEPS_LAST_KEY_) || 0);
  if (last && Date.now() - last < HEAVY_STEPS_GAP_MS_) return false;
  props.setProperty(HEAVY_STEPS_LAST_KEY_, String(Date.now()));
  return true;
}

// ---- How long each part of a run takes (read with the owner-only route admin_automationTimings) ----
// A run is often 20-160 s and once hit the 6-minute limit; this says which step is slow. The last 24 runs are kept in one
// Script Property (small: step name -> milliseconds), and each run is also written to the log.
var AUTOMATION_RUN_ = null;
var AUTOMATION_TIMINGS_KEY_ = 'AUTOMATION_TIMINGS';
function recordAutomationTimings_() {
  var run = AUTOMATION_RUN_;
  AUTOMATION_RUN_ = null;
  if (!run) return;
  try {
    run.total = Date.now() - run.t0;
    delete run.t0;
    Logger.log('automation timings: ' + JSON.stringify(run));
    var props = PropertiesService.getScriptProperties();
    var list = [];
    try { list = JSON.parse(props.getProperty(AUTOMATION_TIMINGS_KEY_) || '[]'); } catch (e) { list = []; }
    list.push(run);
    props.setProperty(AUTOMATION_TIMINGS_KEY_, JSON.stringify(list.slice(-24)));
  } catch (err) {
    console.error('automation timings: ' + err);   // never let measuring break a run
  }
}
function getAutomationTimings_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(AUTOMATION_TIMINGS_KEY_) || '[]'); } catch (e) { return []; }
}

// ---- Checking e-mail when the app is opened (and by the timer) ----
// The timer looks every 15 minutes, so a new bank e-mail could wait that long. The app now also asks for a check each time
// it is opened or brought back (checkEmailsNow), at most one per minute. The scan does NOT hold the script-wide lock while it
// reads mail (that would block people's saves for up to a minute): a short claim marker keeps two scans apart instead, and
// processEmails itself never writes the same e-mail twice (external_id).
var EMAIL_SCAN_RUNNING_KEY_ = 'EMAIL_SCAN_RUNNING_AT';
var EMAIL_SCAN_LAST_KEY_ = 'EMAIL_SCAN_LAST_AT';
var EMAIL_SCAN_APP_GAP_MS_ = 60 * 1000;      // the app may ask again after a minute
var EMAIL_SCAN_TIMER_GAP_MS_ = 120 * 1000;   // the timer skips if anything scanned in the last 2 minutes (saves its run time)
var EMAIL_SCAN_STALE_MS_ = 7 * 60 * 1000;    // a marker older than a run's 6-minute limit is a crashed scan

// source: 'app' or 'timer'. Returns { ran: false, reason: 'off'|'recent'|'busy' } or { ran: true, results }.
function scanEmailsGuarded_(source) {
  if (!featureOn_('gmail')) return { ran: false, reason: 'off' };
  var props = PropertiesService.getScriptProperties();
  var gap = source === 'app' ? EMAIL_SCAN_APP_GAP_MS_ : EMAIL_SCAN_TIMER_GAP_MS_;
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = Date.now();
    var running = Number(props.getProperty(EMAIL_SCAN_RUNNING_KEY_) || 0);
    if (running && now - running < EMAIL_SCAN_STALE_MS_) return { ran: false, reason: 'busy' };
    if (now - Number(props.getProperty(EMAIL_SCAN_LAST_KEY_) || 0) < gap) return { ran: false, reason: 'recent' };
    // A claim marker still there after a run's 6 minutes means the last scan was cut off before it could write anything down.
    if (running) recordEmailScanFailed_('time');
    props.setProperty(EMAIL_SCAN_RUNNING_KEY_, String(now));
  } finally {
    lock.releaseLock();
  }
  try {
    var results = processEmails();
    props.setProperty(EMAIL_SCAN_LAST_KEY_, String(Date.now()));
    recordEmailScanDone_(results);   // EmailHealth.gs: what the app shows as "last checked" and warns from
    return { ran: true, results: results };
  } catch (err) {
    recordEmailScanFailed_(err);
    throw err;
  } finally {
    props.deleteProperty(EMAIL_SCAN_RUNNING_KEY_);
  }
}

// The app's "look for new bank e-mails now" call. Never an error for the person: a skipped check just says why.
// It always carries `health` (EmailHealth.gs) so the app can refresh "last checked" and its warning with what just happened.
function checkEmailsNow() {
  var scan;
  try {
    scan = scanEmailsGuarded_('app');
  } catch (err) {
    return { ran: false, reason: 'failed', health: emailHealthForApp_(true) };   // already recorded; never an error for the person
  }
  if (scan.ran) return { ran: true, created: scan.results.created || 0, health: emailHealthForApp_(true) };
  var skipped = { ran: false, reason: scan.reason };
  if (scan.reason !== 'off') skipped.health = emailHealthForApp_(true);   // e-mail reading off: there is nothing to report
  return skipped;
}

// Runs one automation step so a failure in it can't stop the later ones.
// Failures are collected and reported (see alertAutomationFailures_)
// instead of vanishing into the Apps Script log.
function runAutomationStep_(name, failures, fn) {
  var t0 = Date.now();
  try {
    return fn();
  } catch (e) {
    console.error('automation step "' + name + '": ' + e);
    failures.push(name + ': ' + (e && e.message ? e.message : e));
    return null;
  } finally {
    if (AUTOMATION_RUN_) AUTOMATION_RUN_.steps[name] = Date.now() - t0;
  }
}

// Tells the owner on Telegram, at most once every 6 hours so a problem
// that persists doesn't send a message every 15 minutes.
function alertAutomationFailures_(failures) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_AUTOMATION_ALERT') || 0);
  if (Date.now() - last < 6 * 3600 * 1000) return;
  props.setProperty('LAST_AUTOMATION_ALERT', String(Date.now()));
  var lastOk = props.getProperty('LAST_AUTOMATION_OK');
  try {
    sendTelegramText_(tr_('notice.autoProblem', { list: failures.join('\n• '), last: lastOk || tr_('notice.unknown') }));
  } catch (e) { console.error('automation alert failed: ' + e); }
}

function enableAutomaticScanning() {
  removeAutomationTriggers_();
  ScriptApp.newTrigger('runAutomation')
    .timeBased()
    .everyMinutes(15)
    .create();
  SpreadsheetApp.getUi().alert('Automatic scanning enabled — checking every 15 minutes.');
}

function disableAutomaticScanning() {
  removeAutomationTriggers_();
  SpreadsheetApp.getUi().alert('Automatic scanning disabled.');
}

function removeAutomationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runAutomation') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ---- Keep-warm ping ----
// The app is used only a few times a day with idle gaps between — real
// measurement (More → Performance log, see CHANGELOG.md § Architecture,
// "Performance instrumentation") showed doPost runs on a freshly-started
// script instance on essentially every single real request, adding
// several extra seconds on top of the actual work every time the owner
// opens the app. runAutomation (above) does NOT help with this — it's a
// time-driven trigger, a different execution path from the Web App's
// HTTP-served doPost, so it never touches that container. This instead
// makes an actual HTTP call to the same live Web App URL the phone calls,
// which is the only way to influence that specific execution path. A
// `ping` request is answered before the access-code check (see doPost in
// Api.gs) — instant, and needs no secret here. Best-effort only: whether
// Apps Script actually reuses the resulting warm instance for the next
// real request isn't documented or guaranteed, so this is judged by the
// performance log's "cold" count over time, not assumed to fully work.
function pingWebApp_() {
  var url = getWebAppUrl_();
  if (!url || !featureOn_('keepawake')) return;   // not known yet / not approved: nothing to ping
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ ping: true }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // Best-effort — a failed ping just means the next real request pays
    // the usual cold-start cost, same as before this existed.
  }
  // This timer is the one most copies have (the "open faster" extra), so it also looks at the alerts (Notices.gs § Checking alerts when the
  // app is used), at most about once an hour. Inside runAutomation (which has its own hourly alert steps) and on a copy where that job runs,
  // it stays out so nothing is checked twice.
  if (!AUTOMATION_RUN_ && !featureOn_('gmail')) {
    try { checkAlertsGuarded_('timer'); } catch (err) { console.error('ping alerts: ' + err); }
  }
}

function enableKeepWarmPing() {
  removeKeepWarmPingTriggers_();
  ScriptApp.newTrigger('pingWebApp_')
    .timeBased()
    .everyMinutes(5)
    .create();
  alertIfUiAvailable_('Keep-warm ping enabled — pinging the app every 5 minutes.');
}

function disableKeepWarmPing() {
  removeKeepWarmPingTriggers_();
  alertIfUiAvailable_('Keep-warm ping disabled.');
}

// SpreadsheetApp.getUi() only works when a menu item was clicked from the
// open Sheet — running the same function directly from the Apps Script
// editor's ▶ Run button (a valid way to trigger it, and the one that
// surfaces the one-time permission prompt) has no UI to alert, and throws
// if asked for one. The trigger itself is already created/removed by the
// time this runs either way, so a run from the editor still works — this
// just avoids that call showing as a confusing error in the execution log.
function alertIfUiAvailable_(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (err) {
    Logger.log(message);
  }
}

function removeKeepWarmPingTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pingWebApp_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function runAutomationNow() {
  var results = featureOn_('gmail') ? processEmails() : { created: 0, skipped: 0, duplicates: 0 };
  pollTelegramUpdates();
  var budgetResults = checkBudgets();
  var loanResults = checkOverdueLoans();
  SpreadsheetApp.getUi().alert(
    'Done. Created ' + results.created + ', skipped ' + results.skipped +
    ', duplicates ' + results.duplicates + '. Budget alerts sent: ' + budgetResults.alertsSent +
    '. Overdue loan alerts sent: ' + loanResults.alertsSent + '.'
  );
}
