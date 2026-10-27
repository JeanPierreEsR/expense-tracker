/**
 * Business pack, step 3A (2026-10-27) — expected payments and invoice numbers. See specs/business.md § Step 3.
 *
 * An EXPECTED PAYMENT is money a client still owes on a project: amount, currency, due date, optional invoice number.
 * It is a reminder, never income: it counts in no margin and no total (CLAUDE.md principle 9, cash basis). It stops
 * being expected when an INCOME entry is linked to it (Entries.expected_payment_id, same project, same currency); a
 * part payment leaves what remains. "Covered" closes one that was settled some other way. Kept in its own tab, NOT in
 * the Programmed items, so Projections and "Programmed this month" stay personal.
 *
 * Nothing here reads or writes a sheet while the pack is off (requireBusiness_ / businessOn_), like Business.gs.
 */

var EXPECTED_STATUSES_ = { open: true, covered: true };

function getExpectedRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Expected Payments');
}

function expectedById_(id) {
  var found = null;
  getExpectedRows_().forEach(function (x) { if (String(x.id) === String(id)) found = x; });
  return found;
}

function businessToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// What an income entry may point at: only an income, only an expected payment that exists on the SAME project and in the
// SAME currency. Anything else answers '' (no link), so a stale or mismatched id never survives a save.
function expectedLinkFor_(type, expectedId, projectId, currency) {
  if (!expectedId || type !== 'income' || !businessOn_()) return '';
  var x = expectedById_(expectedId);
  if (!x) return '';
  if (String(x.project_id) !== String(projectId || '')) return '';
  if (String(x.currency) !== String(currency || homeCurrency_())) return '';
  return String(x.id);
}

// expected id -> what confirmed income entries linked to it have brought in (in the payment's own currency).
function expectedPaidMap_() {
  var paid = {};
  var currencyOf = {};
  getExpectedRows_().forEach(function (x) { currencyOf[x.id] = x.currency; });
  getAllRows('Entries').forEach(function (e) {
    if (!e.expected_payment_id || e.type !== 'income' || e.status !== 'confirmed') return;
    if (currencyOf[e.expected_payment_id] !== e.currency) return;   // an income later changed to another currency no longer counts
    paid[e.expected_payment_id] = (paid[e.expected_payment_id] || 0) + Number(e.amount);
  });
  return paid;
}

function expectedViews_(rows, today) {
  var paid = expectedPaidMap_();
  var projects = {};
  getProjectRows_().forEach(function (p) { projects[p.id] = p; });
  var companies = {};
  getCompanyRows_().forEach(function (c) { companies[c.id] = c; });
  var people = {};
  getAllRows('Friends').forEach(function (f) { people[f.id] = f; });
  return rows.map(function (x) {
    var project = projects[x.project_id] || {};
    var company = companies[project.company_id] || {};
    var got = round2_(paid[x.id] || 0);
    var remaining = round2_(Number(x.amount) - got);
    var state = x.status === 'covered' ? 'covered' : (remaining <= 0.004 ? 'settled' : 'open');
    return {
      id: x.id, project_id: x.project_id, project_name: project.name || '', project_emoji: project.emoji || '',
      company_id: project.company_id || '', company_name: company.name || '', company_emoji: company.emoji || '',
      client_id: x.client_id || '', client_name: (people[x.client_id] || {}).name || '',
      amount: Number(x.amount), currency: x.currency, due_date: x.due_date, invoice_no: x.invoice_no || '', note: x.note || '',
      status: x.status || 'open', paid: got, remaining: state === 'open' ? remaining : 0, state: state,
      overdue: state === 'open' && String(x.due_date) < today
    };
  }).sort(function (a, b) {
    if (a.state !== b.state) return a.state === 'open' ? -1 : (b.state === 'open' ? 1 : 0);
    return a.due_date < b.due_date ? -1 : (a.due_date > b.due_date ? 1 : (a.id < b.id ? -1 : 1));
  });
}

function validIsoDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

function cleanExpectedInput_(p) {
  var project = projectById_(p.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var amount = Number(p.amount);
  if (!(amount > 0)) throw new Error(tr_('err.validAmount'));
  var currency = String(p.currency || homeCurrency_()).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!validIsoDate_(p.due_date)) throw new Error(tr_('business.errDueDate'));
  var clientId = '';
  if (p.client_id) {
    var person = getAllRows('Friends').find(function (f) { return String(f.id) === String(p.client_id); });
    if (person && !person.trip_id) clientId = String(person.id);
  }
  return {
    project_id: String(project.id), client_id: clientId, amount: round2_(amount), currency: currency,
    due_date: String(p.due_date), invoice_no: String(p.invoice_no || '').trim().substring(0, 60),
    note: String(p.note || '').trim().substring(0, 200)
  };
}

function addExpectedPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var x = cleanExpectedInput_(payload || {});
  x.id = Utilities.getUuid();
  x.status = 'open';
  appendRowObject('Expected Payments', x);
  return expectedViews_([x], businessToday_())[0];
}

function updateExpectedPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var sheet = getSheet('Expected Payments');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload && payload.id);
  if (rowIndex === -1) throw new Error(tr_('business.expectedNotFound'));
  var existing = expectedById_(payload.id);
  var clean = cleanExpectedInput_(Object.assign({}, payload, { project_id: payload.project_id || existing.project_id }));
  // Income already linked to it counts in this project and this currency: changing either would orphan that income.
  if ((clean.project_id !== String(existing.project_id) || clean.currency !== String(existing.currency)) && (expectedPaidMap_()[existing.id] || 0) > 0) {
    throw new Error(tr_('business.errExpectedMove'));
  }
  withWriteBatch_(function () {
    Object.keys(clean).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, clean[key]); });
  });
  clean.id = existing.id;
  clean.status = existing.status || 'open';
  return expectedViews_([clean], businessToday_())[0];
}

// "Mark as covered" (it was paid some other way) and back.
function coverExpectedPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var sheet = getSheet('Expected Payments');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload && payload.id);
  if (rowIndex === -1) throw new Error(tr_('business.expectedNotFound'));
  var status = payload.covered === false ? 'open' : 'covered';
  withWriteBatch_(function () { setCellByRow_(sheet, headers, rowIndex, 'status', status); });
  return { id: payload.id, status: status };
}

// Income entries that pointed at it simply stop pointing (they stay as income).
function clearExpectedLinks_(ids) {
  var set = {};
  ids.forEach(function (id) { set[String(id)] = true; });
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var col = headers.indexOf('expected_payment_id');
  if (col === -1 || sheet.getLastRow() < 2) return;
  sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (row, i) {
    if (set[String(row[0])]) setCellByRow_(sheet, headers, i + 2, 'expected_payment_id', '');
  });
}

function deleteExpectedPayment(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var id = String((payload && payload.id) || '');
  if (!expectedById_(id)) throw new Error(tr_('business.expectedNotFound'));
  withWriteBatch_(function () {
    clearExpectedLinks_([id]);
    deleteRowsWhere_('Expected Payments', function (row) { return String(row.id) === id; });
  });
  return { done: true };
}

// Called when a project is deleted: its expected payments go with it (the income stays, minus the link).
function deleteExpectedForProject_(projectId) {
  var mine = getExpectedRows_().filter(function (x) { return String(x.project_id) === String(projectId); });
  if (!mine.length) return;
  clearExpectedLinks_(mine.map(function (x) { return x.id; }));
  deleteRowsWhere_('Expected Payments', function (row) { return String(row.project_id) === String(projectId); });
}

// One list for a project (project_id), a company (company_id: every project's), or the Home card (scope 'home': what is still open and
// due up to the end of this month, overdue ones included). `open` keeps only the ones still expected (the entry form's picker).
function listExpectedPayments(payload) {
  requireBusiness_();
  payload = payload || {};
  var today = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.today || '')) ? payload.today : businessToday_();
  var rows = getExpectedRows_();
  if (payload.project_id) rows = rows.filter(function (x) { return String(x.project_id) === String(payload.project_id); });
  if (payload.company_id) {
    var inCompany = {};
    getProjectRows_().forEach(function (p) { if (String(p.company_id) === String(payload.company_id)) inCompany[p.id] = true; });
    rows = rows.filter(function (x) { return inCompany[x.project_id]; });
  }
  var items = expectedViews_(rows, today);
  if (payload.currency) items = items.filter(function (x) { return x.currency === payload.currency; });
  if (payload.open || payload.scope === 'home') items = items.filter(function (x) { return x.state === 'open'; });
  if (payload.scope === 'home') {
    var monthEnd = today.substring(0, 7) + '-31';
    items = items.filter(function (x) { return x.due_date <= monthEnd; });
  }
  var totals = {};
  items.forEach(function (x) {
    if (x.state === 'open') totals[x.currency] = (totals[x.currency] || 0) + x.remaining;
  });
  return {
    items: items,
    totals: orderedCurrencies_(totals).map(function (k) { return { currency: k, remaining: round2_(totals[k]) }; })
  };
}
