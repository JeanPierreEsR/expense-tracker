/**
 * Business pack, step 4 (2026-10-28) — opening figures. See specs/business.md § Step 4.
 *
 * Someone who starts using the app in the middle of a project does not re-enter the past. For a project (or a company's own
 * level, with no project) and one currency she types FOUR figures "as of" a date: income, IGV collected, costs and IGV credit,
 * all WITHOUT IGV. From then on:
 *   - entries of that project (or company level) and currency dated ON OR BEFORE that date are no longer counted on the
 *     project screen, the company screen, the Companies list and the statement (the figures already contain them);
 *   - the typed figures count in a period that includes the date ("All time" always does).
 * Nothing else changes: Overview, Home, Budgets, Projections, account balances and the entry rows keep every entry, because the
 * money really moved. The company IGV screen keeps counting every entry too (it says so).
 * Debts are never typed here: they come from the real loans and expected payments.
 *
 * Nothing here reads or writes a sheet while the pack is off (requireBusiness_).
 */

var OPENING_FIELDS_ = ['income', 'igv_collected', 'costs', 'igv_credit'];

function getOpeningRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Business Openings');
}

// Every opening, cleaned up: numbers as numbers, the company taken from the project (so a stale company_id can never disagree
// with it), and an opening whose project no longer exists left out.
function businessOpenings_() {
  var out = [];
  getOpeningRows_().forEach(function (r) {
    var project = r.project_id ? projectById_(r.project_id) : null;
    if (r.project_id && !project) return;
    var companyId = project ? String(project.company_id) : String(r.company_id || '');
    if (!companyId) return;
    out.push({
      id: String(r.id), project_id: project ? String(project.id) : '', company_id: companyId,
      currency: String(r.currency || '').toUpperCase(), as_of: String(r.as_of || ''),
      income: Number(r.income) || 0, igv_collected: Number(r.igv_collected) || 0, costs: Number(r.costs) || 0, igv_credit: Number(r.igv_credit) || 0,
      note: String(r.note || '')
    });
  });
  return out;
}

function openingKey_(projectId, companyId, currency) {
  return (projectId ? 'p:' + projectId : 'c:' + companyId) + '|' + String(currency).toUpperCase();
}

// "project id or company-level + currency" -> the date on/before which entries stop counting.
function openingCutoffs_() {
  var map = {};
  businessOpenings_().forEach(function (o) { map[openingKey_(o.project_id, o.company_id, o.currency)] = o.as_of; });
  return map;
}

// The openings a period counts: the typed figures belong to their date, so a period counts them when it contains that date.
function openingsInPeriod_(list, startDate, endDate) {
  return list.filter(function (o) {
    return (!startDate || startDate <= o.as_of) && (!endDate || o.as_of <= endDate);
  });
}

function openingOut_(o) {
  return {
    id: o.id, project_id: o.project_id, company_id: o.company_id, currency: o.currency, as_of: o.as_of,
    income: round2_(o.income), igv_collected: round2_(o.igv_collected), costs: round2_(o.costs), igv_credit: round2_(o.igv_credit), note: o.note
  };
}

// The scope an opening belongs to: a project, or a company's own level. Anything else is refused.
function openingScope_(payload) {
  var project = payload.project_id ? projectById_(payload.project_id) : null;
  if (payload.project_id && !project) throw new Error(tr_('business.projectNotFound'));
  var company = project ? companyById_(project.company_id) : companyById_(payload.company_id);
  if (!company) throw new Error(tr_(payload.company_id || payload.project_id ? 'business.companyNotFound' : 'business.errOpeningScope'));
  return { project_id: project ? String(project.id) : '', company_id: String(company.id) };
}

// How many confirmed expense/income entries of this scope and currency are dated on or before `asOf` (what an opening there
// stops counting; what deleting it brings back).
function countCutoffEntries_(scope, currency, asOf) {
  var n = 0;
  var cur = String(currency).toUpperCase();
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || (e.type !== 'expense' && e.type !== 'income')) return;
    if ((e.currency || homeCurrency_()) !== cur) return;
    if (scope.project_id ? String(e.project_id || '') !== scope.project_id : (String(e.company_id || '') !== scope.company_id || e.project_id)) return;
    if (String(e.date) <= asOf) n++;
  });
  return n;
}

function cleanOpeningInput_(p) {
  var scope = openingScope_(p);
  var currency = String(p.currency || homeCurrency_()).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(tr_('err.currencyCode'));
  if (!validIsoDate_(p.as_of)) throw new Error(tr_('err.dateRequired'));
  if (String(p.as_of) > businessToday_()) throw new Error(tr_('business.errOpeningFuture'));
  var row = { project_id: scope.project_id, company_id: scope.company_id, currency: currency, as_of: String(p.as_of), note: String(p.note || '').trim().substring(0, 200) };
  OPENING_FIELDS_.forEach(function (f) {
    var raw = p[f] === undefined || p[f] === null || p[f] === '' ? 0 : Number(p[f]);
    if (!isFinite(raw) || raw < 0) throw new Error(tr_('business.errOpeningFigure'));
    row[f] = round2_(raw);
  });
  return { row: row, scope: scope };
}

// One opening per project-or-company-level and currency: saving again replaces it. The answer says how many entries stopped counting.
function saveBusinessOpening(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var clean = cleanOpeningInput_(payload);
  var row = clean.row;
  var sheet = getSheet('Business Openings');
  var headers = getHeaders(sheet);
  var existing = businessOpenings_().filter(function (o) {
    return openingKey_(o.project_id, o.company_id, o.currency) === openingKey_(row.project_id, row.company_id, row.currency);
  })[0];
  var rowIndex = existing ? findRowIndexById(sheet, headers, existing.id) : -1;
  if (rowIndex !== -1) {
    withWriteBatch_(function () {
      Object.keys(row).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, row[key]); });
    });
    row.id = existing.id;
  } else {
    row.id = Utilities.getUuid();
    appendRowObject('Business Openings', row);
  }
  return { opening: openingOut_(row), ignored: countCutoffEntries_(clean.scope, row.currency, row.as_of) };
}

function deleteBusinessOpening(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var id = String((payload && payload.id) || '');
  var existing = businessOpenings_().filter(function (o) { return o.id === id; })[0];
  if (!existing) throw new Error(tr_('business.openingNotFound'));
  var restored = countCutoffEntries_({ project_id: existing.project_id, company_id: existing.company_id }, existing.currency, existing.as_of);
  deleteRowsWhere_('Business Openings', function (row) { return String(row.id) === id; });
  return { done: true, restored: restored };
}

// For the opening pop-up, before saving: how many entries a date would stop counting.
function getOpeningImpact(payload) {
  requireBusiness_();
  payload = payload || {};
  var scope = openingScope_(payload);
  var currency = String(payload.currency || homeCurrency_()).trim().toUpperCase();
  var asOf = validIsoDate_(payload.as_of) ? String(payload.as_of) : '';
  return { ignored: asOf ? countCutoffEntries_(scope, currency, asOf) : 0 };
}

// Called when a project or a company goes away: its openings go with it (information only, never entries).
function deleteOpeningsFor_(projectId, companyId) {
  ensureBusinessSheets_();
  ['Business Openings', 'Accountant Figures'].forEach(function (tab) {
    deleteRowsWhere_(tab, function (row) {
      return projectId ? String(row.project_id) === String(projectId) : (String(row.company_id) === String(companyId) && !row.project_id);
    });
  });
}
