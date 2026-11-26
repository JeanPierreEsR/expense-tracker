/**
 * Construction contracts (owner's plan "Plan: préstamo con cuotas desde el "+", detracciones y contratos de obra", piece 3, 2026-11-26).
 * Company copies only. A project's contract with a subcontractor: amount, currency, % advance, % guarantee fund ("fondo de garantía").
 *
 * The money is the expenses, as everywhere in the app (owner: the advance counts the day it is paid): each payment is an ordinary expense
 * of the project, linked to its contract with a kind:
 *   - advance:          money paid before the work (the expense's amount);
 *   - valuation:        a "valorización": the gross amount of work valued, minus the part of the advance it takes back, minus the guarantee
 *                       kept; the expense is the net that left (gross − advance_amortized − retention_held, to the cent);
 *   - retention_return: the guarantee fund given back at the end (the expense's amount).
 * The contract then shows what was valued, paid, the advance still to take back, the guarantee still to give back and what is left to pay.
 * Amount, date and account live ONLY on the expense; a payment row whose expense is gone (or is no longer an expense) is ignored.
 */
var CONTRACT_KINDS_ = { advance: true, valuation: true, retention_return: true };

function contractRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Contracts')) return [];
  return getAllRows('Contracts');
}
function contractPaymentRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Contract Payments')) return [];
  return getAllRows('Contract Payments');
}
function contractPct_(raw) {
  if (raw === '' || raw === null || raw === undefined) return 0;
  var n = Number(raw);
  if (!isFinite(n) || n < 0 || n >= 100) throw new Error(tr_('contract.badPct'));
  return round2_(n);
}
// The subcontractor: an existing person (a plain friend becomes a supplier; another business role is kept) or a new supplier.
function contractSupplierId_(payload) {
  var friends = getAllRows('Friends');
  if (payload.supplier_id) {
    var f = friends.find(function (x) { return x.id === payload.supplier_id; });
    if (!f) throw new Error(tr_('err.friendNotFound'));
    if (friendRoleOf_(f) === 'friend' && !f.trip_id) {
      var sheet = getSheet('Friends'), headers = getHeaders(sheet);
      setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, f.id), 'role', 'supplier');
    }
    return f.id;
  }
  var name = String(payload.supplier_name || '').trim();
  if (!name) throw new Error(tr_('contract.pickSupplier'));
  var same = friends.find(function (x) { return !x.trip_id && String(x.name).trim().toLowerCase() === name.toLowerCase(); });
  return same ? same.id : addFriend({ name: name, role: 'supplier' }).id;
}

// payload: { id? (an edit), client_id?, project_id, supplier_id | supplier_name, description, amount, currency, advance_pct, retention_pct, note }
function saveContract(payload) {
  requireCompanySales_();
  return withScriptLockOnce_(function () {
    var project = projectById_(payload.project_id);
    if (!project) throw new Error(tr_('business.projectNotFound'));
    var amount = Number(payload.amount);
    if (!isFinite(amount) || amount < 0.01 || amount > MAX_AMOUNT_) throw new Error(tr_('err.validAmount'));
    var fields = {
      project_id: String(project.id), company_id: String(project.company_id || ''), supplier_id: contractSupplierId_(payload),
      description: String(payload.description || '').trim().substring(0, 200), amount: round2_(amount),
      currency: String(payload.currency || homeCurrency_()).toUpperCase(),
      advance_pct: contractPct_(payload.advance_pct), retention_pct: contractPct_(payload.retention_pct), note: String(payload.note || '').substring(0, 500)
    };
    ensureBusinessSheets_();
    if (payload.id) {
      var row = contractRows_().find(function (c) { return c.id === payload.id; });
      if (!row) throw new Error(tr_('contract.gone'));
      if (row.currency !== fields.currency && contractPaymentsOf_(row.id).length) throw new Error(tr_('contract.currencyLocked'));
      updateRowFields_('Contracts', row.id, fields);
      return Object.assign({ id: row.id }, fields);
    }
    var id = clientSaveId_(payload);
    if (id && contractRows_().some(function (c) { return c.id === id; })) return { id: id, repeat: true };
    var created = Object.assign({ id: id || Utilities.getUuid() }, fields);
    appendRowObject('Contracts', created);
    return created;
  });
}

// A contract with no payment can go; one with payments is kept (its expenses are real money).
function deleteContract(payload) {
  requireCompanySales_();
  return withScriptLockOnce_(function () {
    if (contractPaymentsOf_(payload.id).length) throw new Error(tr_('contract.hasPayments'));
    deleteRowsWhere_('Contract Payments', function (r) { return r.contract_id === payload.id; });
    deleteRowsWhere_('Contracts', function (c) { return c.id === payload.id; });
    return { done: true };
  });
}

// The payments of a contract whose expense still exists: [{ row, entry }].
function contractPaymentsOf_(contractId, entriesById) {
  var byId = entriesById || null;
  return contractPaymentRows_().filter(function (r) { return r.contract_id === contractId; }).map(function (r) {
    var e = byId ? byId[r.entry_id] : getEntryById_(r.entry_id);
    return e && e.type === 'expense' ? { row: r, entry: e } : null;
  }).filter(Boolean);
}

// The figures of one contract.
function contractView_(c, entriesById, people) {
  var pays = contractPaymentsOf_(c.id, entriesById);
  var t = { advance_paid: 0, advance_amortized: 0, valued: 0, retained: 0, returned: 0, paid: 0 };
  pays.forEach(function (p) {
    var amt = Math.abs(Number(p.entry.amount)) || 0;
    t.paid += amt;
    if (p.row.kind === 'advance') t.advance_paid += amt;
    else if (p.row.kind === 'retention_return') t.returned += amt;
    else {
      t.valued += Number(p.row.gross) || 0;
      t.advance_amortized += Number(p.row.advance_amortized) || 0;
      t.retained += Number(p.row.retention_held) || 0;
    }
  });
  Object.keys(t).forEach(function (k) { t[k] = round2_(t[k]); });
  var supplier = people[c.supplier_id] || {};
  return {
    id: c.id, project_id: c.project_id, company_id: c.company_id, supplier_id: c.supplier_id, supplier: String(supplier.name || ''),
    description: String(c.description || ''), amount: Number(c.amount) || 0, currency: String(c.currency || ''),
    advance_pct: Number(c.advance_pct) || 0, retention_pct: Number(c.retention_pct) || 0, note: String(c.note || ''),
    valued: t.valued, paid: t.paid, advance_paid: t.advance_paid, advance_amortized: t.advance_amortized,
    advance_left: round2_(t.advance_paid - t.advance_amortized), retention_left: round2_(t.retained - t.returned),
    to_pay: round2_((Number(c.amount) || 0) - t.paid),
    payments: pays.map(function (p) {
      return { entry_id: p.entry.id, kind: p.row.kind, date: String(p.entry.date).slice(0, 10), amount: Math.abs(Number(p.entry.amount)) || 0,
        gross: Number(p.row.gross) || 0, advance_amortized: Number(p.row.advance_amortized) || 0, retention_held: Number(p.row.retention_held) || 0 };
    }).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; })
  };
}

// Every contract of the copy with its figures (getMeta: the "+" form needs them; [] and nothing read on a copy without contracts).
function contractsForApp_() {
  var rows = contractRows_();
  if (!rows.length || !isCompanyCopy_()) return [];
  var entriesById = {};
  getAllRows('Entries').forEach(function (e) { entriesById[e.id] = e; });
  var people = {};
  getAllRows('Friends').forEach(function (f) { people[f.id] = f; });
  return rows.map(function (c) { return contractView_(c, entriesById, people); });
}

// payload: { project_id } -> { contracts }
function listProjectContracts(payload) {
  requireCompanySales_();
  var pid = String((payload && payload.project_id) || '');
  return { contracts: contractsForApp_().filter(function (c) { return c.project_id === pid; }) };
}

// A save's link to a contract (createEntry / an update): undefined = leave it; null or '' = no contract; else
// { contract_id, kind, gross?, advance_amortized?, retention_held? }. Checked before it is kept.
function applyContractPaymentFromSave_(entryId, cp) {
  if (cp === undefined) return;
  if (!cp) {
    if (contractPaymentRows_().length) deleteRowsWhere_('Contract Payments', function (r) { return r.entry_id === entryId; });
    return;
  }
  if (!isCompanyCopy_()) return;
  var entry = getEntryById_(entryId);
  if (!entry || entry.type !== 'expense') throw new Error(tr_('contract.onlyExpense'));
  var contract = contractRows_().find(function (c) { return c.id === cp.contract_id; });
  if (!contract) throw new Error(tr_('contract.gone'));
  if (String(entry.project_id || '') !== String(contract.project_id)) throw new Error(tr_('contract.otherProject'));
  if (String(entry.currency || '').toUpperCase() !== String(contract.currency || '').toUpperCase()) throw new Error(tr_('contract.otherCurrency'));
  var kind = String(cp.kind || '');
  if (!CONTRACT_KINDS_[kind]) throw new Error(tr_('contract.pickKind'));
  var row = { contract_id: contract.id, entry_id: entryId, kind: kind, gross: '', advance_amortized: '', retention_held: '' };
  if (kind === 'valuation') {
    var gross = Number(cp.gross), amort = Number(cp.advance_amortized) || 0, held = Number(cp.retention_held) || 0;
    if (!(isFinite(gross) && gross > 0) || amort < 0 || held < 0) throw new Error(tr_('err.validAmount'));
    if (Math.abs(round2_(gross - amort - held) - Math.abs(Number(entry.amount))) > 0.01) throw new Error(tr_('contract.netMismatch'));
    row.gross = round2_(gross); row.advance_amortized = round2_(amort); row.retention_held = round2_(held);
  }
  ensureBusinessSheets_();
  var existing = contractPaymentRows_().find(function (r) { return r.entry_id === entryId; });
  if (existing) updateRowFields_('Contract Payments', existing.id, row);
  else appendRowObject('Contract Payments', Object.assign({ id: Utilities.getUuid() }, row));
}
