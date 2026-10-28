/**
 * Business pack, step 4 (2026-10-28) — the Project / Company STATEMENT. See specs/business.md § Step 4.
 *
 * A statement is DERIVED, never stored (CLAUDE.md principles 7 and 8): for a project or a company, over a period, per currency
 * (never converted), it shows three columns of the same four lines plus the result —
 *   Opening  = what was already there when the period began (the typed opening figures if their date is before the period, plus
 *              the entries after them up to the period's start; "All time" starts from the typed figures themselves),
 *   Movements = the entries inside the period (and the typed figures when their date falls inside it),
 *   Closing  = Opening + Movements.
 * Lines: income received, IGV collected, costs paid and IGV credit (all WITHOUT IGV, at the owner's share), and the result
 * (income − costs). It reads the SAME rows as the project and company screens (businessRows_), so it always agrees with them.
 * Below it, "right now" — not a period: who owes what on the project and what is still expected from clients (information only,
 * never income).
 *
 * Nothing here reads or writes a sheet while the pack is off (requireBusiness_).
 */

var STATEMENT_LINES_ = ['income', 'igv_collected', 'costs', 'igv_credit'];

function statementZero_() { return { income: 0, igv_collected: 0, costs: 0, igv_credit: 0 }; }

function statementAddRow_(fig, r) {
  var net = r.own - (r.igv || 0);
  if (r.entry.type === 'expense') { fig.costs += net; fig.igv_credit += r.igv || 0; } else { fig.income += net; fig.igv_collected += r.igv || 0; }
}

function statementAddOpening_(fig, o) {
  STATEMENT_LINES_.forEach(function (k) { fig[k] += Number(o[k]) || 0; });
}

// The four lines rounded to cents, plus the result.
function statementRound_(fig) {
  var out = {};
  STATEMENT_LINES_.forEach(function (k) { out[k] = round2_(fig[k]); });
  out.result = round2_(fig.income - fig.costs);
  return out;
}

// Where the typed figures of an opening sit in a period: nowhere (its date is after the period), in the Opening column (the
// period starts after it, or there is no start) or in the Movements (its date is inside the period).
function openingPlacement_(o, startDate, endDate) {
  if (endDate && o.as_of > endDate) return '';
  if (!startDate || o.as_of < startDate) return 'opening';
  return 'movements';
}

// rows: entries of the scope from the beginning up to endDate (already without those an opening covers); openings: the typed
// ones of the scope. Returns one block per currency.
function buildStatementBlocks_(rows, openings, startDate, endDate) {
  var cur = {};
  function slot(c) { return cur[c] || (cur[c] = { opening: statementZero_(), movements: statementZero_() }); }
  rows.forEach(function (r) {
    var date = String(r.entry.date);
    if (endDate && date > endDate) return;
    statementAddRow_(slot(r.currency)[startDate && date < startDate ? 'opening' : 'movements'], r);
  });
  var lumps = [];
  openings.forEach(function (o) {
    var where = openingPlacement_(o, startDate, endDate);
    if (!where) return;
    statementAddOpening_(slot(o.currency)[where], o);
    lumps.push({ id: o.id, project_id: o.project_id, currency: o.currency, as_of: o.as_of, where: where });
  });
  var blocks = orderedCurrencies_(cur).map(function (c) {
    var closing = statementZero_();
    STATEMENT_LINES_.forEach(function (k) { closing[k] = cur[c].opening[k] + cur[c].movements[k]; });
    return { currency: c, opening: statementRound_(cur[c].opening), movements: statementRound_(cur[c].movements), closing: statementRound_(closing) };
  });
  return { currencies: blocks, lumps: lumps };
}

// How many entries the typed openings of this scope keep out of the screens (so the statement can say so).
function coveredEntryCount_(match) {
  return businessRows_(match, '', '', true).length - businessRows_(match, '', '').length;
}

// Who owes what on the given projects, net per person and currency (they owe me = positive), and what is still expected.
function statementRightNow_(projectIds, scopePayload) {
  var inScope = {};
  projectIds.forEach(function (id) { inScope[String(id)] = true; });
  var settled = buildSettlementTotalsByLoan_();
  var byFriend = {};
  getAllRows('Loans').forEach(function (l) {
    if (l.status === 'forgiven' || !inScope[String(l.project_id || '')]) return;
    var remaining = Number(l.amount) - (settled[l.id] || 0);
    if (remaining <= 0.004) return;
    var byCur = byFriend[l.friend_id] || (byFriend[l.friend_id] = {});
    byCur[l.currency] = (byCur[l.currency] || 0) + (l.direction === 'they_owe_me' ? remaining : -remaining);
  });
  var friends = {};
  getAllRowsCached_('Friends').forEach(function (f) { friends[String(f.id)] = f; });
  var people = Object.keys(byFriend).map(function (id) {
    var f = friends[id];
    return { id: id, name: f ? f.name : '', role: f ? friendRoleOf_(f) : 'friend', balances: netMapToList_(byFriend[id]) };
  }).filter(function (p) { return p.balances.length; }).sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  var expected = listExpectedPayments(Object.assign({ open: true }, scopePayload));
  return { people: people, expected: { items: expected.items, totals: expected.totals } };
}

// ---- Compare with the accountant ----
// The accountant's four figures for one scope, currency and date, kept so the comparison can be redone later. The app's own figures
// AT that date are its statement from the beginning up to it: the typed opening plus the entries after it. A date before an opening
// cannot be compared (the typed figures are one lump and cannot be split). No tax logic: only the difference per line is shown.

function getAccountantRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Accountant Figures');
}

function cleanAccountantInput_(p) {
  var scope = openingScope_(p);
  var currency = String(p.currency || homeCurrency_()).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!validIsoDate_(p.as_of)) throw new Error(tr_('err.dateRequired'));
  var row = { project_id: scope.project_id, company_id: scope.company_id, currency: currency, as_of: String(p.as_of), note: String(p.note || '').trim().substring(0, 200) };
  STATEMENT_LINES_.forEach(function (f) {
    var raw = p[f] === undefined || p[f] === null || p[f] === '' ? 0 : Number(p[f]);
    if (!isFinite(raw) || raw < 0) throw new Error(tr_('business.errOpeningFigure'));
    row[f] = round2_(raw);
  });
  return row;
}

// One set per scope, currency and date: saving the same date again replaces it.
function saveAccountantFigures(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var row = cleanAccountantInput_(payload || {});
  var sheet = getSheet('Accountant Figures');
  var headers = getHeaders(sheet);
  var same = getAccountantRows_().filter(function (a) {
    return String(a.project_id || '') === row.project_id && (row.project_id || String(a.company_id) === row.company_id) &&
      String(a.currency).toUpperCase() === row.currency && String(a.as_of) === row.as_of;
  })[0];
  var rowIndex = same ? findRowIndexById(sheet, headers, same.id) : -1;
  if (rowIndex !== -1) {
    withWriteBatch_(function () {
      Object.keys(row).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, row[key]); });
    });
    row.id = same.id;
  } else {
    row.id = Utilities.getUuid();
    appendRowObject('Accountant Figures', row);
  }
  return row;
}

function deleteAccountantFigures(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var id = String((payload && payload.id) || '');
  if (!getAccountantRows_().some(function (a) { return String(a.id) === id; })) throw new Error(tr_('business.accountantNotFound'));
  deleteRowsWhere_('Accountant Figures', function (row) { return String(row.id) === id; });
  return { done: true };
}

// The saved comparisons of a scope, newest date first, each with the app's figures at that date and the difference per line
// (app − accountant). status: 'match' (to the cent), 'differs', or 'beforeOpening' (nothing to compare with).
function statementComparisons_(saved, rows, openings) {
  return saved.map(function (a) {
    var currency = String(a.currency).toUpperCase();
    var asOf = String(a.as_of);
    var typed = {};
    STATEMENT_LINES_.forEach(function (k) { typed[k] = Number(a[k]) || 0; });
    var out = { id: String(a.id), project_id: String(a.project_id || ''), currency: currency, as_of: asOf, note: String(a.note || ''), accountant: statementRound_(typed) };
    if (openings.some(function (o) { return o.currency === currency && o.as_of > asOf; })) {
      out.status = 'beforeOpening';
      return out;
    }
    var blocks = buildStatementBlocks_(rows, openings.filter(function (o) { return o.currency === currency; }), '', asOf).currencies;
    var mine = blocks.filter(function (b) { return b.currency === currency; })[0];
    out.app = mine ? mine.closing : statementRound_(statementZero_());
    out.diff = {};
    var ok = true;
    ['income', 'igv_collected', 'costs', 'igv_credit', 'result'].forEach(function (k) {
      out.diff[k] = round2_(out.app[k] - out.accountant[k]);
      if (Math.abs(out.diff[k]) > 0.004) ok = false;
    });
    out.status = ok ? 'match' : 'differs';
    return out;
  }).sort(function (x, y) { return x.as_of < y.as_of ? 1 : (x.as_of > y.as_of ? -1 : 0); });
}

function statementPeriod_(payload) {
  var start = validIsoDate_(payload && payload.startDate) ? String(payload.startDate) : '';
  var end = validIsoDate_(payload && payload.endDate) ? String(payload.endDate) : '';
  return { startDate: start, endDate: end };
}

function getProjectStatement(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var project = projectById_(payload.id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var company = companyById_(project.company_id);
  var period = statementPeriod_(payload);
  var match = function (e) { return String(e.project_id || '') === String(project.id); };
  var mine = businessOpenings_().filter(function (o) { return o.project_id === String(project.id); });
  var built = buildStatementBlocks_(businessRows_(match, '', period.endDate), mine, period.startDate, period.endDate);
  var saved = getAccountantRows_().filter(function (a) { return String(a.project_id || '') === String(project.id); });
  return {
    kind: 'project',
    accountant: statementComparisons_(saved, businessRows_(match, '', ''), mine),
    project: { id: project.id, name: project.name, emoji: project.emoji || '', company_id: project.company_id },
    company: company ? { id: company.id, name: company.name, emoji: company.emoji || '' } : null,
    startDate: period.startDate, endDate: period.endDate,
    currencies: built.currencies, lumps: built.lumps,
    openings: mine.map(openingOut_),
    coveredEntries: coveredEntryCount_(match),
    rightNow: statementRightNow_([project.id], { project_id: project.id, today: payload.today })
  };
}

function getCompanyStatement(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var company = companyById_(payload.id);
  if (!company) throw new Error(tr_('business.companyNotFound'));
  var period = statementPeriod_(payload);
  var projects = getProjectRows_().filter(function (p) { return String(p.company_id) === String(company.id); });
  var match = function (e) { return String(e.company_id || '') === String(company.id); };
  var mine = businessOpenings_().filter(function (o) { return o.company_id === String(company.id); });
  var built = buildStatementBlocks_(businessRows_(match, '', period.endDate), mine, period.startDate, period.endDate);
  var names = {};
  projects.forEach(function (p) { names[String(p.id)] = p.name; });
  var saved = getAccountantRows_().filter(function (a) { return !a.project_id && String(a.company_id) === String(company.id); });
  return {
    kind: 'company',
    accountant: statementComparisons_(saved, businessRows_(match, '', ''), mine),
    company: { id: company.id, name: company.name, emoji: company.emoji || '' },
    startDate: period.startDate, endDate: period.endDate,
    currencies: built.currencies, lumps: built.lumps,
    openings: mine.map(function (o) { var out = openingOut_(o); out.project_name = o.project_id ? (names[o.project_id] || '') : ''; return out; }),
    coveredEntries: coveredEntryCount_(match),
    rightNow: statementRightNow_(projects.map(function (p) { return p.id; }), { company_id: company.id, today: payload.today })
  };
}
