/**
 * "Split a bill by items", step 2 — the bill behind a split expense is kept
 * with the entry so its items can be edited later. One row per entry in the
 * "Entry Bills" tab (entry_id, bill_json, updated_at): the phone sends the
 * items / who shared each / discounts / tip as one JSON document and gets it
 * back untouched when the entry is reopened. The server never interprets it —
 * the amounts that matter (the entry's amount and Entry Splits) are saved the
 * normal way, so a bill that has gone stale can't corrupt any money figure.
 *
 * Not an entry "child sheet" for change tracking (DataVersion.gs): the entry
 * list never carries the bill, the phone fetches it on demand.
 */

var ENTRY_BILL_MAX_CHARS_ = 40000;   // a Google Sheets cell holds 50,000

function ensureEntryBillsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Entry Bills')) return;
  var sheet = ss.insertSheet('Entry Bills');
  var headers = TABLE_DEFINITIONS['Entry Bills'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function entryBillsSheetExists_() {
  return !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Entry Bills');
}

// {bill: <the saved document>|null}
function getEntryBill(payload) {
  var entryId = payload && payload.entryId;
  if (!entryId) throw new Error('entryId is required');
  if (!entryBillsSheetExists_()) return { bill: null };
  var row = getAllRows('Entry Bills').filter(function (r) { return r.entry_id === entryId; })[0];
  if (!row) return { bill: null };
  try {
    return { bill: JSON.parse(row.bill_json), updated_at: row.updated_at };
  } catch (err) {
    return { bill: null };   // unreadable by hand-edit: behave as "no saved bill"
  }
}

// Replaces this entry's bill (bill = null removes it) — same
// recalculate-from-scratch idea as saveEntrySplits / saveEntryTags, so
// retrying a save is always safe.
function saveEntryBill(payload) {
  var entryId = payload && payload.entryId;
  if (!entryId) throw new Error('entryId is required');
  var bill = payload.bill;
  if (bill === null || bill === undefined) {
    deleteEntryBill_(entryId);
    return { bill: null };
  }
  if (typeof bill !== 'object' || Array.isArray(bill) || bill.v !== 1 || !Array.isArray(bill.items)) {
    throw new Error('That bill is not in a format this app can store.');
  }
  var entry = getEntryById_(entryId);
  if (!entry) throw new Error('Entry not found');
  if (entry.type !== 'expense') throw new Error('Only an expense can have a bill.');
  var json = JSON.stringify(bill);
  if (json.length > ENTRY_BILL_MAX_CHARS_) throw new Error('That bill is too large to store.');

  ensureEntryBillsSheet_();
  deleteRowsWhere_('Entry Bills', function (row) { return row.entry_id === entryId; });
  appendRowObject('Entry Bills', { entry_id: entryId, bill_json: json, updated_at: nowStamp_() });
  return { bill: bill };
}

// Quietly does nothing when the tab was never created (no bill ever saved).
function deleteEntryBill_(entryId) {
  if (!entryBillsSheetExists_()) return;
  deleteRowsWhere_('Entry Bills', function (row) { return row.entry_id === entryId; });
}
