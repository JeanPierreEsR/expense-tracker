/**
 * Business 2, Phase 2, piece 7 (owner's plan "Fase 2 en detalle", approved 2026-11-23): money between the company and its PARTNERS.
 * Company copies only (isCompanyCopy_), nothing changes anywhere else.
 *
 * Money a partner puts in is never income. A waiting item in Needs review ("It's a partner's money") becomes one of:
 *   - a CONTRIBUTION (capital): the entry turns into a transfer INTO the account (the account goes up, nothing is income) and a row in
 *     'Contributions' (kind 'contribution') says whose and for which company / project;
 *   - TO BE DECIDED with the accountant: the same, with kind 'pending'; later changed to a contribution or a loan, same date and amount;
 *   - a LOAN from the partner: an ordinary "I owe them" loan (convertEntryInto_, like any loan received), on the company.
 * Money paid OUT to a partner as a profit DISTRIBUTION is never an expense: the waiting item turns into a transfer OUT of the account
 * and a row in 'Distributions' keeps the gross, the withholding the person typed (data only) and the net (= the entry's amount, what
 * really left). The app never works out profits or shares.
 *
 * Amount, currency, date and account always live on the entry (one source); the rows only add who / what / which company. A row
 * whose entry is gone (deleted from Home) is ignored by every reader.
 */

var PARTNER_KINDS_ = { contribution: true, pending: true };

function requireCompanyCopy_() {
  requireBusiness_();
  if (!isCompanyCopy_()) throw new Error(tr_('partner.onlyCompany'));
}

function contributionRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Contributions')) return [];
  return getAllRows('Contributions');
}
function distributionRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Distributions')) return [];
  return getAllRows('Distributions');
}

// The partner a request names: an existing person (a plain friend becomes a partner; someone with another business role keeps it), or a
// new name (reused when a person of that name exists). Returns the person's id.
function partnerIdFor_(payload) {
  var friends = getAllRows('Friends');
  var f = null;
  if (payload.partner_id) {
    f = friends.find(function (x) { return x.id === payload.partner_id; });
    if (!f) throw new Error(tr_('err.friendNotFound'));
  } else {
    var name = String(payload.partner_name || '').trim();
    if (!name) throw new Error(tr_('partner.pickPartner'));
    f = friends.find(function (x) { return !x.trip_id && String(x.name).trim().toLowerCase() === name.toLowerCase(); });
    if (!f) return addFriend({ name: name, role: 'partner' }).id;
  }
  if (friendRoleOf_(f) === 'friend' && !f.trip_id) {
    ensureBusinessSheets_();
    var sheet = getSheet('Friends');
    var headers = getHeaders(sheet);
    setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, f.id), 'role', 'partner');
  }
  return f.id;
}

// The company (and project) the money belongs to: a project forces its own company; with none, the only company of the copy.
function partnerScope_(payload) {
  var companyId = companyIdForLoan_(payload.company_id, payload.project_id);
  if (!companyId) companyId = defaultCompanyId_() || '';
  if (!companyId) throw new Error(tr_('partner.pickCompany'));
  return { company_id: companyId, project_id: projectIdForLoan_(payload.project_id) };
}

// Turns a waiting (or confirmed) expense / income into a plain transfer in place: same id, date, amount, currency and account (so a bank
// e-mail or a statement line that matched it still matches), no category, no company, nobody "received from", confirmed.
function entryToPartnerTransfer_(entry, description) {
  deleteEntrySplitsAndLoansForEntry_(entry.id);
  var set = function (k, v) { if (entry[k] !== undefined || k === 'type' || k === 'status') setEntryField_(entry.id, k, v); };
  set('type', 'transfer');
  set('category_id', transferCategoryId_());
  set('status', 'confirmed');
  set('paid_by', 'me');
  ['company_id', 'project_id', 'igv_amount', 'trip_id', 'expected_payment_id', 'to_payment_method_id'].forEach(function (k) { set(k, ''); });
  if (description) set('description', description);
  setEntryField_(entry.id, 'amount', Math.abs(Number(entry.amount)));
}

function partnerMoneyEntry_(payload, wantIn) {
  var entry = getEntryById_(payload.entry_id);
  if (!entry) throw new Error(tr_('convert.gone'));
  var ok = wantIn ? (entry.type === 'income' || entry.type === 'transfer') : (entry.type === 'expense' || entry.type === 'transfer');
  if (!ok) throw new Error(tr_(wantIn ? 'partner.onlyIn' : 'partner.onlyOut'));
  // Already a partner's money: said as such (testers 2.68.2, Nico: it said "a loan's money movement: change it from Loans").
  if (entry.type === 'transfer' && (contributionRows_().some(function (r) { return r.entry_id === entry.id; }) ||
      distributionRows_().some(function (r) { return r.entry_id === entry.id; }))) throw new Error(tr_('partner.already'));
  if (entry.type === 'transfer' && buildTransferLinkMap_()[entry.id]) throw new Error(tr_('convert.alreadyMovement'));
  if (entry.type === 'transfer' && entry.to_payment_method_id && entry.payment_method_id) throw new Error(tr_('partner.betweenAccounts'));
  if (repaymentPartInfo_(entry.id)) throw new Error(tr_('typeChange.isRepaymentExtra'));
  return entry;
}

function friendNameById_(id) {
  var f = getAllRows('Friends').find(function (x) { return x.id === id; });
  return f ? String(f.name) : '';
}

/**
 * "It's a partner's money" (Needs review). payload: { entry_id, kind: 'contribution' | 'pending' | 'loan', partner_id | partner_name,
 * company_id, project_id }. Returns { kind, partner_id, contribution | loan }.
 */
function convertEntryToPartnerMoney(payload) {
  requireCompanyCopy_();
  return withScriptLockOnce_(function () {
    var kind = String(payload.kind || '');
    if (kind !== 'loan' && !PARTNER_KINDS_[kind]) throw new Error(tr_('partner.pickKind'));
    var entry = partnerMoneyEntry_(payload, true);
    var scope = partnerScope_(payload);
    var partnerId = partnerIdFor_(payload);
    var name = friendNameById_(partnerId);
    if (kind === 'loan') {
      var out = convertEntryInto_({
        entry_id: entry.id, friend_id: partnerId, direction: 'i_owe_them', amount: Math.abs(Number(entry.amount)),
        currency: entry.currency, date: String(entry.date).slice(0, 10), payment_method_id: entry.payment_method_id || entry.to_payment_method_id || '',
        description: tr_('desc.loanFrom', { name: name }), company_id: scope.company_id, project_id: scope.project_id
      }, 'loan');
      return { kind: 'loan', partner_id: partnerId, loan: out.loan };
    }
    // Money that "arrived in" an account on a one-sided transfer is kept on payment_method_id (where a loan's transfer keeps it).
    if (entry.type === 'transfer' && !entry.payment_method_id && entry.to_payment_method_id) setEntryField_(entry.id, 'payment_method_id', entry.to_payment_method_id);
    entryToPartnerTransfer_(entry, tr_(kind === 'pending' ? 'partner.descPending' : 'partner.descContribution', { name: name }));
    ensureBusinessSheets_();
    var row = { id: Utilities.getUuid(), entry_id: entry.id, partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id, kind: kind, note: '' };
    appendRowObject('Contributions', row);
    return { kind: kind, partner_id: partnerId, contribution: row };
  });
}

/**
 * Changes a contribution or a "to be decided" one: to the other kind, or to a LOAN from the partner (same date, amount and account; the
 * entry becomes the loan's own money movement), and / or its partner, company, project. payload: { id, kind, partner_id?, company_id?,
 * project_id? }.
 */
function changePartnerMoney(payload) {
  requireCompanyCopy_();
  return withScriptLockOnce_(function () {
    var row = contributionRows_().find(function (r) { return r.id === payload.id; });
    if (!row) throw new Error(tr_('partner.gone'));
    var entry = getEntryById_(row.entry_id);
    if (!entry) throw new Error(tr_('convert.gone'));
    var kind = String(payload.kind || row.kind);
    if (kind !== 'loan' && !PARTNER_KINDS_[kind]) throw new Error(tr_('partner.pickKind'));
    var scope = (payload.company_id !== undefined || payload.project_id !== undefined)
      ? partnerScope_(payload) : { company_id: row.company_id, project_id: row.project_id };
    var partnerId = payload.partner_id || payload.partner_name ? partnerIdFor_(payload) : row.partner_id;
    var name = friendNameById_(partnerId);
    if (payload.amount !== undefined && payload.amount !== '') {   // the "Edit partner's money" window (owner, 2026-11-26) also changes the amount
      var amount = round2_(Number(payload.amount));
      if (!(isFinite(amount) && amount >= 0.01 && amount <= MAX_AMOUNT_)) throw new Error(tr_('err.validAmount'));
      if (Math.abs(Math.abs(Number(entry.amount)) - amount) > 0.004) { setEntryField_(entry.id, 'amount', amount); entry.amount = amount; }
    }
    if (kind === 'loan') {
      // The entry already is the transfer into the account: the loan takes it as its own (createLoan_ with transfer_entry_id).
      deleteRowsWhere_('Contributions', function (r) { return r.id === row.id; });
      var loan = createLoan_({
        friend_id: partnerId, direction: 'i_owe_them', origin: 'cash', amount: Number(entry.amount), currency: entry.currency,
        date: String(entry.date).slice(0, 10), due_date: '', payment_method_id: entry.payment_method_id || '',
        description: tr_('desc.loanFrom', { name: name }), project_id: scope.project_id, company_id: scope.company_id,
        transfer_entry_id: entry.id
      });
      setEntryField_(entry.id, 'description', tr_('desc.loanFrom', { name: name }));
      return { kind: 'loan', loan: loan };
    }
    var fields = { kind: kind, partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id };
    updateRowFields_('Contributions', row.id, fields);
    setEntryField_(entry.id, 'description', tr_(kind === 'pending' ? 'partner.descPending' : 'partner.descContribution', { name: name }));
    return { kind: kind, contribution: Object.assign({}, row, fields) };
  });
}

/**
 * A profit distribution paid to a partner (Needs review → "Profit distribution"). payload: { entry_id, partner_id | partner_name,
 * company_id, project_id, withholding }. The entry's amount is the NET (what left the account); gross = net + withholding.
 */
function recordDistribution(payload) {
  requireCompanyCopy_();
  return withScriptLockOnce_(function () {
    var entry = partnerMoneyEntry_(payload, false);
    var withholding = payload.withholding === '' || payload.withholding == null ? 0 : Number(payload.withholding);
    if (!(isFinite(withholding) && withholding >= 0)) throw new Error(tr_('partner.badWithholding'));
    var scope = partnerScope_(payload);
    var partnerId = partnerIdFor_(payload);
    var net = Math.abs(Number(entry.amount));
    if (entry.type === 'transfer' && !entry.payment_method_id && entry.to_payment_method_id) setEntryField_(entry.id, 'payment_method_id', entry.to_payment_method_id);
    entryToPartnerTransfer_(entry, tr_('partner.descDistribution', { name: friendNameById_(partnerId) }));
    ensureBusinessSheets_();
    var row = { id: Utilities.getUuid(), entry_id: entry.id, partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id,
      gross: round2_(net + withholding), withholding: round2_(withholding), note: '' };
    appendRowObject('Distributions', row);
    return { distribution: Object.assign({ net: round2_(net), currency: entry.currency }, row) };
  });
}

// A distribution already recorded, changed from Home (testers 2.69.2: Home opened the plain transfer form). payload: { id, net,
// withholding, partner_id | partner_name, company_id, project_id }. The entry's amount becomes the net; gross is worked out on read.
function changeDistribution(payload) {
  requireCompanyCopy_();
  return withScriptLockOnce_(function () {
    var row = distributionRows_().find(function (r) { return r.id === String(payload.id || ''); });
    if (!row) throw new Error(tr_('partner.gone'));
    var entry = getEntryById_(row.entry_id);
    if (!entry) throw new Error(tr_('convert.gone'));
    var net = Number(payload.net);
    if (!(isFinite(net) && net > 0)) throw new Error(tr_('err.validAmount'));
    var withholding = payload.withholding === '' || payload.withholding == null ? 0 : Number(payload.withholding);
    if (!(isFinite(withholding) && withholding >= 0)) throw new Error(tr_('partner.badWithholding'));
    var scope = (payload.company_id !== undefined || payload.project_id !== undefined)
      ? partnerScope_(payload) : { company_id: row.company_id, project_id: row.project_id };
    var partnerId = payload.partner_id || payload.partner_name ? partnerIdFor_(payload) : row.partner_id;
    net = round2_(net);
    if (Math.abs(Math.abs(Number(entry.amount)) - net) > 0.004) setEntryField_(entry.id, 'amount', Number(entry.amount) < 0 ? -net : net);
    setEntryField_(entry.id, 'description', tr_('partner.descDistribution', { name: friendNameById_(partnerId) }));
    var fields = { partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id,
      withholding: round2_(withholding), gross: round2_(net + withholding) };
    updateRowFields_('Distributions', row.id, fields);
    return { distribution: Object.assign({ net: net, currency: entry.currency }, row, fields) };
  });
}

/**
 * A partner's money recorded straight from the "+" (owner, 2026-11-26: a contribution in cash, or one typed by hand, never reached
 * Needs review). ONE call makes the money movement and its row. payload: { client_id, direction: 'in' | 'out', kind: 'contribution' |
 * 'pending' | 'loan' (in only), amount, currency, date, payment_method_id, description?, partner_id | partner_name, company_id,
 * project_id, withholding (out only) }. The entry (or, for a loan, the loan) takes the client_id as its id, so a repeat of a save that
 * already landed answers { repeat: true } and never makes a second one.
 */
function addPartnerMoney(payload) {
  requireCompanyCopy_();
  checkMoneyFields_(payload);
  return withScriptLockOnce_(function () {
    var out = payload.direction === 'out';
    var kind = out ? 'distribution' : String(payload.kind || '');
    if (!out && kind !== 'loan' && !PARTNER_KINDS_[kind]) throw new Error(tr_('partner.pickKind'));
    var withholding = 0;
    if (out) {
      withholding = payload.withholding === '' || payload.withholding == null ? 0 : Number(payload.withholding);
      if (!(isFinite(withholding) && withholding >= 0)) throw new Error(tr_('partner.badWithholding'));
    }
    var clientId = clientSaveId_(payload);
    if (clientId && (getEntryById_(clientId) || getAllRows('Loans').some(function (l) { return l.id === clientId; }))) {
      return { repeat: true, kind: kind };
    }
    var amount = round2_(Math.abs(Number(payload.amount)));
    var currency = String(payload.currency || homeCurrency_()).toUpperCase();
    var date = String(payload.date).slice(0, 10);
    var pm = String(payload.payment_method_id || '');
    var scope = partnerScope_(payload);
    var partnerId = partnerIdFor_(payload);
    var name = friendNameById_(partnerId);
    var typed = String(payload.description || '').trim();
    if (kind === 'loan') {
      var loan = createLoan_({
        id: clientId || undefined, friend_id: partnerId, direction: 'i_owe_them', origin: 'cash', amount: amount, currency: currency,
        date: date, due_date: '', payment_method_id: pm, description: typed || tr_('desc.loanFrom', { name: name }),
        project_id: scope.project_id, company_id: scope.company_id
      });
      return { kind: 'loan', partner_id: partnerId, loan: loan };
    }
    var descKey = out ? 'partner.descDistribution' : kind === 'pending' ? 'partner.descPending' : 'partner.descContribution';
    var entry = createTransferEntry_({ id: clientId || undefined, date: date, amount: amount, currency: currency, payment_method_id: pm,
      description: typed || tr_(descKey, { name: name }) });
    ensureBusinessSheets_();
    if (out) {
      var drow = { id: Utilities.getUuid(), entry_id: entry.id, partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id,
        gross: round2_(amount + withholding), withholding: round2_(withholding), note: '' };
      appendRowObject('Distributions', drow);
      return { kind: kind, partner_id: partnerId, entry_id: entry.id, distribution: Object.assign({ net: amount, currency: currency }, drow) };
    }
    var row = { id: Utilities.getUuid(), entry_id: entry.id, partner_id: partnerId, company_id: scope.company_id, project_id: scope.project_id, kind: kind, note: '' };
    appendRowObject('Contributions', row);
    return { kind: kind, partner_id: partnerId, entry_id: entry.id, contribution: row };
  });
}

// A distribution's gross = what was paid (the entry's amount, as it is NOW) + the withholding. Worked out on every read, never taken
// from the row's stored `gross`: an amount edited afterwards on Home left the old gross in the cards, the constancia and the
// accountant's package (testers 2.68.2). The stored value only stands in when the entry is gone.
function distributionGross_(row, entry) {
  var withholding = Number(row.withholding) || 0;
  if (!entry) return round2_(Number(row.gross) || 0);
  return round2_(Math.abs(Number(entry.amount) || 0) + withholding);
}

// Transfer entries that bring money IN for a partner (contributions and "to be decided"): the Balances reader counts them as money in.
function partnerInboundIds_(inbound) {
  contributionRows_().forEach(function (r) { if (r.entry_id) inbound[r.entry_id] = true; });
  return inbound;
}

// entry id -> the link the phone shows on the row: { kind: 'contribution' | 'pending' | 'distribution', partner, partner_id }.
function partnerLinkMap_() {
  var c = contributionRows_(), d = distributionRows_();
  if (!c.length && !d.length) return {};
  var names = {};
  getAllRows('Friends').forEach(function (f) { names[f.id] = f.name; });
  var map = {};
  c.forEach(function (r) { map[r.entry_id] = { kind: r.kind === 'pending' ? 'pending' : 'contribution', partner: names[r.partner_id] || '', partner_id: r.partner_id, id: r.id, company_id: r.company_id || '', project_id: r.project_id || '' }; });
  var byId = {};
  if (d.length) getAllRows('Entries').forEach(function (e) { byId[e.id] = e; });
  d.forEach(function (r) { map[r.entry_id] = { kind: 'distribution', partner: names[r.partner_id] || '', partner_id: r.partner_id, id: r.id, gross: distributionGross_(r, byId[r.entry_id]), withholding: Number(r.withholding) || 0, company_id: r.company_id || '', project_id: r.project_id || '' }; });
  return map;
}

/**
 * The company Overview's "Partners" card (company copies): per partner and currency, never converted:
 *   contributed (capital, up to the period's end), pending (to be decided, up to the period's end), owed (what their loans still owe,
 *   now), distributed (net paid in the period, with its gross and withholding).
 * Only partners with something to show. Lenders stay in "What is owed".
 */
function companyPartners_(startDate, endDate) {
  var c = contributionRows_(), d = distributionRows_();
  var friends = {};
  getAllRows('Friends').forEach(function (f) { friends[f.id] = f; });
  var entries = {};
  if (c.length || d.length) getAllRows('Entries').forEach(function (e) { entries[e.id] = e; });
  var people = {};
  var line = function (pid, cur) {
    var p = people[pid] = people[pid] || { partner_id: pid, name: String((friends[pid] || {}).name || '') || tr_('label.unknownFriend'), lines: {} };   // a hand-typed row's unknown partner is named so
    return p.lines[cur] = p.lines[cur] || { currency: cur, contributed: 0, pending: 0, owed: 0, owed_bills: 0, distributed: 0, gross: 0, withholding: 0 };
  };
  var end = endDate ? String(endDate).slice(0, 10) : '';
  var start = startDate ? String(startDate).slice(0, 10) : '';
  c.forEach(function (r) {
    var e = entries[r.entry_id];
    if (!e || e.status !== 'confirmed') return;
    var day = String(e.date).slice(0, 10);
    if (end && day > end) return;
    var l = line(r.partner_id, String(e.currency));
    l[r.kind === 'pending' ? 'pending' : 'contributed'] = round2_(l[r.kind === 'pending' ? 'pending' : 'contributed'] + Number(e.amount));
  });
  d.forEach(function (r) {
    var e = entries[r.entry_id];
    if (!e || e.status !== 'confirmed') return;
    var day = String(e.date).slice(0, 10);
    if ((start && day < start) || (end && day > end)) return;
    var l = line(r.partner_id, String(e.currency));
    l.distributed = round2_(l.distributed + Number(e.amount));
    l.gross = round2_(l.gross + distributionGross_(r, e));
    l.withholding = round2_(l.withholding + (Number(r.withholding) || 0));
  });
  // What the company owes each partner, split in two (testers 2.68.2, Lucho): money they lent (`owed`) and company bills they paid
  // themselves (`owed_bills`, a loan made from an expense). A partner whose debts are all repaid is marked `repaid`, so the card does
  // not say "nothing recorded".
  var settled = buildSettlementTotalsByLoan_();
  var hadLoans = {};
  getAllRows('Loans').forEach(function (l) {
    if (friendRoleOf_(friends[l.friend_id] || {}) !== 'partner' || l.direction !== 'i_owe_them') return;
    hadLoans[l.friend_id] = true;
    if (l.status === 'forgiven') return;
    var left = round2_((Number(l.amount) || 0) - (settled[l.id] || 0));
    if (left <= 0.004) return;
    var ln = line(l.friend_id, String(l.currency || homeCurrency_()));
    if (l.origin === 'entry') ln.owed_bills = round2_(ln.owed_bills + left); else ln.owed = round2_(ln.owed + left);
  });
  // A partner with nothing yet still shows (with no lines), so the card can say who the partners are.
  Object.keys(friends).forEach(function (id) { if (friendRoleOf_(friends[id]) === 'partner' && !friends[id].trip_id && !people[id]) people[id] = { partner_id: id, name: String(friends[id].name || ''), lines: {} }; });
  var home = homeCurrency_();
  return Object.keys(people).map(function (id) {
    var p = people[id];
    if (hadLoans[id]) p.repaid = !Object.keys(p.lines).some(function (k) { return p.lines[k].owed > 0.004 || p.lines[k].owed_bills > 0.004; });
    p.lines = Object.keys(p.lines).sort(function (a, b) { return a === home ? -1 : (b === home ? 1 : (a < b ? -1 : 1)); }).map(function (k) { return p.lines[k]; });
    return p;
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// The "to be decided" contributions, oldest first, for the card's "decide it now" list.
function listPendingContributions() {
  requireCompanyCopy_();
  return pendingContributions_();
}
function pendingContributions_() {
  var rows = contributionRows_().filter(function (r) { return r.kind === 'pending'; });
  if (!rows.length) return [];
  var entries = {};
  getAllRows('Entries').forEach(function (e) { entries[e.id] = e; });
  var names = {};
  getAllRows('Friends').forEach(function (f) { names[f.id] = f.name; });
  return rows.map(function (r) {
    var e = entries[r.entry_id];
    return e ? { id: r.id, entry_id: r.entry_id, partner_id: r.partner_id, partner: names[r.partner_id] || '', company_id: r.company_id, project_id: r.project_id,
      amount: Number(e.amount), currency: e.currency, date: String(e.date).slice(0, 10), payment_method_id: e.payment_method_id || '' } : null;
  }).filter(Boolean).sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
}
