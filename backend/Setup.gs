/**
 * Phase 0 setup: creates one tab per table from the spec, with header rows
 * only. Safe to re-run — it will not touch a tab that already has headers.
 * Run setupSpreadsheet() once from the Apps Script editor, then delete the
 * default "Sheet1" tab by hand if it's still empty.
 */

var TABLE_DEFINITIONS = {
  Entries: ['id', 'type', 'date', 'amount', 'currency', 'category_id',
    'description', 'payment_method_id', 'paid_by', 'status', 'source',
    'external_id', 'import_batch_id', 'created_at'],
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
  Budgets: ['id', 'category_id', 'amount', 'currency', 'period_type', 'thresholds'],
  'Budget Alert Log': ['id', 'budget_id', 'threshold', 'period', 'sent_at'],
  'Period Templates': ['id', 'name', 'recurrence_rule', 'start_anchor'],
  'Import Batches': ['id', 'filename', 'date', 'row_count'],
  'Parsing Rules': ['id', 'bank_id', 'sender', 'pattern', 'field_mappings'],
  Settings: ['key', 'value'],
  // Not part of the original spec — needed to know which entry a Telegram
  // reply is about, since Telegram only tells us which message_id someone
  // replied to.
  'Telegram Messages': ['message_id', 'entry_id', 'created_at'],
  // Not part of the original spec — default-category guessing for
  // auto-captured expenses (see EmailParser.gs guessCategoryId_). Grows on
  // its own: confirming a pending email-sourced entry with a category
  // remembers that description for next time. category_name (not
  // category_id) so this stays easy to edit by hand in the Sheet.
  'Category Keywords': ['id', 'keyword', 'category_name']
};

// Columns that hold a date but must stay plain text (YYYY-MM-DD / YYYY-MM),
// otherwise Sheets silently converts them to its own Date type and every
// string comparison in the API (>=, substring, etc.) breaks.
var DATE_LIKE_COLUMNS = {
  Entries: ['date', 'created_at'],
  Loans: ['date', 'due_date'],
  Settlements: ['date'],
  'Exchange Rates': ['month'],
  'Budget Alert Log': ['period', 'sent_at'],
  'Import Batches': ['date']
};

// One-time migration for the Entries sheet from before `created_at`
// existed — setupSpreadsheet() only writes headers to a brand-new tab, so
// a sheet that already has headers never picks up a newly added column on
// its own. Safe to call more than once.
function addCreatedAtColumnToEntries() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Entries');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('created_at') !== -1) return { done: true, alreadyExisted: true };

  var col = headers.length + 1;
  sheet.getRange(1, col).setValue('created_at').setFontWeight('bold');
  sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
  return { done: true, alreadyExisted: false, column: col };
}

// Same idea as addCreatedAtColumnToEntries, for Budgets picking up a
// `currency` column (Phase 4) after the tab was already created empty
// with the Phase-0 header set.
function addCurrencyColumnToBudgets() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Budgets');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf('currency') !== -1) return { done: true, alreadyExisted: true };

  var col = headers.length + 1;
  sheet.getRange(1, col).setValue('currency').setFontWeight('bold');
  return { done: true, alreadyExisted: false, column: col };
}

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
  seedCategoryKeywords();
  Logger.log('Starter data seeded.');
}

// A few confident starting points, based on merchants already seen in
// real sample emails. Keep this list short — a wrong guess is worse than
// no guess, since it'd need noticing and correcting. It grows on its own
// from here (see learnCategoryKeyword_ in Telegram.gs).
function seedCategoryKeywords() {
  seedIfEmpty('Category Keywords', [
    { id: Utilities.getUuid(), keyword: 'rappi', category_name: 'Food & Drink' },
    { id: Utilities.getUuid(), keyword: 'plaza vea', category_name: 'Groceries' },
    { id: Utilities.getUuid(), keyword: 'claro', category_name: 'Mobile Phone' }
  ]);
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

var CATEGORY_COLOR_PALETTE = ['#F7C6D9', '#C9E4F7', '#FFE0B2', '#D9F2D9',
  '#E0D9F7', '#FFF3B0', '#F7D9C4', '#D9F7F0'];

// Matches the owner's real category lists (from their previous tracking
// app), with one emoji icon per category so the entry screen can show a
// tappable icon grid instead of a dropdown. Investment/Transfer don't have
// icon sets yet and keep the plain dropdown.
var EXPENSE_CATEGORIES = [
  ['Annual budget', '📅'], ['Car', '🚗'], ['Travel', '✈️'],
  ['Food & Drink', '🍽️'], ['Family & Personal', '👪'], ['Entertainment', '🎭'],
  ['Home', '🏠'], ['Shopping', '🛍️'], ['Healthcare', '🏥'], ['Other', '📦'],
  ['Transport', '🚌'], ['Groceries', '🛒'], ['Education', '🎓'],
  ['Gifts', '🎁'], ['Work', '💼'], ['Savings', '💰'], ['Loan', '🏦'],
  ['Party', '🎉'], ['Mobile Phone', '📱'], ['Donations', '🤲'],
  ['Credit card', '💳'], ['Gym', '🏋️'], ['AELU', '🏟️'],
  ['Psychologist', '🧠'], ['AI', '🤖']
];

var INCOME_CATEGORIES = [
  ['Other', '📦'], ['Gifts', '🎁'], ['Business', '👔'], ['Salary', '💰'],
  ['Insurance Payout', '🛡️'], ['Parental Leave', '👶'], ['Loan', '🏦'],
  ['Extra Income', '💵'], ['Savings return', '🪙'], ['Sales', '🏷️']
];

function seedCategories() {
  var cats = [];
  function addCatsWithIcons(list, type) {
    list.forEach(function (c, i) {
      cats.push({
        id: Utilities.getUuid(), name: c[0], type: type, icon: c[1],
        color: CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length], parent_id: ''
      });
    });
  }
  function addCats(names, type) {
    names.forEach(function (name) {
      cats.push({ id: Utilities.getUuid(), name: name, type: type, icon: '', color: '', parent_id: '' });
    });
  }

  addCatsWithIcons(EXPENSE_CATEGORIES, 'expense');
  addCatsWithIcons(INCOME_CATEGORIES, 'income');
  addCats(['Contribution', 'Withdrawal'], 'investment');
  addCats(['Between Accounts'], 'transfer');

  seedIfEmpty('Categories', cats);
}

/**
 * Replaces whatever categories of the given type currently exist with the
 * given (name, icon) list, assigning colors from the shared palette.
 * Categories of every other type are left untouched.
 */
function resetCategoriesForType(type, list) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Categories');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var typeIdx = headers.indexOf('type');
  var lastRow = sheet.getLastRow();
  var data = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];

  var keep = data.filter(function (row) { return row[typeIdx] !== type; });

  var newRows = list.map(function (c, i) {
    return [Utilities.getUuid(), c[0], type, c[1],
      CATEGORY_COLOR_PALETTE[i % CATEGORY_COLOR_PALETTE.length], ''];
  });

  var allRows = keep.concat(newRows);

  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }
  if (allRows.length) {
    sheet.getRange(2, 1, allRows.length, headers.length).setValues(allRows);
  }
  Logger.log(type + ' categories reset: ' + newRows.length + ' categories, ' + keep.length + ' other rows kept.');
}

function resetExpenseCategories() {
  resetCategoriesForType('expense', EXPENSE_CATEGORIES);
}

function resetIncomeCategories() {
  resetCategoriesForType('income', INCOME_CATEGORIES);
}

var BANK_NAMES = ['BCP', 'Interbank', 'Diners', 'SIP', 'Yape', 'Plin'];

function seedBanks() {
  seedIfEmpty('Banks', BANK_NAMES.map(function (name) {
    return { id: Utilities.getUuid(), name: name };
  }));
}

/**
 * Replaces the Banks list with the real set the owner actually uses. Safe
 * to run any time — nothing currently references a Bank by id, since
 * Payment Methods' bank_id was never populated during Phase 1.
 */
function resetBanks() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Banks');
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
  var rows = BANK_NAMES.map(function (name) { return [Utilities.getUuid(), name]; });
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  Logger.log('Banks reset: ' + BANK_NAMES.join(', '));
}

/**
 * Matches each existing Payment Method's nickname to a Bank by name and
 * fills in bank_id — needed for Phase 2 email parsing to match a
 * transaction to the right payment method by bank + last_4.
 */
function linkPaymentMethodsToBanks() {
  var banks = getAllRows('Banks');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Payment Methods');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var nicknameCol = headers.indexOf('nickname');
  var bankIdCol = headers.indexOf('bank_id');
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var linked = 0;

  rows.forEach(function (row, i) {
    if (row[bankIdCol]) return;
    var nickname = String(row[nicknameCol]).toLowerCase();
    var match = banks.find(function (b) { return nickname.indexOf(String(b.name).toLowerCase()) !== -1; });
    if (match) {
      sheet.getRange(2 + i, bankIdCol + 1).setValue(match.id);
      linked++;
    }
  });
  Logger.log('Linked ' + linked + ' payment method(s) to a bank.');
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
