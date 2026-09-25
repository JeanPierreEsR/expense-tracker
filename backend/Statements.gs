/**
 * Applying reviewed bank-statement results to the Sheet. The statement is
 * read and matched elsewhere (docs/statement-parsers.js, StatementMatch.gs);
 * this only writes what the owner has approved:
 *   - new entries (transfers between the owner's accounts, bank fees, …),
 *     created CONFIRMED with source 'import' — the owner approved each one
 *     in review — tied to one Import Batch so the whole run can be undone;
 *   - account assignments for existing entries that have none yet (the
 *     Spendee import left the payment method blank).
 * Idempotent: an entry whose external_id already exists is skipped, and an
 * assignment only fills a payment method that is still blank.
 *
 * payload: { dryRun (default TRUE), filename,
 *   entries: [{ type, date, amount, currency, category, description,
 *               from, to, external_id, status, merchant }],  // from/to = payment method nicknames;
 *                                               // status defaults to 'confirmed'; category may be '' (pending only)
 *   merchantUpdates: [{ entryId, merchant }],   // fills a blank `merchant` on an existing entry
 *   assignments: [{ entryId, account }] }      // account = payment method nickname
 */
function adminApplyStatementActions(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, entriesCreated: 0, entriesSkippedExisting: 0, assigned: 0, assignSkipped: [], batchId: null, errors: [] };

  var pmByNick = {};
  getAllRows('Payment Methods').forEach(function (p) { pmByNick[String(p.nickname).trim()] = p.id; });
  var catByName = {};
  getAllRows('Categories').forEach(function (c) { catByName[c.type + ':' + c.name] = c.id; });
  function pmId(nick) {
    if (!nick) return '';
    if (!pmByNick[nick]) throw new Error('Unknown payment method: ' + nick);
    return pmByNick[nick];
  }

  var existingExternal = {};
  getAllRows('Entries').forEach(function (e) { if (e.external_id) existingExternal[e.external_id] = true; });

  var batchId = Utilities.getUuid();
  var toCreate = [];
  (payload.entries || []).forEach(function (e) {
    if (e.external_id && existingExternal[e.external_id]) { report.entriesSkippedExisting++; return; }
    var catType = e.type === 'transfer' ? 'transfer' : 'expense';
    var categoryId = e.category ? catByName[catType + ':' + e.category] : '';
    if (e.category && !categoryId) throw new Error('Unknown ' + catType + ' category: ' + e.category);
    if (!e.category && e.status !== 'pending') throw new Error('A confirmed entry needs a category: ' + e.description);
    toCreate.push({
      id: Utilities.getUuid(), type: e.type, date: e.date, amount: Number(e.amount), currency: e.currency,
      category_id: categoryId, description: e.description || '',
      payment_method_id: pmId(e.from), to_payment_method_id: pmId(e.to),
      paid_by: 'me', status: e.status === 'pending' ? 'pending' : 'confirmed', source: 'import', external_id: e.external_id || '',
      import_batch_id: batchId, created_at: nowTimestamp_(), merchant: e.merchant || ''
    });
  });
  report.entriesCreated = toCreate.length;

  // Assignments: only entries still without an account.
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var idCol = headers.indexOf('id'), pmCol = headers.indexOf('payment_method_id'), toCol = headers.indexOf('to_payment_method_id');
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  var rowById = {};
  values.forEach(function (r, i) { rowById[r[idCol]] = i; });
  var pmColumn = values.map(function (r) { return [r[pmCol]]; });
  var toAssign = 0;
  (payload.assignments || []).forEach(function (a) {
    var i = rowById[a.entryId];
    if (i === undefined) { report.assignSkipped.push(a.entryId + ' (not found)'); return; }
    if (values[i][pmCol] || (toCol !== -1 && values[i][toCol])) { report.assignSkipped.push(a.entryId + ' (already has an account)'); return; }
    pmColumn[i][0] = pmId(a.account);
    toAssign++;
  });
  report.assigned = toAssign;

  // Merchant names for existing entries (blank only) — training data for
  // category guessing, taken from the statement's own merchant text.
  var merchCol = headers.indexOf('merchant');
  var merchColumn = values.map(function (r) { return [merchCol === -1 ? '' : r[merchCol]]; });
  var toMerchant = 0;
  (payload.merchantUpdates || []).forEach(function (m) {
    var i = rowById[m.entryId];
    if (i === undefined || merchCol === -1 || merchColumn[i][0] || !m.merchant) return;
    merchColumn[i][0] = m.merchant;
    toMerchant++;
  });
  report.merchantsSet = toMerchant;

  if (!dryRun) {
    if (toCreate.length) {
      ensureImportBatchRow_(batchId, payload.filename || 'statement-reconciliation', toCreate.length);
      toCreate.forEach(function (e) { appendRowObject('Entries', e); });
      report.batchId = batchId;
    }
    if (toAssign) sheet.getRange(2, pmCol + 1, pmColumn.length, 1).setValues(pmColumn);
    if (toMerchant) sheet.getRange(2, merchCol + 1, merchColumn.length, 1).setValues(merchColumn);
  }
  return report;
}

function ensureImportBatchRow_(batchId, filename, count) {
  appendRowObject('Import Batches', {
    id: batchId, filename: filename,
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    row_count: count
  });
}

/** Undoes one import batch: deletes its entries and its batch row. */
function adminUndoImportBatch(payload) {
  var id = payload.batchId;
  if (!id) throw new Error('batchId required');
  var before = getAllRows('Entries').filter(function (e) { return e.import_batch_id === id; }).length;
  deleteRowsWhere_('Entries', function (row) { return row.import_batch_id === id; });
  deleteRowsWhere_('Import Batches', function (row) { return row.id === id; });
  return { deletedEntries: before };
}
