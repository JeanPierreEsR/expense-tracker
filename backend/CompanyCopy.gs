/**
 * Business 2, Phase 1, piece 1 (2026-11-22): the COMPANY COPY and its welcome by sector. See specs/business.md § Company copy.
 *
 * A company copy is a copy of the app made for ONE company (the first one: a construction company). It is TEMPORARY: the goal is
 * one mixed copy (personal + companies), so everything is saved against the company (company_id), never against "this copy".
 *
 *  - The MARK. Only the owner sets it, by hand, on a copy the installer made (isFriendCopy_), never on his own copy:
 *      * the usual way, on a copy that is already installed: in that copy's Google Sheet, tab Settings, add the row
 *        `company_copy` = `yes` BEFORE the person first opens the app (the welcome reads it);
 *      * or the Script Property COMPANY_COPY = yes (Apps Script → Project settings → Script properties); seedSettings copies it
 *        into Settings when a copy is built, and isCompanyCopy_ reads it too.
 *    With the mark, the Business pack is offered and ON (unless the person later turns it off: Settings business_features = no).
 *  - The WELCOME (docs/app.js, step 2): instead of "What fits you?" it asks the company's SECTOR, its NAME and, optionally, its
 *    PROJECTS. `saveCompanySetup` saves it all in one call: the company (with its sector), its projects, and the sector's categories.
 *    The personal starter categories nobody has used yet are hidden (never deleted): the copy starts business-only.
 *  - Contributions (aportes) and loans are NEVER categories: they move balances (a loan adds to what is owed to the lender, a
 *    partner's contribution to the company's capital), never income or an expense.
 */

var COMPANY_COPY_SETTING_ = 'company_copy';
var COMPANY_COPY_PROPERTY_ = 'COMPANY_COPY';

// The sectors, in the order the welcome shows them ("other" last). A new sector = one more entry here, its texts
// (`sector.<id>` in docs/strings.js) and its category names in CATEGORY_TRANSLATIONS_ (Strings.gs).
var SECTOR_ORDER_ = ['construction', 'other'];
var SECTOR_PACKS_ = {
  construction: {
    expense: [['Materials', '🧱'], ['Labor', '👷'], ['Design & permits', '📐'], ['Notary & registries', '📜'],
      ['Loan interest', '💸'], ['Bank fees', '🧾'], ['Other', '📦']],
    income: [['Reservation deposits', '🔖'], ['Down payments', '🏷️'], ['Sale balances', '🔑'], ['Other', '📦']]
  },
  other: {
    expense: [['Supplies', '📦'], ['Salaries & fees', '👥'], ['Rent', '🏢'], ['Services & utilities', '💡'], ['Transport', '🚌'],
      ['Loan interest', '💸'], ['Bank fees', '🧾'], ['Other', '📦']],
    income: [['Sales', '🏷️'], ['Services provided', '🤝'], ['Other', '📦']]
  }
};
// The personal starter categories (Profile.gs) a company copy does not need. Hidden, never deleted, and only while nothing uses them.
var COMPANY_HIDE_STARTERS_ = {
  expense: ['groceries', 'restaurants', 'home', 'transport', 'travel'],
  income: ['salary', 'business', 'gifts']
};

function isCompanyCopy_() {
  if (!isFriendCopy_()) return false;   // never the owner's own copy, whatever a row says
  if (String(getSettingsMap()[COMPANY_COPY_SETTING_] || '') === 'yes') return true;
  return String(PropertiesService.getScriptProperties().getProperty(COMPANY_COPY_PROPERTY_) || '') === 'yes';
}

// seedSettings (Setup.gs): a copy built with the property carries the row from the start.
function companyCopySeedRows_() {
  var prop = String(PropertiesService.getScriptProperties().getProperty(COMPANY_COPY_PROPERTY_) || '');
  return isFriendCopy_() && prop === 'yes' ? [{ key: COMPANY_COPY_SETTING_, value: 'yes' }] : [];
}

/**
 * The welcome's company step. payload: { sector: 'construction' | 'other', name: 'Acme', projects: ['Obra Norte', …] }.
 * Safe to send again (a retry after a lost reply): a company or project with the same name is reused, never doubled.
 * Returns { company, projects: [..], sector, added: [{ name, type }], hidden: n }.
 */
function saveCompanySetup(payload) {
  payload = payload || {};
  if (!isCompanyCopy_()) throw codedError_('not_allowed', tr_('company.notCompanyCopy'));
  var sector = String(payload.sector || '');
  if (!SECTOR_PACKS_[sector]) throw new Error(tr_('company.errSector'));
  var name = String(payload.name || '').trim().substring(0, 60);
  if (!name) throw new Error(tr_('company.errName'));
  var projectNames = [];
  (Array.isArray(payload.projects) ? payload.projects : []).forEach(function (p) {
    p = String(p || '').trim().substring(0, 60);
    if (p && !projectNames.some(function (q) { return businessNameKey_(q) === businessNameKey_(p); })) projectNames.push(p);
  });

  if (String(getSettingsMap().business_features || '') !== 'yes') setSetting_('business_features', 'yes');
  ensureBusinessSheets_();
  ensureBusinessColumn_('Companies', 'sector', true);

  // The company: reuse one with the same name (a retry), else make it.
  var company = getAllRows('Companies').filter(function (c) { return businessNameKey_(c.name) === businessNameKey_(name); })[0];
  if (company) {
    var sheet = getSheet('Companies');
    var headers = getHeaders(sheet);
    setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, company.id), 'sector', sector);
    company.sector = sector;
  } else {
    company = { id: Utilities.getUuid(), name: name, emoji: '🏢', sector: sector };
    appendRowObject('Companies', company);
  }

  var existing = getAllRows('Projects').filter(function (p) { return String(p.company_id) === String(company.id); });
  var projects = [];
  projectNames.forEach(function (pName) {
    var same = existing.filter(function (p) { return businessNameKey_(p.name) === businessNameKey_(pName); })[0];
    if (same) { projects.push(same); return; }
    var project = { id: Utilities.getUuid(), company_id: company.id, name: pName, emoji: '', status: 'active', client_id: '' };
    appendRowObject('Projects', project);
    projects.push(project);
  });

  var cats = applySectorPack_(sector);
  if (ROWS_MEMO_) { delete ROWS_MEMO_['Companies']; delete ROWS_MEMO_['Projects']; }
  bumpStructureVersion_();
  return { company: company, projects: projects, sector: sector, added: cats.added, hidden: cats.hidden };
}

// Adds the sector's categories (a hidden one with the same name is shown again) and hides the personal starters nobody used.
function applySectorPack_(sector) {
  var pack = SECTOR_PACKS_[sector];
  var headers = ensureCategoriesHiddenColumn_();
  var sheet = getSheet('Categories');
  var cats = getAllRows('Categories');
  var wantedKeys = {};
  ['expense', 'income'].forEach(function (type) {
    (pack[type] || []).forEach(function (c) { wantedKeys[type + ':' + categoryKeyFromName_(c[0])] = true; });
  });

  // 1. Hide the personal starters the sector does not use, only while no entry, budget or Programmed item points at them.
  var used = {};
  ['Entries', 'Budgets', 'Recurring Expenses'].forEach(function (tab) {
    var rows = [];
    try { rows = getAllRows(tab); } catch (err) { rows = []; }   // a tab a copy does not have yet
    rows.forEach(function (r) { if (r.category_id) used[String(r.category_id)] = true; });
  });
  var hidden = 0;
  cats.forEach(function (c) {
    var list = COMPANY_HIDE_STARTERS_[c.type];
    if (!list || list.indexOf(String(c.key || '')) === -1) return;
    if (wantedKeys[c.type + ':' + c.key] || used[String(c.id)] || String(c.hidden || '') === 'yes') return;
    setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, c.id), 'hidden', 'yes');
    c.hidden = 'yes';
    hidden++;
  });

  // 2. Add the sector's categories: shown again when hidden, made when missing.
  var rows = [], added = [];
  ['expense', 'income'].forEach(function (type) {
    (pack[type] || []).forEach(function (c) {
      if (starterVisible_(cats.concat(rows), type, c[0])) return;
      var hiddenRow = starterHiddenRow_(cats, type, c[0]);
      if (hiddenRow) {
        setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, hiddenRow.id), 'hidden', '');
        hiddenRow.hidden = '';
        return;
      }
      var n = cats.length + rows.length;
      rows.push({ id: Utilities.getUuid(), name: c[0], type: type, icon: c[1], color: CATEGORY_COLOR_PALETTE[n % CATEGORY_COLOR_PALETTE.length],
        parent_id: '', key: categoryKeyFromName_(c[0]), hidden: '' });
      added.push({ name: categoryLabel_({ key: categoryKeyFromName_(c[0]), name: c[0] }), type: type });
    });
  });
  if (rows.length) appendRowsBulk_('Categories', rows);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  return { added: added, hidden: hidden };
}

// ---- Piece 2: everything belongs to the company (Business 2 plan, 2026-11-22) ----
// On a company copy with exactly ONE company, every new expense or income belongs to it, whatever made it (the "+" form,
// bank e-mails, Apple Pay, the bots, photos, statements), and Confirm checks again. Two or more companies: nothing is
// guessed (''). Outside a company copy: always '' (the owner's and friends' copies never change).
function defaultCompanyId_() {
  if (!isCompanyCopy_() || !businessOn_()) return '';
  var ids = getCompanyRows_().map(function (c) { return String(c.id || ''); }).filter(function (id) { return id; });
  return ids.length === 1 ? ids[0] : '';
}

// Called for every row written to Entries (appendRowObject, appendRowsBulk_). A row that already says something about its
// company (the "+" form sends '' for "Personal") is left alone; so are transfers, investments, practice entries and an
// income not received yet (it may not belong to a company: checkWaitingIncome_).
function companyDefaultForNewEntry_(obj, headers) {
  if (!obj || (obj.type !== 'expense' && obj.type !== 'income')) return;
  if (obj.company_id !== undefined || obj.project_id !== undefined) return;
  if (headers.indexOf('company_id') === -1 || headers.indexOf('project_id') === -1) return;
  if (obj.income_waiting || isPracticeEntry_(obj)) return;
  var id = defaultCompanyId_();
  if (id) { obj.company_id = id; obj.project_id = ''; }
}

// Confirm's second check (confirmEntryWithLearning_): an expense or income still with no company gets it, unless the person
// chose "Personal" on the card or in the form (`personal`).
function companyDefaultOnConfirm_(entry, personal) {
  if (personal || !entry || (entry.type !== 'expense' && entry.type !== 'income')) return;
  if (entry.company_id || entry.project_id || String(entry.income_waiting || '') !== '') return;
  var id = defaultCompanyId_();
  if (id) setEntryField_(entry.id, 'company_id', id);
}

// ---- Piece 4: the company's Overview (Business 2 plan, 2026-11-22) ----
// Two of its three cards, sent with getPeriodSummary so Overview needs no extra call (the third is the Balances card as it is):
// owed = every LENDER (Business 2 piece 3; SUNAT's withholding included) with what the company still owes them, per currency, never
// converted, by name; owedTotals = the same added per currency. funding = every project still open with the amount "still to finance"
// the person typed and the day it was true (the app never works it out: owner, plan "Fase 1 en detalle", answer 4: one per project).
function companyOverview_(startDate, endDate) {
  var owed = [], totals = {};
  // Lenders AND partners (owner, 2026-11-24: the card read as the company's whole debt and left out ~31,000 owed to partners); the
  // tax office's withholding shows as what it is. A period that ended shows what was owed on its last day, so a statement shared
  // for a past month never changes afterwards (testers 2.68.2, Elena).
  var past = endDate && String(endDate).slice(0, 10) < businessToday_() ? String(endDate).slice(0, 10) : '';
  var asOf = past ? owedAsOf_(past) : null;
  var sunatId = companySunatId_();
  listLoanBalances({}).forEach(function (f) {
    if (f.role !== 'lender' && f.role !== 'partner') return;
    var nets = asOf ? (asOf[f.friend_id] || {}) : null;
    var lines = (nets ? Object.keys(nets).map(function (c) { return { currency: c, net: nets[c] }; }) : f.balances)
      .filter(function (b) { return b.net < -0.004; })
      .map(function (b) { return { currency: b.currency, amount: round2_(-b.net) }; });
    if (!lines.length) return;
    lines.forEach(function (l) { totals[l.currency] = round2_((totals[l.currency] || 0) + l.amount); });
    owed.push({ friend_id: f.friend_id, name: f.friend_id === sunatId ? tr_('coOv.sunatOwed') : f.friend_name, role: f.role, lines: lines });
  });
  owed.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  var home = homeCurrency_();
  var owedTotals = Object.keys(totals).sort(function (a, b) { return a === home ? -1 : (b === home ? 1 : (a < b ? -1 : 1)); })
    .map(function (c) { return { currency: c, amount: totals[c] }; });
  var funding = getProjectRows_().filter(function (p) { return String(p.status || 'active') !== 'closed'; }).map(function (p) {
    var has = p.funding_gap !== undefined && p.funding_gap !== '' && p.funding_gap !== null;
    return { project_id: String(p.id), company_id: String(p.company_id || ''), name: String(p.name || ''), emoji: String(p.emoji || ''),
      amount: has ? Number(p.funding_gap) : null, currency: String(p.funding_currency || home), as_of: has ? String(p.funding_as_of || '') : '' };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { owed: owed, owedTotals: owedTotals, funding: funding, partners: companyPartners_(startDate, endDate), partnersPending: pendingContributions_(), sales: companySales_(),   // piece 11 (Sales.gs)
    share_sections: shareSectionsSaved_(),   // piece 12 (ShareStatement.gs): the sections the share sheet opens with
    close: wholeMonthOf_(startDate, endDate) ? monthCloseState_(wholeMonthOf_(startDate, endDate)) : null };   // piece 8 (MonthClose.gs)   // piece 7 (Partners.gs)
}

// The tax office's withholding person (BankLoans.gs withholdingPersonId_), by name, without making it: '' when there is none.
function companySunatId_() {
  var name = String(tr_('bank.withholdingPerson')).trim().toLowerCase();
  var f = getAllRows('Friends').find(function (x) { return String(x.name).trim().toLowerCase() === name; });
  return f ? String(f.id) : '';
}

// What was owed with each person on `day`, per currency (they owe me = positive, I owe them = negative): loans dated up to that day,
// less the repayments, offsets and forgiving dated up to that day. For the company's cards of a period that has ended.
function owedAsOf_(day) {
  var paid = {};
  getAllRows('Settlements').forEach(function (s) {
    if (String(s.date).slice(0, 10) > day) return;
    paid[s.loan_id] = (paid[s.loan_id] || 0) + (Number(s.amount) || 0);
  });
  var entryDate = {};
  getAllRows('Entries').forEach(function (e) { entryDate[e.id] = String(e.date).slice(0, 10); });
  var out = {};
  getAllRows('Loans').forEach(function (l) {
    if (String(l.date).slice(0, 10) > day) return;
    var left = (Number(l.amount) || 0) - (paid[l.id] || 0);
    loanForgivenParts_(l).forEach(function (p) { if (String(p.date || '').slice(0, 10) <= day) left -= Number(p.amount) || 0; });
    if (l.status === 'forgiven' && l.forgiveness_entry_id && (entryDate[l.forgiveness_entry_id] || '9999') <= day) left = 0;
    if (Math.abs(left) < 0.005) return;
    var cur = String(l.currency || homeCurrency_());
    var byCur = out[l.friend_id] || (out[l.friend_id] = {});
    byCur[cur] = round2_((byCur[cur] || 0) + (l.direction === 'i_owe_them' ? -left : left));
  });
  return out;
}

// "Still to finance" for one project: a figure the person types and updates when they like, with the day it is true. Blank amount clears it.
// payload: { project_id, amount, currency, as_of }
function setProjectFunding(payload) {
  requireBusiness_();
  var project = projectById_(payload && payload.project_id);
  if (!project) throw new Error(tr_('business.projectNotFound'));
  var blank = payload.amount === '' || payload.amount === null || payload.amount === undefined;
  var amount = blank ? '' : Number(payload.amount);
  if (!blank && !(isFinite(amount) && amount >= 0)) throw new Error(tr_('err.validAmount'));
  var asOf = String(payload.as_of || '');
  if (!blank && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(tr_('err.dateRequired'));
  ensureBusinessSheets_();
  ensureBusinessColumn_('Projects', 'funding_gap', false);
  ensureBusinessColumn_('Projects', 'funding_currency', true);
  ensureBusinessColumn_('Projects', 'funding_as_of', true);   // a date as TEXT (Sheets would turn it into a Date)
  var sheet = getSheet('Projects');
  var headers = getHeaders(sheet);
  var row = findRowIndexById(sheet, headers, project.id);
  setCellByRow_(sheet, headers, row, 'funding_gap', blank ? '' : round2_(amount));
  setCellByRow_(sheet, headers, row, 'funding_currency', blank ? '' : String(payload.currency || homeCurrency_()).toUpperCase());
  setCellByRow_(sheet, headers, row, 'funding_as_of', blank ? '' : asOf);
  return { done: true };
}
