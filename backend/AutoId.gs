/**
 * The whole point of this app is that data stays editable by hand in the
 * Sheet — but every row needs a unique `id` for the API to work with it.
 * This file makes that automatic: whenever someone fills in a row by hand
 * without an id, one gets generated for it.
 */

var ID_TABLES = ['Entries', 'Entry Splits', 'Categories', 'Tags',
  'Payment Methods', 'Banks', 'Exchange Rates', 'Friends', 'Loans',
  'Settlements', 'Budgets', 'Budget Alert Log', 'Period Templates',
  'Import Batches', 'Parsing Rules'];

// Simple trigger — fires automatically on every manual edit to the Sheet.
function onEdit(e) {
  try {
    var range = e.range;
    var sheet = range.getSheet();
    if (ID_TABLES.indexOf(sheet.getName()) === -1) return;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf('id');
    if (idCol < 0) return;

    var startRow = range.getRow();
    var numRows = range.getNumRows();

    for (var r = startRow; r < startRow + numRows; r++) {
      if (r === 1) continue;
      var idCell = sheet.getRange(r, idCol + 1);
      if (idCell.getValue()) continue;

      var rowValues = sheet.getRange(r, 1, 1, headers.length).getValues()[0];
      var hasOtherContent = rowValues.some(function (v, i) { return i !== idCol && v !== ''; });
      if (hasOtherContent) {
        idCell.setValue(Utilities.getUuid());
      }
    }
  } catch (err) {
    // Simple triggers can't show UI on failure — fail silently rather than
    // breaking the user's manual edit.
  }
}

/**
 * One-time cleanup for rows added by hand before the onEdit trigger above
 * existed. Safe to re-run — only fills genuinely blank id cells.
 */
function backfillMissingIds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var totalFilled = 0;

  ID_TABLES.forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) return;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf('id');
    if (idCol < 0) return;

    var range = sheet.getRange(2, idCol + 1, lastRow - 1, 1);
    var values = range.getValues();
    var changed = false;
    for (var i = 0; i < values.length; i++) {
      if (!values[i][0]) {
        values[i][0] = Utilities.getUuid();
        changed = true;
        totalFilled++;
      }
    }
    if (changed) range.setValues(values);
  });

  Logger.log('Backfilled ' + totalFilled + ' missing id(s).');
}
