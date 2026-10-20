/**
 * More → Categories: create, change, hide and delete a category.
 * Only top-level expense / income categories are managed here (no sub-categories —
 * owner's decision 2026-10-19; the `parent_id` column is left alone).
 * Spec: specs/entries-and-categories.md § Categories.
 */

var MANAGED_CATEGORY_TYPES_ = ['expense', 'income'];
var CATEGORY_DEFAULT_ICON_ = '🏷️';

// The `hidden` column is appended to older sheets the first time it is needed
// (same self-heal as Payment Methods). Returns the up-to-date headers.
function ensureCategoriesHiddenColumn_() {
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  if (headers.indexOf('hidden') === -1) {
    sheet.getRange(1, headers.length + 1).setValue('hidden');
    headers.push('hidden');
    if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  }
  return headers;
}

// Lowercase, no accents, single spaces — so "Café " and "cafe" count as the same name.
function categoryNameKey_(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanCategoryInput_(payload, existing) {
  var name = String(payload.name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error(tr_('err.enterName'));
  if (name.length > 40) throw new Error(tr_('err.catNameLong'));
  var type = existing ? existing.type : String(payload.type || '').trim().toLowerCase();
  if (MANAGED_CATEGORY_TYPES_.indexOf(type) === -1) throw new Error(tr_('err.catType'));
  var icon = String(payload.icon || '').trim() || CATEGORY_DEFAULT_ICON_;
  // An emoji (or a few): anything with a letter or digit in it is not one.
  if (icon.length > 12 || /[\p{L}\p{N}]/u.test(icon)) throw new Error(tr_('err.catIcon'));
  var color = String(payload.color || '').trim();
  if (!color) color = CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length];
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(tr_('err.catColor'));
  var wanted = categoryNameKey_(name);
  var clash = getAllRows('Categories').some(function (c) {
    if (c.type !== type || (existing && String(c.id) === String(existing.id))) return false;
    return categoryNameKey_(c.name) === wanted || categoryNameKey_(categoryLabel_(c, 'en')) === wanted || categoryNameKey_(categoryLabel_(c, 'es')) === wanted;
  });
  if (clash) throw new Error(tr_('err.catExists', { name: name }));
  return { name: name, type: type, icon: icon, color: color };
}

// Create (no id) or change (id) a category. The type of a saved category never changes:
// entries of one type can only use categories of the same type.
function saveCategory(payload) {
  payload = payload || {};
  var headers = ensureCategoriesHiddenColumn_();
  var sheet = getSheet('Categories');
  if (!payload.id) {
    var clean = cleanCategoryInput_(payload, null);
    var row = { id: Utilities.getUuid(), name: clean.name, type: clean.type, icon: clean.icon, color: clean.color, parent_id: '', key: '', hidden: '' };
    appendRowObject('Categories', row);
    bumpStructureVersion_();
    return row;
  }
  var id = String(payload.id);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex === -1) throw new Error(tr_('err.catNotFound'));
  var existing = getAllRows('Categories').find(function (c) { return String(c.id) === id; });
  var edited = cleanCategoryInput_(payload, existing);
  // Leaving the name as it was keeps a built-in's translation; any other name shows as typed.
  var keepName = String(payload.name || '').trim() === String(categoryLabel_(existing)).trim();
  if (keepName) edited.name = existing.name;
  withWriteBatch_(function () {
    ['name', 'icon', 'color'].forEach(function (k) { setCellByRow_(sheet, headers, rowIndex, k, edited[k]); });
  });
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return { id: id, name: edited.name, type: existing.type, icon: edited.icon, color: edited.color };
}

// How many records point at a category. Counts every place that stores its id.
function categoryUsage_(id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var n = 0;
  [['Entries', 'category_id'], ['Recurring Expenses', 'category_id'], ['Projection Overrides', 'category_id'],
   ['Categories', 'parent_id']].forEach(function (spec) {
    if (!ss.getSheetByName(spec[0])) return;
    getAllRows(spec[0]).forEach(function (r) { if (String(r[spec[1]] || '') === id) n++; });
  });
  if (ss.getSheetByName('Budgets')) {
    getAllRows('Budgets').forEach(function (b) {
      var ids = parseBudgetCategoryIds_(b.category_id);
      if (ids !== null && ids.indexOf(id) !== -1) n++;
    });
  }
  return n;
}

function managedCategoryRow_(id) {
  var cat = getAllRows('Categories').find(function (c) { return String(c.id) === id; });
  if (!cat) throw new Error(tr_('err.catNotFound'));
  // "Other" is the fallback everywhere; transfer / investment categories belong to the app itself.
  if (cat.key === 'other' || MANAGED_CATEGORY_TYPES_.indexOf(cat.type) === -1) throw new Error(tr_('err.catProtected'));
  return cat;
}

// Delete a category nobody uses (an unused one holds no history). One in use is refused
// with a count and the owner hides it instead. Its learned e-mail keywords go with it.
function deleteCategory(payload) {
  var id = String((payload && payload.id) || '');
  var cat = managedCategoryRow_(id);
  var used = categoryUsage_(id);
  if (used > 0) throw new Error(tr_('err.catInUse', { n: used }));
  deleteRowsWhere_('Category Keywords', function (r) { return String(r.category_name) === String(cat.name); });
  deleteRowsWhere_('Categories', function (r) { return String(r.id) === id; });
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return { id: id, deleted: true };
}

// Hide / show. A hidden category keeps its row (past records still show its name and icon)
// but the phone leaves it out of every "pick a category" list.
function setCategoryHidden(payload) {
  var id = String((payload && payload.id) || '');
  managedCategoryRow_(id);
  var headers = ensureCategoriesHiddenColumn_();
  var sheet = getSheet('Categories');
  var rowIndex = findRowIndexById(sheet, headers, id);
  var hidden = payload.hidden === true || payload.hidden === 'yes' ? 'yes' : '';
  setCellByRow_(sheet, headers, rowIndex, 'hidden', hidden);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return { id: id, hidden: hidden };
}
