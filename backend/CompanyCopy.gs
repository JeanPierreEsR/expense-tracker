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
