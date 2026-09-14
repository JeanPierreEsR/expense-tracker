/**
 * Scheduled automation: reads Gmail for new transactions and checks
 * Telegram for replies/button-taps, on one combined timer.
 */

function runAutomation() {
  processEmails();
  pollTelegramUpdates();
  checkBudgets();
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

function runAutomationNow() {
  var results = processEmails();
  pollTelegramUpdates();
  var budgetResults = checkBudgets();
  SpreadsheetApp.getUi().alert(
    'Done. Created ' + results.created + ', skipped ' + results.skipped +
    ', duplicates ' + results.duplicates + '. Budget alerts sent: ' + budgetResults.alertsSent + '.'
  );
}
