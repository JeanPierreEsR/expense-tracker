/**
 * Payors — who paid the owner for an income entry (a client, employer,
 * "Nexus Group," etc.). Kept deliberately separate from Friends: a friend
 * paying for a shared expense is an owner-centric debt (see Loans in
 * CLAUDE.md), but an income payor isn't a debt relationship at all, and
 * mixing the two lists would put company/client names next to the
 * owner's actual friends for no reason. Income entries' `paid_by` holds a
 * payor id here instead of a friend id/"me" — see docs/app.js's
 * populatePaidByOptions_, which switches lists based on the entry's type.
 */

// This table was added after setupSpreadsheet() was last run for real —
// self-heals its own tab on first use, same reasoning and pattern as
// ensureRecurringExpensesSheet_. Seeds "Nexus Group" at creation time so
// there's at least one real option to pick without a manual setup step.
function ensurePayorsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Payors')) return;
  var sheet = ss.insertSheet('Payors');
  var headers = TABLE_DEFINITIONS['Payors'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.appendRow([Utilities.getUuid(), 'Nexus Group', '']);
}

function getPayorRows_() {
  ensurePayorsSheet_();
  return getAllRows('Payors');
}

function listPayors() {
  return getPayorRows_().sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function addPayor(payload) {
  ensurePayorsSheet_();
  var payor = { id: Utilities.getUuid(), name: payload.name, notes: payload.notes || '' };
  appendRowObject('Payors', payor);
  return payor;
}
