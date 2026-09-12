/**
 * Phase 0 setup: creates one tab per table from the spec, with header rows
 * only. Safe to re-run — it will not touch a tab that already has headers.
 * Run setupSpreadsheet() once from the Apps Script editor, then delete the
 * default "Sheet1" tab by hand if it's still empty.
 */

var TABLE_DEFINITIONS = {
  Entries: ['id', 'type', 'date', 'amount', 'currency', 'category_id',
    'description', 'payment_method_id', 'paid_by', 'status', 'source',
    'external_id', 'import_batch_id'],
  'Entry Splits': ['id', 'entry_id', 'friend_id', 'amount'],
  Categories: ['id', 'name', 'type', 'icon', 'color', 'parent_id'],
  Tags: ['id', 'name', 'color'],
  'Entry Tags': ['entry_id', 'tag_id'],
  'Payment Methods': ['id', 'nickname', 'type', 'bank_id', 'last_4'],
  Banks: ['id', 'name'],
  'Exchange Rates': ['id', 'month', 'currency', 'rate'],
  Friends: ['id', 'name', 'notes'],
  Loans: ['id', 'friend_id', 'direction', 'origin', 'entry_id', 'amount',
    'currency', 'date', 'due_date', 'payment_method_id', 'description',
    'status'],
  Settlements: ['id', 'loan_id', 'date', 'amount', 'payment_method_id'],
  Budgets: ['id', 'category_id', 'amount', 'period_type', 'thresholds'],
  'Budget Alert Log': ['id', 'budget_id', 'threshold', 'period', 'sent_at'],
  'Period Templates': ['id', 'name', 'recurrence_rule', 'start_anchor'],
  'Import Batches': ['id', 'filename', 'date', 'row_count'],
  'Parsing Rules': ['id', 'bank_id', 'sender', 'pattern', 'field_mappings'],
  Settings: ['key', 'value']
};

function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(TABLE_DEFINITIONS).forEach(function (tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      sheet = ss.insertSheet(tabName);
    }

    var headers = TABLE_DEFINITIONS[tabName];
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    var firstRowValues = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
    var alreadyHasHeaders = firstRowValues.join('') !== '';

    if (!alreadyHasHeaders) {
      headerRange.setValues([headers]);
      headerRange.setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });

  Logger.log('Setup complete. Tabs created: ' + Object.keys(TABLE_DEFINITIONS).join(', '));
}
