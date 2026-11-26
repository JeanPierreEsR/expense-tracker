/**
 * Detracciones (owner's plan "Plan: préstamo con cuotas desde el "+", detracciones y contratos de obra", piece 2, 2026-11-26).
 * Company copies only. When a client pays a company, SUNAT's SPOT makes them keep a part (4% on construction contracts, 12% on services)
 * and deposit it in the company's Banco de la Nación account, which only pays taxes.
 *
 * The income is the WHOLE invoice (what the client paid: the unit, the expected payment and IGV all count it), into the bank account as
 * usual; the part kept is `detraction_amount` on that income, and the app keeps ONE linked transfer (`detraction_of` = the income's id)
 * from that bank account to the account "Banco de la Nación (detracciones)", made the first time it is needed. So the bank shows what
 * really arrived (total − detraction) and the Banco de la Nación account holds the rest. Never income twice, never an expense.
 *
 * Soles only for now: the deposit is always in soles, and an invoice in dollars would need the day's rate.
 */
var DETRACTION_DEFAULT_RATE_ = 4;
var DETRACTION_ACCOUNT_SETTING_ = 'detraction_account_id';

// The detraction a save asks for, cleaned: only a company copy's confirmed-or-waiting income in soles with a company, a positive number
// smaller than the amount; blank means none.
function cleanDetraction_(entry, raw) {
  if (raw === '' || raw === null || raw === undefined) return '';
  if (!isCompanyCopy_() || !entry || entry.type !== 'income' || !entry.company_id) return '';
  if (String(entry.currency || '').toUpperCase() !== 'PEN') return '';
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= Math.abs(Number(entry.amount))) throw new Error(tr_('detr.tooBig'));
  return round2_(n);
}

function ensureDetractionColumns_() {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  ['detraction_amount', 'detraction_of'].forEach(function (h) {
    if (headers.indexOf(h) === -1) { sheet.getRange(1, headers.length + 1).setValue(h); headers.push(h); }
  });
  if (ROWS_MEMO_) { delete ROWS_MEMO_['Entries']; delete ROWS_MEMO_['@h:Entries']; }
}

function detractionColumnsExist_() {
  return getHeaders(getSheet('Entries')).indexOf('detraction_of') !== -1;
}

// The Banco de la Nación account: the one remembered in Settings while it still exists, otherwise made now (soles, a debit account).
function detractionAccountId_() {
  var id = String(getSettingsMap()[DETRACTION_ACCOUNT_SETTING_] || '');
  if (id && getAllRows('Payment Methods').some(function (p) { return String(p.id) === id; })) return id;
  var pm = addPaymentMethod({ nickname: tr_('detr.accountName'), type: 'debit' });
  setSetting_(DETRACTION_ACCOUNT_SETTING_, String(pm.id));
  bumpStructureVersion_();   // the phones' account lists take it in
  return String(pm.id);
}

// Makes the linked transfer agree with its income (made, changed or removed). Called after every write that can change an income.
function syncDetraction_(incomeId) {
  if (!detractionColumnsExist_()) return;
  var income = getEntryById_(incomeId);
  var linked = getAllRows('Entries').filter(function (e) { return String(e.detraction_of || '') === String(incomeId); });
  var want = income && income.type === 'income' && Number(income.detraction_amount) > 0 && income.payment_method_id &&
    income.status === 'confirmed' && !income.income_waiting && isCompanyCopy_();
  if (!want) {
    if (linked.length) deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(incomeId); });
    return;
  }
  var fields = {
    date: String(income.date).slice(0, 10), amount: round2_(Number(income.detraction_amount)), currency: 'PEN',
    payment_method_id: String(income.payment_method_id), to_payment_method_id: detractionAccountId_(),
    description: tr_('detr.transferDesc', { what: String(income.description || '') || tr_('detr.transferDescPlain') })
  };
  if (linked.length) {
    updateRowFields_('Entries', linked[0].id, fields);
    if (linked.length > 1) deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(incomeId) && e.id !== linked[0].id; });
    return;
  }
  ensureEntriesToPaymentMethodColumn_();
  var entry = createTransferEntry_(fields);
  updateRowFields_('Entries', entry.id, { to_payment_method_id: fields.to_payment_method_id, detraction_of: String(incomeId) });
}

// A save's detraction (createEntry / an update): stored on the income, then the transfer follows.
function applyDetractionFromSave_(entryId, raw) {
  if (raw === undefined) { if (detractionColumnsExist_()) syncDetraction_(entryId); return; }
  var entry = getEntryById_(entryId);
  var clean = cleanDetraction_(entry, raw);
  if (clean === '' && !detractionColumnsExist_()) return;
  ensureDetractionColumns_();
  updateRowFields_('Entries', entryId, { detraction_amount: clean });
  syncDetraction_(entryId);
}

// An entry deleted: an income takes its transfer with it; the transfer deleted on its own clears its income's detraction (the person
// decided the money did not go to the Banco de la Nación), so the bank and the income never disagree.
function detractionAfterDelete_(deleted) {
  if (!detractionColumnsExist_() || !deleted || !deleted.length) return;
  var gone = {};
  deleted.forEach(function (e) { gone[String(e.id)] = e; });
  deleteRowsWhere_('Entries', function (e) { return !!gone[String(e.detraction_of || '')]; });
  deleted.forEach(function (e) {
    var of = String(e.detraction_of || '');
    if (of && !gone[of] && getEntryById_(of)) updateRowFields_('Entries', of, { detraction_amount: '' });
  });
}
