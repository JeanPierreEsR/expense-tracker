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
      PropertiesService.getScriptProperties().setProperty('ACCESS_CODE', code);
      ui.alert('Access code saved.');
    }
  }
}

function isValidAccessCode(code) {
  var stored = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE');
  return !!stored && code === stored;
}
