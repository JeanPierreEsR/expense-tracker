/**
 * Remembered layouts of spreadsheet statements (CSV / Excel files — see docs/statement-table.js).
 *
 * A bank's or an app's export always has the same columns, so once the person has confirmed which column is which, the next
 * file with the same header words needs no questions. The memory lives in the person's own Sheet (tab "Statement Formats"),
 * not on the phone, so a second device or a reinstall knows it too. One row per layout:
 *
 *   signature     the header words (normalized) the phone computed — what "the same layout" means
 *   label         the tag the person (or the app) gave it, e.g. "Spendee export", "My other bank"
 *   mapping_json  which column holds the date / description / amount / category / account…, date order, decimal mark, sign
 *   accounts_json for files that hold several accounts (Spendee's "Wallet"): the value in that column -> payment method id
 *
 * Only the column positions, the header words and the person's own tag are stored — never a line of a statement.
 */

var STATEMENT_FORMATS_SHEET_ = 'Statement Formats';
var STATEMENT_FORMATS_HEADERS_ = ['id', 'signature', 'label', 'mapping_json', 'accounts_json', 'uses', 'created_at', 'updated_at'];
var STATEMENT_FORMAT_MAX_JSON_ = 6000;

function ensureStatementFormatsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STATEMENT_FORMATS_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(STATEMENT_FORMATS_SHEET_);
  var header = sheet.getRange(1, 1, 1, STATEMENT_FORMATS_HEADERS_.length);
  header.setValues([STATEMENT_FORMATS_HEADERS_]);
  header.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Plain text, so nothing a header says is ever read as a date, a number or a formula.
  sheet.getRange(1, 1, sheet.getMaxRows(), STATEMENT_FORMATS_HEADERS_.length).setNumberFormat('@');
  return sheet;
}

function statementFormatRow_(signature) {
  return getAllRows(STATEMENT_FORMATS_SHEET_).filter(function (r) { return r.signature === signature; })[0] || null;
}

function parseJsonSafe_(text, fallback) {
  try { var v = JSON.parse(text); return v && typeof v === 'object' ? v : fallback; } catch (e) { return fallback; }
}

/** payload: { signature }. Reply: { found: false } or { found: true, label, mapping, accounts, uses }. */
function getStatementFormat(payload) {
  var signature = String((payload && payload.signature) || '');
  if (!signature) return { found: false };
  ensureStatementFormatsSheet_();
  var row = statementFormatRow_(signature);
  if (!row) return { found: false };
  // An account that was deleted since is simply forgotten, so the person is asked again for that value.
  var pmIds = {};
  getAllRows('Payment Methods').forEach(function (pm) { pmIds[pm.id] = true; });
  var accounts = parseJsonSafe_(row.accounts_json, {});
  Object.keys(accounts).forEach(function (k) { if (!pmIds[accounts[k]]) delete accounts[k]; });
  return { found: true, label: row.label || '', mapping: parseJsonSafe_(row.mapping_json, {}), accounts: accounts, uses: Number(row.uses) || 0 };
}

/**
 * payload: { signature, label, mapping, accounts }. Creates the layout or updates it (same signature), counting one more use.
 * Reply: { saved: true, label }.
 */
function saveStatementFormat(payload) {
  var signature = String((payload && payload.signature) || '').slice(0, 400);
  if (!signature) throw new Error(tr_('sf.noSignature'));
  var mapping = JSON.stringify(payload.mapping || {});
  var accounts = JSON.stringify(payload.accounts || {});
  if (mapping.length > STATEMENT_FORMAT_MAX_JSON_ || accounts.length > STATEMENT_FORMAT_MAX_JSON_) throw new Error(tr_('sf.tooBig'));
  var label = String(payload.label || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  var sheet = ensureStatementFormatsSheet_();
  var now = nowTimestamp_();
  var row = statementFormatRow_(signature);
  if (row) {
    var headers = getHeaders(sheet);
    var idx = findRowIndexById(sheet, headers, row.id);
    var fields = { label: label || row.label || '', mapping_json: mapping, accounts_json: accounts, uses: (Number(row.uses) || 0) + 1, updated_at: now };
    Object.keys(fields).forEach(function (f) { setCellByRow_(sheet, headers, idx, f, fields[f]); });
    return { saved: true, label: fields.label };
  }
  appendRowObject(STATEMENT_FORMATS_SHEET_, { id: Utilities.getUuid(), signature: signature, label: label, mapping_json: mapping,
    accounts_json: accounts, uses: 1, created_at: now, updated_at: now });
  return { saved: true, label: label };
}

/** payload: { signature }. The person told the app to forget a layout; the next file with it is asked about again. */
function deleteStatementFormat(payload) {
  var signature = String((payload && payload.signature) || '');
  if (!signature) return { deleted: 0 };
  ensureStatementFormatsSheet_();
  var before = getAllRows(STATEMENT_FORMATS_SHEET_).length;
  deleteRowsWhere_(STATEMENT_FORMATS_SHEET_, function (r) { return r.signature === signature; });
  return { deleted: before - getAllRows(STATEMENT_FORMATS_SHEET_).length };
}
