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
    if (row.type === 'income' && payload.income_kind) { setCategoryIncomeKind_(row.id, payload.income_kind); row.income_kind = payload.income_kind; }   // IncomeVaries.gs
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
  if (existing.type === 'income' && payload.income_kind) setCategoryIncomeKind_(id, payload.income_kind);   // regular / varies / none
  // Learned e-mail keywords point at a category by its stored name: follow a rename.
  if (edited.name !== existing.name) {
    rewriteColumn_('Category Keywords', 'category_name', function (v) {
      return String(v) === String(existing.name) ? edited.name : v;
    }, false);
  }
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

// How many entries each category holds, for the Categories screen ("12 entries").
// Counts every entry row, pending ones included — the same rows a delete would move.
function getCategoryCounts() {
  var counts = {};
  getAllRows('Entries').forEach(function (e) {
    var id = String(e.category_id || '');
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  return { counts: counts };
}

// Delete a category. Unused: just removed. In use: refused with a count unless
// `reassign_to` names another category of the same type, in which case everything that
// pointed at it (entries, programmed items, budgets) moves there first. Its learned
// e-mail keywords and manual projection overrides go with it (an override is a number
// typed for that one category, so it has nowhere to move to).
function deleteCategory(payload) {
  var id = String((payload && payload.id) || '');
  var cat = managedCategoryRow_(id);
  var used = categoryUsage_(id);
  var target = null;
  if (used > 0) {
    var targetId = String((payload && payload.reassign_to) || '');
    if (!targetId) throw new Error(tr_('err.catInUse', { n: used }));
    target = getAllRows('Categories').find(function (c) { return String(c.id) === targetId; });
    if (!target || targetId === id) throw new Error(tr_('err.catNotFound'));
    if (target.type !== cat.type) throw new Error(tr_('err.catReassignType'));
  }
  var moved = 0;
  if (target) {
    var swap = function (v) { return String(v) === id ? target.id : v; };
    moved = rewriteColumn_('Entries', 'category_id', swap, false).changed;
    rewriteColumn_('Recurring Expenses', 'category_id', swap, false);
    rewriteColumn_('Categories', 'parent_id', function (v) { return String(v) === id ? '' : v; }, false);
    rewriteColumn_('Budgets', 'category_id', function (v) {
      var ids = parseBudgetCategoryIds_(v);
      if (ids === null || ids.indexOf(id) === -1) return v;
      var out = [];
      ids.forEach(function (x) { x = x === id ? String(target.id) : x; if (out.indexOf(x) === -1) out.push(x); });
      return out.join(',');
    }, false);
    deleteRowsWhere_('Projection Overrides', function (r) { return String(r.category_id) === id; });
  }
  deleteRowsWhere_('Category Keywords', function (r) { return String(r.category_name) === String(cat.name); });
  deleteRowsWhere_('Categories', function (r) { return String(r.id) === id; });
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return { id: id, deleted: true, moved: moved };
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

// ---- Several categories at once (More → Categories → Edit, owner's request 2026-11-03) ----
// A category in use cannot just disappear: what points at it must go somewhere, or the category is hidden instead. So deleting a batch is decided in
// two steps: previewCategoryDelete says what each one is used by; deleteCategories then applies ONE answer for the batch — everything in use moves into
// ONE chosen category per type (`reassign: { expense: id, income: id }`), or `hideUsed: true` hides the ones in use and nothing moves. Unused ones are simply
// deleted either way. The built-in "Other" and anything that is not an expense / income category are never touched.

// For each id, how many entries use it and how many records of any kind (entries, programmed items, projection overrides, budgets, children) point at it.
// After a Move, a budget that came along can land on a category (set) that already has a budget with the same period: two budgets on one thing would
// alert and count twice, and addBudget refuses exactly that. The budget that was already there stays; the one that moved is dropped (with its alert
// history) and reported, never silently (QA round 1, 2026-11-03). Answers [{ name, amount, currency, period_type }].
function dropDuplicateMovedBudgets_(movedIds) {
  var dropped = [];
  if (!Object.keys(movedIds).length) return dropped;
  var key = function (b) {
    var ids = parseBudgetCategoryIds_(b.category_id);
    return budgetKind_(b.period_type) + '|' + (ids === null ? 'ALL' : ids.slice().sort().join(','));
  };
  var seen = {};
  var rows = getAllRows('Budgets');
  rows.forEach(function (b) { if (!movedIds[String(b.id)]) seen[key(b)] = true; });
  var drop = {};
  rows.forEach(function (b) {
    if (!movedIds[String(b.id)]) return;
    var k = key(b);
    if (seen[k]) { drop[String(b.id)] = true; dropped.push({ name: String(b.name || ''), amount: Number(b.amount), currency: String(b.currency || ''), period_type: budgetKind_(b.period_type) }); }
    else seen[k] = true;
  });
  if (Object.keys(drop).length) {
    deleteRowsWhere_('Budget Alert Log', function (r) { return drop[String(r.budget_id)] === true; });
    deleteRowsWhere_('Budgets', function (r) { return drop[String(r.id)] === true; });
  }
  return dropped;
}

// Bulk "Show again" and the Undo of a bulk hide (More → Categories → Edit): one pass, a category that no longer exists is skipped.
function showCategories(payload) {
  var ids = uniqueIds_(payload && payload.ids);
  var out = { shown: 0 };
  if (!ids.length) return out;
  var headers = ensureCategoriesHiddenColumn_();
  var sheet = getSheet('Categories');
  var byId = {};
  getAllRows('Categories').forEach(function (c) { byId[String(c.id)] = c; });
  ids.forEach(function (id) {
    if (!byId[id]) return;
    var rowIndex = findRowIndexById(sheet, headers, id);
    if (rowIndex === -1) return;
    setCellByRow_(sheet, headers, rowIndex, 'hidden', '');
    out.shown++;
  });
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return out;
}

function categoryUsageMap_(ids) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var want = {}, entries = {}, used = {};
  ids.forEach(function (id) { want[String(id)] = true; entries[String(id)] = 0; used[String(id)] = 0; });
  [['Entries', 'category_id', true], ['Recurring Expenses', 'category_id'], ['Projection Overrides', 'category_id'], ['Categories', 'parent_id']].forEach(function (spec) {
    if (!ss.getSheetByName(spec[0])) return;
    getAllRows(spec[0]).forEach(function (r) {
      var v = String(r[spec[1]] || '');
      if (want[v]) { used[v]++; if (spec[2]) entries[v]++; }
    });
  });
  if (ss.getSheetByName('Budgets')) {
    getAllRows('Budgets').forEach(function (b) {
      var bids = parseBudgetCategoryIds_(b.category_id);
      if (bids === null) return;
      var seen = {};
      bids.forEach(function (x) { if (want[x] && !seen[x]) { seen[x] = true; used[x]++; } });
    });
  }
  return { entries: entries, used: used };
}

function uniqueIds_(raw) {
  var ids = [], seen = {};
  (raw || []).forEach(function (id) { id = String(id || ''); if (id && !seen[id]) { seen[id] = true; ids.push(id); } });
  return ids;
}

// { items: [{ id, name, type, protected, hidden, entries, used }] } — for the screen to decide what to ask.
function previewCategoryDelete(payload) {
  var ids = uniqueIds_(payload && payload.ids);
  var byId = {};
  getAllRows('Categories').forEach(function (c) { byId[String(c.id)] = c; });
  var usage = categoryUsageMap_(ids);
  return {
    items: ids.map(function (id) {
      var c = byId[id];
      if (!c) return { id: id, name: '', type: '', protected: false, missing: true, hidden: false, entries: 0, used: 0 };
      return { id: id, name: String(c.name || ''), type: String(c.type || ''), missing: false, hidden: String(c.hidden || '') === 'yes',
        protected: c.key === 'other' || MANAGED_CATEGORY_TYPES_.indexOf(c.type) === -1, entries: usage.entries[id] || 0, used: usage.used[id] || 0 };
    })
  };
}

// Answers { deleted: [{id,name,moved,to}], hidden: [{id,name}], kept: [{id,name,reason: missing|protected|noTarget|hiddenAlready}], movedEntries: n }.
function deleteCategories(payload) {
  payload = payload || {};
  var ids = uniqueIds_(payload.ids);
  var reassign = payload.reassign || {};
  var hideUsed = payload.hideUsed === true;
  var out = { deleted: [], hidden: [], kept: [], movedEntries: 0, droppedBudgets: [] };
  if (!ids.length) return out;
  ensureCategoriesHiddenColumn_();
  var byId = {};
  getAllRows('Categories').forEach(function (c) { byId[String(c.id)] = c; });
  var chosen = {};
  ids.forEach(function (id) { chosen[id] = true; });
  var usage = categoryUsageMap_(ids);
  var swapMap = {}, gone = {}, goneNames = {}, toHide = [];
  ids.forEach(function (id) {
    var cat = byId[id];
    if (!cat) { out.kept.push({ id: id, name: '', reason: 'missing' }); return; }
    var name = String(cat.name || '');
    if (cat.key === 'other' || MANAGED_CATEGORY_TYPES_.indexOf(cat.type) === -1) { out.kept.push({ id: id, name: name, reason: 'protected' }); return; }
    if (usage.used[id] > 0) {
      if (hideUsed) {
        if (String(cat.hidden || '') === 'yes') out.kept.push({ id: id, name: name, reason: 'hiddenAlready' });
        else { toHide.push(id); out.hidden.push({ id: id, name: name }); }
        return;
      }
      var target = byId[String(reassign[cat.type] || '')];
      if (!target || target.type !== cat.type || chosen[String(target.id)]) { out.kept.push({ id: id, name: name, reason: 'noTarget' }); return; }
      swapMap[id] = String(target.id);
      gone[id] = true; goneNames[name] = true;
      out.deleted.push({ id: id, name: name, moved: usage.entries[id] || 0, to: String(target.name || '') });
      return;
    }
    gone[id] = true; goneNames[name] = true;
    out.deleted.push({ id: id, name: name, moved: 0, to: '' });
  });
  if (out.deleted.length) {
    var swap = function (v) { return Object.prototype.hasOwnProperty.call(swapMap, String(v)) ? swapMap[String(v)] : v; };
    out.movedEntries = rewriteColumn_('Entries', 'category_id', swap, false).changed;
    rewriteColumn_('Recurring Expenses', 'category_id', swap, false);
    rewriteColumn_('Categories', 'parent_id', function (v) { return gone[String(v)] ? '' : v; }, false);
    var movedBudgetIds = {};
    rewriteColumn_('Budgets', 'category_id', function (v, row) {
      var bids = parseBudgetCategoryIds_(v);
      if (bids === null) return v;
      var changed = false, outIds = [];
      bids.forEach(function (x) {
        if (Object.prototype.hasOwnProperty.call(swapMap, x)) { x = swapMap[x]; changed = true; }
        if (outIds.indexOf(x) === -1) outIds.push(x);
      });
      if (changed) movedBudgetIds[String(row.id)] = true;
      return changed ? outIds.join(',') : v;
    }, false);
    out.droppedBudgets = dropDuplicateMovedBudgets_(movedBudgetIds);
    deleteRowsWhere_('Projection Overrides', function (r) { return gone[String(r.category_id)] === true; });
    deleteRowsWhere_('Category Keywords', function (r) { return goneNames[String(r.category_name)] === true; });
    deleteRowsWhere_('Categories', function (r) { return gone[String(r.id)] === true; });
  }
  if (toHide.length) {
    var headers = ensureCategoriesHiddenColumn_();
    var sheet = getSheet('Categories');
    toHide.forEach(function (id) {
      var rowIndex = findRowIndexById(sheet, headers, id);
      if (rowIndex !== -1) setCellByRow_(sheet, headers, rowIndex, 'hidden', 'yes');
    });
  }
  if (ROWS_MEMO_) delete ROWS_MEMO_['Categories'];
  bumpStructureVersion_();
  return out;
}
