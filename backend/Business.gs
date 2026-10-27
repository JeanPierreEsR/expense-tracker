/**
 * Business pack, step 1 (2026-10-26) — companies, projects and a per-currency profit and loss.
 * See specs/business.md.
 *
 * OPT-IN, OFF BY DEFAULT (owner's rule): everything here is switched on by the Settings row
 * `business_features` = 'yes' (More → Business features, or the welcome question). While it is off nothing in this
 * file reads or writes a sheet, `getMeta` carries no companies/projects, every action answers with a plain sentence,
 * and the link fields in a payload are ignored. Turning it off later deletes nothing.
 *
 * A company or project is only a LABEL on entries (Entries.company_id / Entries.project_id), never a separate account:
 * the owner mixes business and personal money in the same bank accounts. A project belongs to exactly one company.
 * Only a confirmed EXPENSE (counted at the owner's share) or INCOME can be linked. Every figure is kept in the
 * entry's own currency and never converted; one optional "≈ in the main currency" total is derived from the rate
 * table (CLAUDE.md principles 5 and 8).
 */

// Created on first use (not in TABLE_DEFINITIONS, so a copy that never opts in never gets these tabs).
var BUSINESS_TABLES_ = {
  'Companies': ['id', 'name', 'emoji'],
  'Projects': ['id', 'company_id', 'name', 'emoji', 'status'],
  'Project Budgets': ['id', 'project_id', 'currency', 'amount']
};

var PROJECT_STATUSES_ = { active: true, closed: true };
var businessEnsured_ = false;   // per execution: the tabs/columns are checked once

function businessOn_() {
  return String(getSettingsMap().business_features || '') === 'yes';
}

// Business actions answer with a plain sentence while the pack is off (like requireFeature_).
function requireBusiness_() {
  if (businessOn_()) return;
  var err = new Error(tr_('business.off'));
  err.code = 'feature_off';
  throw err;
}

function ensureBusinessSheets_() {
  if (businessEnsured_) return;
  businessEnsured_ = true;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(BUSINESS_TABLES_).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var sheet = ss.insertSheet(name);
    var headers = BUSINESS_TABLES_[name];
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  ensureColumn_('Entries', 'company_id');
  ensureColumn_('Entries', 'project_id');
}

// The switch itself (More → Business features, welcome question). Turning it off keeps every row.
function setBusinessFeatures(payload) {
  var on = !!payload && (payload.on === true || payload.on === 'yes');
  setSetting_('business_features', on ? 'yes' : 'no');
  if (on) ensureBusinessSheets_();
  return { business: on, capabilities: getCapabilities_() };
}

function getCompanyRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Companies');
}

function getProjectRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Projects');
}

function getProjectBudgetRows_() {
  if (!businessOn_()) return [];
  ensureBusinessSheets_();
  return getAllRowsCached_('Project Budgets');
}

function companyById_(id) {
  var found = null;
  getCompanyRows_().forEach(function (c) { if (String(c.id) === String(id)) found = c; });
  return found;
}

function projectById_(id) {
  var found = null;
  getProjectRows_().forEach(function (p) { if (String(p.id) === String(id)) found = p; });
  return found;
}

// What an entry may carry: only an expense or income, only while the pack is on, only ids that exist. A project
// forces its own company. Returns { project_id, company_id } (both '' = personal).
function businessLinkFor_(type, projectId, companyId) {
  var none = { project_id: '', company_id: '' };
  if (!businessOn_() || (type !== 'expense' && type !== 'income')) return none;
  var project = projectId ? projectById_(projectId) : null;
  if (project) return { project_id: String(project.id), company_id: String(project.company_id) };
  var company = companyId ? companyById_(companyId) : null;
  return company ? { project_id: '', company_id: String(company.id) } : none;
}

// The fields of an entry update, with the business link cleaned. The app sends BOTH keys whenever it touches the link
// (a missing one counts as blank). A conversion to a type that cannot carry a link (transfer, investment) clears it
// whether or not the pack is on, so a hidden label never survives on the wrong kind of entry.
function businessFieldsForUpdate_(entryId, fields) {
  fields = fields || {};
  var touches = fields.project_id !== undefined || fields.company_id !== undefined;
  var typeChanges = fields.type !== undefined && fields.type !== 'expense' && fields.type !== 'income';
  if (!touches && !typeChanges) return fields;
  var out = Object.assign({}, fields);
  delete out.project_id;
  delete out.company_id;
  var headers = getHeaders(getSheet('Entries'));
  var hasColumns = headers.indexOf('project_id') !== -1 && headers.indexOf('company_id') !== -1;
  if (typeChanges) {
    if (hasColumns) { out.project_id = ''; out.company_id = ''; }
    return out;
  }
  if (!touches || !businessOn_()) return out;     // while off, a link in the payload is ignored
  var existing = getEntryById_(entryId);
  var link = businessLinkFor_(fields.type || (existing && existing.type), fields.project_id, fields.company_id);
  ensureBusinessSheets_();
  out.project_id = link.project_id;
  out.company_id = link.company_id;
  return out;
}

// getPeriodSummary / Overview filter: 'all' (or blank), 'personal', 'company:<id>', 'project:<id>'. Ignored while off.
function filterEntriesByScope_(entries, scope) {
  scope = String(scope || '');
  if (!scope || scope === 'all' || !businessOn_()) return entries;
  if (scope === 'personal') return entries.filter(function (e) { return !e.company_id && !e.project_id; });
  var parts = scope.split(':');
  var id = parts.slice(1).join(':');
  if (parts[0] === 'company') return entries.filter(function (e) { return String(e.company_id || '') === id; });
  if (parts[0] === 'project') return entries.filter(function (e) { return String(e.project_id || '') === id; });
  return entries;
}

// ---- Input checks ----

function businessNameKey_(s) { return searchNormalize_(String(s || '').trim()); }

function cleanCompanyInput_(p, ownId) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error(tr_('err.enterName'));
  getCompanyRows_().forEach(function (c) {
    if (String(c.id) !== String(ownId || '') && businessNameKey_(c.name) === businessNameKey_(name)) {
      throw new Error(tr_('business.errCompanyExists'));
    }
  });
  return { name: name, emoji: String(p.emoji || '').trim() };
}

function cleanBudgetsInput_(list) {
  var seen = {};
  var out = [];
  (list || []).forEach(function (b) {
    var cur = String((b && b.currency) || '').trim().toUpperCase();
    var raw = b && b.amount;
    if (!cur && (raw === undefined || raw === null || String(raw).trim() === '')) return;   // an empty row
    if (!/^[A-Z]{3}$/.test(cur)) throw new Error(tr_('err.currencyCode'));
    var n = Number(raw);
    if (!isFinite(n) || n <= 0) throw new Error(tr_('business.errBudget'));
    if (seen[cur]) throw new Error(tr_('business.errBudgetDuplicate'));
    seen[cur] = true;
    out.push({ currency: cur, amount: n });
  });
  return out;
}

function writeProjectBudgets_(projectId, budgets) {
  deleteRowsWhere_('Project Budgets', function (row) { return String(row.project_id) === String(projectId); });
  budgets.forEach(function (b) {
    appendRowObject('Project Budgets', { id: Utilities.getUuid(), project_id: projectId, currency: b.currency, amount: b.amount });
  });
}

function entriesUsing_(field, id) {
  var n = 0;
  getAllRows('Entries').forEach(function (e) { if (String(e[field] || '') === String(id)) n++; });
  return n;
}

// ---- Companies and projects ----

function addCompany(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var company = cleanCompanyInput_(payload || {}, '');
  company.id = Utilities.getUuid();
  appendRowObject('Companies', company);
  return company;
}

function updateCompany(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var sheet = getSheet('Companies');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error(tr_('business.companyNotFound'));
  var clean = cleanCompanyInput_(payload, payload.id);
  withWriteBatch_(function () {
    Object.keys(clean).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, clean[key]); });
  });
  clean.id = payload.id;
  return clean;
}

// A company that still has projects or entries is kept (nothing is ever deleted behind the owner's back).
function deleteCompany(payload) {
  requireBusiness_();
  var id = String((payload && payload.id) || '');
  if (!companyById_(id)) throw new Error(tr_('business.companyNotFound'));
  var hasProjects = getProjectRows_().some(function (p) { return String(p.company_id) === id; });
  if (hasProjects || entriesUsing_('company_id', id) > 0) throw new Error(tr_('business.errCompanyInUse'));
  deleteRowsWhere_('Companies', function (row) { return String(row.id) === id; });
  return { done: true };
}

function cleanProjectInput_(p, ownId, ownCompanyId) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error(tr_('err.enterName'));
  var companyId = String(p.company_id || ownCompanyId || '');
  if (!companyById_(companyId)) throw new Error(tr_('business.companyNotFound'));
  getProjectRows_().forEach(function (o) {
    if (String(o.id) !== String(ownId || '') && String(o.company_id) === companyId && businessNameKey_(o.name) === businessNameKey_(name)) {
      throw new Error(tr_('business.errProjectExists'));
    }
  });
  var status = PROJECT_STATUSES_[p.status] ? p.status : 'active';
  return { company_id: companyId, name: name, emoji: String(p.emoji || '').trim(), status: status };
}

function addProject(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  payload = payload || {};
  var project = cleanProjectInput_(payload, '', '');
  var budgets = cleanBudgetsInput_(payload.budgets);
  project.id = Utilities.getUuid();
  appendRowObject('Projects', project);
  writeProjectBudgets_(project.id, budgets);
  project.budgets = budgets;
  return project;
}

function updateProject(payload) {
  requireBusiness_();
  ensureBusinessSheets_();
  var sheet = getSheet('Projects');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error(tr_('business.projectNotFound'));
  var existing = projectById_(payload.id);
  var clean = cleanProjectInput_(payload, payload.id, existing.company_id);
  // A project with entries stays in its company: moving it would silently move their company label too.
  if (clean.company_id !== String(existing.company_id) && entriesUsing_('project_id', payload.id) > 0) {
    throw new Error(tr_('business.errProjectMove'));
  }
  var budgets = payload.budgets === undefined ? null : cleanBudgetsInput_(payload.budgets);
  withWriteBatch_(function () {
    Object.keys(clean).forEach(function (key) { setCellByRow_(sheet, headers, rowIndex, key, clean[key]); });
    if (budgets) writeProjectBudgets_(payload.id, budgets);
  });
  clean.id = payload.id;
  return clean;
}

// Deleting a project never deletes entries: they keep their company and lose the project.
function deleteProject(payload) {
  requireBusiness_();
  var id = String((payload && payload.id) || '');
  if (!projectById_(id)) throw new Error(tr_('business.projectNotFound'));
  var entrySheet = getSheet('Entries');
  var entryHeaders = getHeaders(entrySheet);
  var col = entryHeaders.indexOf('project_id');
  withWriteBatch_(function () {
    if (col !== -1 && entrySheet.getLastRow() >= 2) {
      entrySheet.getRange(2, col + 1, entrySheet.getLastRow() - 1, 1).getValues().forEach(function (row, i) {
        if (String(row[0]) === id) setCellByRow_(entrySheet, entryHeaders, i + 2, 'project_id', '');
      });
    }
    deleteRowsWhere_('Project Budgets', function (row) { return String(row.project_id) === id; });
    deleteRowsWhere_('Projects', function (row) { return String(row.id) === id; });
  });
  return { done: true };
}

// ---- Per-currency profit and loss ----

function round2_(n) { return Math.round(n * 100) / 100; }

// The confirmed expense/income entries a screen counts: income in full, an expense at the owner's share, both in
// the entry's own currency. `match` picks the entries; the period is optional (blank = all time).
function businessRows_(match, startDate, endDate) {
  var splitSum = {};
  getAllRows('Entry Splits').forEach(function (s) {
    splitSum[s.entry_id] = (splitSum[s.entry_id] || 0) + Number(s.amount);
  });
  var rows = [];
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || (e.type !== 'expense' && e.type !== 'income')) return;
    if (!e.company_id && !e.project_id) return;
    if (startDate && e.date < startDate) return;
    if (endDate && e.date > endDate) return;
    if (!match(e)) return;
    var own = e.type === 'expense' ? Number(e.amount) - (splitSum[e.id] || 0) : Number(e.amount);
    rows.push({ entry: e, own: own, currency: e.currency || homeCurrency_() });
  });
  return rows;
}

function orderedCurrencies_(map) {
  var main = homeCurrency_();
  return Object.keys(map).sort(function (a, b) {
    if (a === main) return -1;
    if (b === main) return 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

// Income, costs and margin per currency (never converted), plus one optional converted total.
function businessTotals_(rows, budgetByCurrency) {
  var cur = {};
  var approx = { income: 0, costs: 0, missing: 0 };
  rows.forEach(function (r) {
    var c = cur[r.currency] || (cur[r.currency] = { currency: r.currency, income: 0, costs: 0 });
    var isCost = r.entry.type === 'expense';
    if (isCost) c.costs += r.own; else c.income += r.own;
    var rate = getRateForEntryCurrency_(r.currency, r.entry.date);
    if (rate == null) { approx.missing++; return; }
    if (isCost) approx.costs += r.own * rate; else approx.income += r.own * rate;
  });
  budgetByCurrency = budgetByCurrency || {};
  Object.keys(budgetByCurrency).forEach(function (k) {
    if (!cur[k]) cur[k] = { currency: k, income: 0, costs: 0 };
  });
  var currencies = orderedCurrencies_(cur).map(function (k) {
    var c = cur[k];
    var out = { currency: k, income: round2_(c.income), costs: round2_(c.costs), margin: round2_(c.income - c.costs), budget: null, budgetPct: null };
    if (budgetByCurrency[k] > 0) {
      out.budget = budgetByCurrency[k];
      out.budgetPct = Math.round(c.costs / budgetByCurrency[k] * 100);
    }
    return out;
  });
  return {
    currencies: currencies,
    approx: { currency: homeCurrency_(), income: round2_(approx.income), costs: round2_(approx.costs), margin: round2_(approx.income - approx.costs), missing: approx.missing },
    entryCount: rows.length
  };
}

// Costs and income by category, one list per currency.
function businessByCategory_(rows) {
  var categoryById = rowsById_(localizeCategories_(getAllRowsCached_('Categories')));
  var acc = { expense: {}, income: {} };
  rows.forEach(function (r) {
    var byCur = acc[r.entry.type][r.currency] || (acc[r.entry.type][r.currency] = {});
    var id = r.entry.category_id || '';
    byCur[id] = (byCur[id] || 0) + r.own;
  });
  var out = { expense: {}, income: {} };
  ['expense', 'income'].forEach(function (type) {
    Object.keys(acc[type]).forEach(function (currency) {
      var byCat = acc[type][currency];
      var total = 0;
      Object.keys(byCat).forEach(function (id) { total += byCat[id]; });
      out[type][currency] = Object.keys(byCat).map(function (id) {
        var cat = categoryById[id];
        return {
          id: id, name: cat ? cat.name : tr_('report.uncategorized'), icon: cat ? cat.icon : '', color: cat ? cat.color : '',
          amount: round2_(byCat[id]), pct: total > 0 ? Math.round(byCat[id] / total * 1000) / 10 : 0
        };
      }).sort(function (a, b) { return b.amount - a.amount; });
    });
  });
  return out;
}

function budgetsOfProject_(projectId) {
  var map = {};
  getProjectBudgetRows_().forEach(function (b) {
    if (String(b.project_id) === String(projectId)) map[String(b.currency).toUpperCase()] = Number(b.amount);
  });
  return map;
}

function getProjectDetail(payload) {
  requireBusiness_();
  var project = projectById_(payload && payload.id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var company = companyById_(project.company_id);
  var rows = businessRows_(function (e) { return String(e.project_id || '') === String(project.id); }, payload.startDate, payload.endDate);
  var totals = businessTotals_(rows, budgetsOfProject_(project.id));
  return {
    project: { id: project.id, name: project.name, emoji: project.emoji, status: project.status || 'active', company_id: project.company_id },
    company: company ? { id: company.id, name: company.name, emoji: company.emoji } : null,
    currencies: totals.currencies, approx: totals.approx, entryCount: totals.entryCount,
    byCategory: businessByCategory_(rows)
  };
}

function getCompanyDetail(payload) {
  requireBusiness_();
  var company = companyById_(payload && payload.id);
  if (!company) throw new Error(tr_('business.companyNotFound'));
  var rows = businessRows_(function (e) { return String(e.company_id || '') === String(company.id); }, payload.startDate, payload.endDate);
  var totals = businessTotals_(rows, null);
  var projects = getProjectRows_().filter(function (p) { return String(p.company_id) === String(company.id); }).map(function (p) {
    var mine = rows.filter(function (r) { return String(r.entry.project_id || '') === String(p.id); });
    var t = businessTotals_(mine, budgetsOfProject_(p.id));
    return { id: p.id, name: p.name, emoji: p.emoji, status: p.status || 'active', currencies: t.currencies, approx: t.approx, entryCount: t.entryCount };
  });
  var levelRows = rows.filter(function (r) { return !r.entry.project_id; });
  var level = businessTotals_(levelRows, null);
  return {
    company: { id: company.id, name: company.name, emoji: company.emoji },
    currencies: totals.currencies, approx: totals.approx, entryCount: totals.entryCount,
    projects: projects,
    companyLevel: { currencies: level.currencies, approx: level.approx, entryCount: level.entryCount },
    byCategory: businessByCategory_(rows)
  };
}

// The More → Companies & projects list: each company with its projects and the period's margin per currency.
function listCompaniesAndProjects(payload) {
  requireBusiness_();
  payload = payload || {};
  var companies = getCompanyRows_();
  var projects = getProjectRows_();
  var rows = companies.length ? businessRows_(function () { return true; }, payload.startDate, payload.endDate) : [];
  return companies.map(function (c) {
    var mine = rows.filter(function (r) { return String(r.entry.company_id || '') === String(c.id); });
    var t = businessTotals_(mine, null);
    return {
      id: c.id, name: c.name, emoji: c.emoji, currencies: t.currencies, approx: t.approx, entryCount: t.entryCount,
      projects: projects.filter(function (p) { return String(p.company_id) === String(c.id); }).map(function (p) {
        var pr = mine.filter(function (r) { return String(r.entry.project_id || '') === String(p.id); });
        var pt = businessTotals_(pr, budgetsOfProject_(p.id));
        return { id: p.id, name: p.name, emoji: p.emoji, status: p.status || 'active', currencies: pt.currencies, approx: pt.approx, entryCount: pt.entryCount };
      })
    };
  });
}
