/**
 * Edits typed straight into the Entries tab of the Sheet keep loans and repayments in step (owner's request, 2026-10-28).
 *
 * Google Sheets is the backend, but the rules that keep a loan and its money entry (or a repayment's two entries) agreeing are
 * code: they run when the APP or the Telegram bot edits. Typing in a cell runs none of it, so the Entries row used to change
 * while the Loans / Settlements rows kept the old values. An INSTALLABLE edit trigger closes that: Google runs
 * `onEntriesSheetEdit_` after every manual edit (it never runs for the script's own writes, so there are no loops).
 *
 * Same rules as the app and Telegram, with what a cell edit can do:
 *  - a loan's money entry: date / amount / currency / account / description go to the loan (`syncLoanBeforeEntryEdit_`); if
 *    the loan refuses (below what is repaid, another currency once repaid…) the entry is put back FROM THE LOAN and a notice
 *    says why;
 *  - a repayment's two entries: a new date / account follows to the other entry and the rows (`syncRepaymentAfterEntryEdit_`);
 *    a new amount is put back (single-cell edits know the old value) with a notice pointing to the app;
 *  - anything else: untouched.
 * A notice is a Sheets toast (a trigger cannot open a dialog).
 */

var ENTRIES_EDIT_TRIGGER_FN_ = 'onEntriesSheetEdit_';
var ENTRIES_EDIT_TRIGGER_FLAG_ = 'ENTRIES_EDIT_TRIGGER';
var ENTRIES_EDIT_SHARED_ = ['date', 'amount', 'currency', 'payment_method_id', 'description'];

// Installs the trigger once per copy. Called when the app opens (getMeta); a failure never breaks that request and is simply
// tried again next time. The flag stops it from looking at the trigger list on every open.
function ensureEntriesEditTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(ENTRIES_EDIT_TRIGGER_FLAG_) === '1') return;
  try {
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === ENTRIES_EDIT_TRIGGER_FN_; });
    if (!has) {
      ScriptApp.newTrigger(ENTRIES_EDIT_TRIGGER_FN_).forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onEdit().create();
    }
    props.setProperty(ENTRIES_EDIT_TRIGGER_FLAG_, '1');
  } catch (err) {
    console.error('entries edit trigger: ' + err);
  }
}

// The trigger's entry point. Never throws: a failure must not disturb the person's edit.
function onEntriesSheetEdit_(e) {
  try {
    handleEntriesSheetEdit_(e);
  } catch (err) {
    console.error('entries edit sync: ' + err);
  }
}

function handleEntriesSheetEdit_(e) {
  if (!e || !e.range) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== 'Entries') return;
  var headers = getHeaders(sheet);
  var firstCol = range.getColumn();
  var lastCol = firstCol + range.getNumColumns() - 1;
  var touched = [];
  headers.forEach(function (h, i) {
    if (i + 1 >= firstCol && i + 1 <= lastCol && ENTRIES_EDIT_SHARED_.indexOf(h) !== -1) touched.push(h);
  });
  if (!touched.length) return;
  var idCol = headers.indexOf('id');
  if (idCol < 0) return;
  var firstRow = Math.max(range.getRow(), 2);   // the header row is not an entry
  var lastRow = range.getRow() + range.getNumRows() - 1;
  // Only a single-cell edit tells us the old value (e.oldValue), so only then can an amount be put back by value.
  var single = range.getNumRows() === 1 && range.getNumColumns() === 1 ? { column: touched[0], oldValue: e.oldValue } : null;
  var notes = [];
  for (var r = firstRow; r <= lastRow; r++) {
    var id = sheet.getRange(r, idCol + 1).getValue();
    if (!id) continue;   // a row typed by hand that has no id yet: nothing can hang on it
    var note = syncManualEntryEdit_(String(id), touched, single);
    if (note) notes.push(note);
  }
  if (notes.length) editSyncNotice_(notes.join(' '));
}

// Returns '' (nothing to say) or the notice text. `touched` = the shared columns the edit covered.
function syncManualEntryEdit_(entryId, touched, single) {
  var entry = getEntryById_(entryId);
  if (!entry) return '';
  ensureLoansTransferEntryColumn_();
  var loan = getAllRows('Loans').find(function (l) { return l.transfer_entry_id === entryId; });
  if (loan) {
    var fields = {};
    ENTRIES_EDIT_SHARED_.forEach(function (k) { fields[k] = entry[k]; });
    try {
      syncLoanBeforeEntryEdit_(entryId, fields);
      return '';
    } catch (err) {
      // The loan said no. It did not change, so it is the truth: write its values back onto the entry.
      var friend = getAllRows('Friends').find(function (f) { return f.id === loan.friend_id; });
      syncLoanTransferEntry_(loan, friend ? friend.name : tr_('label.unknownFriend'));
      return tr_('sheet.loanRefused', { error: err.message });
    }
  }
  if (forgivenessOfEntry_(entryId) && (touched.indexOf('amount') !== -1 || touched.indexOf('currency') !== -1)) {
    // What was forgiven is not editable on its entry: put back by value when ONE cell was edited, else ask to check.
    var col = single && single.column;
    var was = single && single.oldValue !== undefined ? String(single.oldValue).replace(/,/g, '') : '';
    if ((col === 'amount' || col === 'currency') && was !== '') {
      setEntryField_(entryId, col, col === 'amount' ? Number(was) : was);
      return tr_('sheet.forgivenessLocked');
    }
    return tr_('sheet.forgivenessCheck');
  }
  var link = repaymentOfEntry_(entryId);
  if (!link) return '';
  var notes = [];
  if (touched.indexOf('amount') !== -1) {
    var old = single && single.column === 'amount' && single.oldValue !== undefined ? Number(String(single.oldValue).replace(/,/g, '')) : NaN;
    if (!isNaN(old)) {
      setEntryField_(entryId, 'amount', old);   // an amount of a repayment is changed in the app's repayment editor
      notes.push(tr_('sheet.repaymentAmount'));
    } else {
      notes.push(tr_('sheet.repaymentAmountCheck'));   // several cells at once: the old value is not known
    }
  }
  var change = {};
  if (touched.indexOf('date') !== -1) change.date = entry.date;
  if (touched.indexOf('payment_method_id') !== -1) change.payment_method_id = entry.payment_method_id || '';
  if (Object.keys(change).length) syncRepaymentAfterEntryEdit_(entryId, change);
  return notes.join(' ');
}

// A trigger cannot open a dialog; a Sheets toast is the notice. Never throws.
function editSyncNotice_(text) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(text, tr_('sheet.toastTitle'), 12);
  } catch (err) {
    console.error('edit sync notice: ' + err);
  }
}
