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

// Columns that hold a date but must stay plain text (YYYY-MM-DD / YYYY-MM),
// otherwise Sheets silently converts them to its own Date type and every
// string comparison in the API (>=, substring, etc.) breaks.
var DATE_LIKE_COLUMNS = {
  Entries: ['date'],
  Loans: ['date', 'due_date'],
  Settlements: ['date'],
  'Exchange Rates': ['month'],
  'Budget Alert Log': ['period', 'sent_at'],
  'Import Batches': ['date']
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

    var dateCols = DATE_LIKE_COLUMNS[tabName];
    if (dateCols) {
      dateCols.forEach(function (colName) {
        var colIndex = headers.indexOf(colName) + 1;
        if (colIndex > 0) {
          sheet.getRange(1, colIndex, sheet.getMaxRows(), 1).setNumberFormat('@');
        }
      });
    }
  });

  Logger.log('Setup complete. Tabs created: ' + Object.keys(TABLE_DEFINITIONS).join(', '));
}

/**
 * Fills empty tabs with sensible starting values (categories, banks,
 * friends, settings). Safe to re-run — skips any tab that already has
 * rows beyond the header.
 */
function seedStarterData() {
  seedCategories();
  seedBanks();
  seedFriends();
  seedSettings();
  Logger.log('Starter data seeded.');
}

function seedIfEmpty(sheetName, rows) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error('Run "1. Build sheet tabs" first — missing sheet: ' + sheetName);
  if (sheet.getLastRow() > 1) return;

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = rows.map(function (row) {
    return headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; });
  });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function seedCategories() {
  var cats = [];
  function addCats(names, type) {
    names.forEach(function (name) {
      cats.push({ id: Utilities.getUuid(), name: name, type: type, icon: '', color: '', parent_id: '' });
    });
  }

  addCats(['Food & Dining', 'Groceries', 'Transport', 'Housing', 'Utilities',
    'Health', 'Entertainment', 'Shopping', 'Education', 'Travel', 'Gifts',
    'Other'], 'expense');
  addCats(['Salary', 'Freelance', 'Gifts Received', 'Other Income'], 'income');
  addCats(['Contribution', 'Withdrawal'], 'investment');
  addCats(['Between Accounts'], 'transfer');

  seedIfEmpty('Categories', cats);
}

function seedBanks() {
  var names = ['BCP', 'Interbank', 'BBVA', 'Scotiabank', 'Banco de la Nación'];
  seedIfEmpty('Banks', names.map(function (name) {
    return { id: Utilities.getUuid(), name: name };
  }));
}

function seedFriends() {
  var names = ['Ana', 'Ben Ray', 'Eva Ray'];
  seedIfEmpty('Friends', names.map(function (name) {
    return { id: Utilities.getUuid(), name: name, notes: '' };
  }));
}

function seedSettings() {
  seedIfEmpty('Settings', [
    { key: 'default_currency', value: 'PEN' },
    { key: 'alert_thresholds', value: '50,80,100' },
    { key: 'notification_channel', value: '' },
    { key: 'notification_target', value: '' }
  ]);
}
