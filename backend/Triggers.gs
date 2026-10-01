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
  pingWebApp_();
  processEmails();
  pollTelegramUpdates();
  checkBudgets();
  checkOverdueLoans();
  try { backfillInvestmentCategories_(); } catch (e) { console.error('investment categories: ' + e); }
  try { scanStatementInbox_(); retryStatementInboxNudges_(); } catch (e) { console.error('statement inbox: ' + e); }
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
  try {
    UrlFetchApp.fetch(WEB_APP_URL, {
      method: 'post',
      contentType: 'text/plain',
      payload: JSON.stringify({ ping: true }),
      muteHttpExceptions: true
    });
  } catch (err) {
    // Best-effort — a failed ping just means the next real request pays
    // the usual cold-start cost, same as before this existed.
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
  var results = processEmails();
  pollTelegramUpdates();
  var budgetResults = checkBudgets();
  var loanResults = checkOverdueLoans();
  SpreadsheetApp.getUi().alert(
    'Done. Created ' + results.created + ', skipped ' + results.skipped +
    ', duplicates ' + results.duplicates + '. Budget alerts sent: ' + budgetResults.alertsSent +
    '. Overdue loan alerts sent: ' + loanResults.alertsSent + '.'
  );
}
