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
 * An invoice in another currency (dollars, 2026-11-27): the client keeps the % of the invoice in ITS currency (`detraction_amount`, to the
 * cent) and deposits its value in SOLES (`detraction_pen`, whole soles: what the Banco de la Nación slip says; proposed from the month's
 * rate, editable). The linked movement is then a currency exchange (two legs, same `exchange_pair`, both `detraction_of`): out of the bank
 * in dollars, into the Banco de la Nación in soles, so each account is right in its own currency.
 */
var DETRACTION_DEFAULT_RATE_ = 4;
var DETRACTION_ACCOUNT_SETTING_ = 'detraction_account_id';

// The detraction a save asks for, cleaned: only a company copy's income with a company, a positive number smaller than the amount (in
// the income's currency); blank means none.
function cleanDetraction_(entry, raw) {
  if (raw === '' || raw === null || raw === undefined) return '';
  if (!isCompanyCopy_() || !entry || entry.type !== 'income' || !entry.company_id) return '';
  var n = Number(raw);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= Math.abs(Number(entry.amount))) throw new Error(tr_('detr.tooBig'));
  return round2_(n);
}

function ensureDetractionColumns_() {
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  ['detraction_amount', 'detraction_of', 'detraction_pen'].forEach(function (h) {
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
  var description = tr_('detr.transferDesc', { what: String(income.description || '') || tr_('detr.transferDescPlain') });
  var date = String(income.date).slice(0, 10);
  var bn = detractionAccountId_();
  if (String(income.currency || 'PEN').toUpperCase() !== 'PEN') { syncDetractionExchange_(income, linked, bn, date, description); return; }
  var fields = {
    date: date, amount: round2_(Number(income.detraction_amount)), currency: 'PEN',
    payment_method_id: String(income.payment_method_id), to_payment_method_id: bn, description: description
  };
  if (linked.length > 1 || (linked.length && String(linked[0].exchange || '') === '1')) {   // it was in another currency: made again
    deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(income.id); });
    linked = [];
  }
  if (linked.length) {
    updateRowFields_('Entries', linked[0].id, fields);
    if (linked.length > 1) deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(incomeId) && e.id !== linked[0].id; });
    return;
  }
  ensureEntriesToPaymentMethodColumn_();
  var entry = createTransferEntry_(fields);
  updateRowFields_('Entries', entry.id, { to_payment_method_id: fields.to_payment_method_id, detraction_of: String(incomeId) });
}

// An invoice in another currency: the two legs of an exchange (out of the bank in its currency, into the Banco de la Nación in soles).
function syncDetractionExchange_(income, linked, bn, date, description) {
  var pen = Math.round(Number(income.detraction_pen) || 0);
  if (!(pen > 0)) { if (linked.length) deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(income.id); }); return; }
  var legs = {
    out: { date: date, amount: round2_(Number(income.detraction_amount)), currency: String(income.currency).toUpperCase(),
      payment_method_id: String(income.payment_method_id), to_payment_method_id: '', description: description },
    in: { date: date, amount: pen, currency: 'PEN', payment_method_id: '', to_payment_method_id: bn, description: description }
  };
  var have = { out: null, in: null };
  linked.forEach(function (e) { if (String(e.exchange || '') === '1') have[String(e.currency).toUpperCase() === 'PEN' ? 'in' : 'out'] = e; });
  if (linked.length !== 2 || !have.out || !have.in) {   // another shape (a soles transfer before): made again
    if (linked.length) deleteRowsWhere_('Entries', function (e) { return String(e.detraction_of || '') === String(income.id); });
    have = { out: null, in: null };
  }
  ensureEntriesToPaymentMethodColumn_();
  ensureEntriesExchangeColumn_();
  ensureColumn_('Entries', 'exchange_pair');
  var pair = have.out ? String(have.out.exchange_pair || '') || Utilities.getUuid() : Utilities.getUuid();
  ['out', 'in'].forEach(function (side) {
    var f = Object.assign({ exchange: '1', exchange_pair: pair }, legs[side]);
    if (have[side]) { updateRowFields_('Entries', have[side].id, f); return; }
    var e = createTransferEntry_(legs[side]);
    updateRowFields_('Entries', e.id, Object.assign(f, { detraction_of: String(income.id) }));
  });
}

// Checked BEFORE the entry is written (createEntry / an update), so a refusal never leaves the income saved without its detracción.
// `entry` = the income as it will be.
function checkDetractionBeforeSave_(entry, raw, pen) {
  if (raw === undefined || raw === '' || raw === null) return;
  var clean = cleanDetraction_(entry, raw);   // throws when it is not smaller than the amount
  if (clean === '' || String(entry.currency || 'PEN').toUpperCase() === 'PEN') return;
  if (Number(pen) > 0 || Number(entry.detraction_pen) > 0) return;
  if (!(detractionPenFor_(entry, clean) > 0)) throw new Error(tr_('detr.needPen'));
}

// The soles a dollar invoice's detracción came to, when the phone did not say: the month's rate (only where soles are the main currency).
function detractionPenFor_(entry, amount) {
  if (homeCurrency_() !== 'PEN') return 0;
  var rate = Number(getLatestRateOnOrBefore_(String(entry.currency).toUpperCase(), String(entry.date).slice(0, 7))) || 0;
  return rate > 0 ? Math.round(amount * rate) : 0;
}

// A save's detraction (createEntry / an update): stored on the income, then the transfer follows. `pen` = the soles deposited (another
// currency only; undefined = keep what is stored, or work it out from the month's rate).
function applyDetractionFromSave_(entryId, raw, pen) {
  if (raw === undefined) { if (detractionColumnsExist_()) syncDetraction_(entryId); return; }
  var entry = getEntryById_(entryId);
  var clean = cleanDetraction_(entry, raw);
  if (clean === '' && !detractionColumnsExist_()) return;
  ensureDetractionColumns_();
  var fields = { detraction_amount: clean, detraction_pen: '' };
  if (clean !== '' && String(entry.currency || 'PEN').toUpperCase() !== 'PEN') {
    var typed = Number(pen);
    var soles = isFinite(typed) && typed > 0 ? Math.round(typed) : (Number(entry.detraction_pen) > 0 && pen === undefined ? Math.round(Number(entry.detraction_pen)) : detractionPenFor_(entry, clean));
    if (!(soles > 0)) throw new Error(tr_('detr.needPen'));
    fields.detraction_pen = soles;
  }
  updateRowFields_('Entries', entryId, fields);
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
