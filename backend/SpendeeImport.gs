/**
 * One-time bulk import of the owner's full Spendee transaction history
 * (2020-2026, ~6,900 rows). Not a general CSV importer (that's Phase 6) —
 * this is specifically shaped for Spendee's export format. Runs as a
 * single server-side operation with one bulk sheet write, since thousands
 * of individual appendRow calls would be far too slow.
 *
 * Dedup strategy: only entries already in the Sheet before this import can
 * collide with it (a handful of manually/email-entered rows for
 * transactions that happened to also be in this export). Rather than
 * fuzzy-matching descriptions (which differ slightly between what was
 * typed by hand and what Spendee recorded), match on
 * (date after converting to Lima time, amount, type) — precise enough for
 * the small set of already-existing entries, without risking a false
 * "duplicate" skip across 6,900 genuinely distinct historical rows.
 */
function bulkImportSpendeeCsv(csvText, filename) {
  var lines = Utilities.parseCsv(csvText);
  var header = lines[0];
  var idx = {};
  header.forEach(function (h, i) { idx[h.trim()] = i; });

  var categories = getAllRows('Categories');
  function findCategoryId(name, type) {
    var n = String(name || '').trim().toLowerCase();
    var cat = categories.find(function (c) { return c.type === type && c.name.toLowerCase() === n; });
    return cat ? cat.id : null;
  }
  var otherExpenseId = findCategoryId('Other', 'expense');
  var otherIncomeId = findCategoryId('Other', 'income');

  var existingKeys = {};
  getAllRows('Entries').forEach(function (e) {
    existingKeys[e.date + '|' + Number(e.amount).toFixed(2) + '|' + e.type] = true;
  });

  var tz = Session.getScriptTimeZone();
  var batchId = Utilities.getUuid();
  var newRows = [];
  var skippedDup = 0, skippedBad = 0;
  var unmatchedCategories = {};

  for (var i = 1; i < lines.length; i++) {
    var row = lines[i];
    if (!row || row.length < 6) { skippedBad++; continue; }

    var typeRaw = row[idx['Type']];
    if (typeRaw !== 'Expense' && typeRaw !== 'Income') { skippedBad++; continue; }
    var type = typeRaw === 'Expense' ? 'expense' : 'income';

    var d = new Date(row[idx['Date']]);
    if (isNaN(d.getTime())) { skippedBad++; continue; }
    var dateStr = Utilities.formatDate(d, tz, 'yyyy-MM-dd');

    var amount = Math.abs(parseFloat(row[idx['Amount']]));
    if (!amount || isNaN(amount)) { skippedBad++; continue; }

    var key = dateStr + '|' + amount.toFixed(2) + '|' + type;
    if (existingKeys[key]) { skippedDup++; continue; }
    existingKeys[key] = true; // also guards against dup rows within the CSV itself

    var catName = row[idx['Category name']];
    var categoryId = findCategoryId(catName, type);
    if (!categoryId) {
      categoryId = type === 'expense' ? otherExpenseId : otherIncomeId;
      unmatchedCategories[catName] = (unmatchedCategories[catName] || 0) + 1;
    }

    newRows.push({
      id: Utilities.getUuid(),
      type: type,
      date: dateStr,
      amount: amount,
      currency: row[idx['Currency']] || 'PEN',
      category_id: categoryId || '',
      description: (row[idx['Note']] || '').trim(),
      payment_method_id: '',
      paid_by: 'me',
      status: 'confirmed',
      source: 'import',
      external_id: '',
      import_batch_id: batchId
    });
  }

  if (newRows.length) {
    var sheet = getSheet('Entries');
    var entryHeaders = getHeaders(sheet);
    var values = newRows.map(function (e) {
      return entryHeaders.map(function (h) { return e[h] !== undefined ? e[h] : ''; });
    });
    var startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, values.length, entryHeaders.length).setValues(values);

    appendRowObject('Import Batches', {
      id: batchId,
      filename: filename || 'spendee-import.csv',
      date: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
      row_count: newRows.length
    });
  }

  return {
    imported: newRows.length,
    skippedDuplicates: skippedDup,
    skippedBad: skippedBad,
    unmatchedCategories: unmatchedCategories,
    batchId: batchId
  };
}
