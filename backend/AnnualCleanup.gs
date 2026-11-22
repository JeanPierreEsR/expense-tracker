/**
 * One-time clean-up of the old "Annual budget" CATEGORY (owner, 2026-11-14; plan "Annual expenses", step 4). Owner's copy only.
 *
 * Being annual is now a mark (the Annual tag, or a trip sent to an "Annual expenses" budget), never a category. The owner filed
 * every annual expense under a category with the key `annual_budget`, which hid what each one was. This gives them back a real
 * category, group by group (grouped like Tidy my history), and tags each one Annual so it still counts as annual. Every expense in
 * that category is listed, any date, Needs review included. Undo puts a group back. Once the category is empty, Finish turns the
 * yearly budget on it into an "Everything marked Annual" budget (history kept) and hides the old category (never deletes it).
 */

var ANNUAL_CLEANUP_KEY_ = 'annual_budget';
var ANNUAL_CLEANUP_BLANK_ = '__blank__';   // the group of expenses with no description

// The old category, only on the owner's copy (no installer FEATURES). Found by its key, else by its name (owner's walk, 2026-11-14:
// the card did not show on his phone; a renamed or imported category may carry no key). Its sub-categories come with it. A hidden one
// counts only while it still holds expenses (Finish hides it when empty, and the card then goes away).
var ANNUAL_CLEANUP_NAMES_ = { 'annual budget': true, 'presupuesto anual': true, 'annual': true, 'anual': true };
function annualCleanupCategory_() {
  if (isFriendCopy_()) return null;
  var cats = getAllRows('Categories').filter(function (c) { return c.type === 'expense'; });
  var cat = cats.find(function (c) { return String(c.key || '') === ANNUAL_CLEANUP_KEY_; }) ||
    cats.find(function (c) { return ANNUAL_CLEANUP_NAMES_[String(c.name || '').trim().toLowerCase()] === true; });
  if (!cat) return null;
  var ids = {};
  ids[String(cat.id)] = true;
  cats.forEach(function (c) { if (String(c.parent_id || '') === String(cat.id)) ids[String(c.id)] = true; });
  cat = Object.assign({}, cat, { ids: ids });
  if (String(cat.hidden || '') === 'yes' && !annualCleanupEntries_(cat).length) return null;
  return cat;
}

// Every entry in the old category or one of its sub-categories.
function annualCleanupEntries_(cat) {
  return getAllRows('Entries').filter(function (e) { return cat.ids[String(e.category_id)] === true; });
}

function annualCleanupKey_(e) {
  return followKey_(e) || ANNUAL_CLEANUP_BLANK_;
}

// Tidy's scan, without the old category: it must never be suggested as where an expense belongs.
function annualCleanupScan_(cat) {
  var scan = scanFollow_();
  var strip = function (x) {
    Object.keys(cat.ids).forEach(function (catId) {
      var n = x.counts[catId];
      if (n) { delete x.counts[catId]; x.total -= n; }
    });
  };
  Object.keys(scan.groups).forEach(function (k) { strip(scan.groups[k]); });
  Object.keys(scan.families).forEach(function (k) { strip(scan.families[k]); });
  return scan;
}

/**
 * What the card shows. Reply: { available, categoryName, total, groups: [{ key, label, count, totalMain, firstDate, lastDate,
 * suggestion: { categoryId, categoryName } | null, samples }], budgets: [{ id, name, period_type, amount, currency }] }.
 * available is false on a friend's copy or once the category is gone or hidden. With no expenses left, groups is [] and `budgets`
 * lists the budgets Finish would turn into "Everything marked Annual" (the yearly ones on exactly this category).
 */
function listAnnualCleanup() {
  var cat = annualCleanupCategory_();
  if (!cat) return { available: false };
  var entries = annualCleanupEntries_(cat);
  var rates = buildRatesByCurrency_(), main = homeCurrency_();
  var toMain = function (e) {
    var amount = Number(e.amount) || 0;
    if (e.currency === main) return amount;
    var rate = rateToMain_(rates, e.currency, String(e.date).substring(0, 7));
    return rate != null ? amount * rate : 0;
  };
  var byKey = {};
  entries.forEach(function (e) { (byKey[annualCleanupKey_(e)] = byKey[annualCleanupKey_(e)] || []).push(e); });
  var scan = entries.length ? annualCleanupScan_(cat) : null;
  var groups = Object.keys(byKey).map(function (key) {
    var list = byKey[key].slice().sort(compareEntriesRecency_);
    var labels = {}, total = 0;
    list.forEach(function (e) { total += toMain(e); var d = String(e.description || ''); if (d) labels[d] = (labels[d] || 0) + 1; });
    var label = key === ANNUAL_CLEANUP_BLANK_ ? tr_('annualCleanup.noDescription') : (Object.keys(labels).sort(function (a, b) { return labels[b] - labels[a]; })[0] || key);
    var s = key === ANNUAL_CLEANUP_BLANK_ ? null : categorySuggestion_(scan, key);
    return {
      key: key, label: label, count: list.length, totalMain: Math.round(total * 100) / 100,
      firstDate: list[list.length - 1].date, lastDate: list[0].date,
      suggestion: s && !cat.ids[String(s.categoryId)] ? { categoryId: s.categoryId, categoryName: categoryNameForMessage_(s.categoryId) } : null,
      samples: list.slice(0, FOLLOW_SAMPLES).map(function (e) {
        return { id: e.id, date: e.date, description: e.description || '', amount: Number(e.amount), currency: e.currency, pending: e.status !== 'confirmed' };
      })
    };
  }).sort(function (a, b) { return b.totalMain - a.totalMain || b.count - a.count; });
  return {
    available: true, categoryId: cat.id, categoryIds: Object.keys(cat.ids), categoryName: categoryLabel_(cat), total: entries.length, groups: groups, main: main,
    budgets: annualCleanupBudgetsOf_(cat).map(function (b) {
      return { id: b.id, name: b.name || '', period_type: budgetKind_(b.period_type), amount: Number(b.amount), currency: b.currency || main };
    })
  };
}

// The budgets on exactly the old category (Finish turns the yearly ones into "Everything marked Annual").
function annualCleanupBudgets_(catId) {
  return getAllRows('Budgets').filter(function (b) { return String(b.category_id) === String(catId); });
}
// (a budget on the old category together with its sub-categories, e.g. "id1,id2", counts as one on it too)
function annualCleanupBudgetsOf_(cat) {
  return getAllRows('Budgets').filter(function (b) {
    var ids = String(b.category_id || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    return ids.length > 0 && ids.indexOf(String(cat.id)) !== -1 && ids.every(function (id) { return cat.ids[id] === true; });
  });
}

/**
 * Moves groups to the categories picked and tags each expense Annual. payload: { items: [{ key, categoryId }] }.
 * Only expenses STILL in the old category move. Reply: { count, changes: [{ categoryId, ids }], annualIds, left } — the shape
 * undoAnnualCleanup takes back (annualIds = the tags this added, not the ones already there).
 */
function applyAnnualCleanup(payload) {
  var cat = annualCleanupCategory_();
  if (!cat) throw new Error(tr_('annualCleanup.gone'));
  var expenseCatIds = {};
  getAllRows('Categories').forEach(function (c) { if (c.type === 'expense' && !cat.ids[String(c.id)]) expenseCatIds[c.id] = true; });
  var entries = annualCleanupEntries_(cat);
  var byKey = {};
  entries.forEach(function (e) { (byKey[annualCleanupKey_(e)] = byKey[annualCleanupKey_(e)] || []).push(e); });
  var plan = [], byCat = {}, from = {}, keyOf = {};
  ((payload && payload.items) || []).forEach(function (it) {
    var list = byKey[it.key];
    if (!list) return;
    if (!expenseCatIds[it.categoryId]) throw new Error(tr_('err.categoryNotFound'));
    list.forEach(function (e) {
      plan.push({ id: e.id, categoryId: it.categoryId, expect: String(e.category_id) });
      from[e.id] = String(e.category_id);
      keyOf[e.id] = it.key;
      (byCat[it.categoryId] = byCat[it.categoryId] || []).push(e.id);
    });
  });
  var done = {};
  bulkSetEntryCategories_(plan).forEach(function (id) { done[id] = true; });
  // The Annual tag, in one write: only the expenses that moved and do not have it yet.
  ensureAnnualTag_();
  var tagged = annualEntryIdSet_();
  var annualIds = Object.keys(done).filter(function (id) { return !tagged[id]; });
  if (annualIds.length) appendRowsBulk_('Entry Tags', annualIds.map(function (id) { return { entry_id: id, tag_id: ANNUAL_TAG_ID }; }));
  var changes = [];
  Object.keys(byCat).forEach(function (catId) {
    var ids = byCat[catId].filter(function (id) { return done[id]; });
    if (ids.length) changes.push({ categoryId: catId, ids: ids, from: ids.map(function (id) { return from[id]; }) });
  });
  var count = changes.reduce(function (n, c) { return n + c.ids.length; }, 0);
  // The same, per group (owner, 2026-11-14: each row shows its own result and has its own Undo).
  var groups = {};
  changes.forEach(function (c) {
    c.ids.forEach(function (id, i) {
      var g = groups[keyOf[id]] || (groups[keyOf[id]] = { count: 0, changes: {}, annualIds: [] });
      var ch = g.changes[c.categoryId] || (g.changes[c.categoryId] = { categoryId: c.categoryId, ids: [], from: [] });
      ch.ids.push(id); ch.from.push(c.from[i]); g.count++;
    });
  });
  var tagAdded = {};
  annualIds.forEach(function (id) { tagAdded[id] = true; });
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    g.changes = Object.keys(g.changes).map(function (c) { return g.changes[c]; });
    g.changes.forEach(function (ch) { ch.ids.forEach(function (id) { if (tagAdded[id]) g.annualIds.push(id); }); });
  });
  return { count: count, changes: changes, annualIds: annualIds, left: entries.length - count, groups: groups };
}

// Undo: each expense back into the (sub-)category it came from (only those that still carry the category this put them in), and
// the tags this added go.
function undoAnnualCleanup(payload) {
  var cat = annualCleanupCategory_();
  if (!cat) throw new Error(tr_('annualCleanup.gone'));
  var plan = [];
  ((payload && payload.changes) || []).forEach(function (c) {
    (c.ids || []).forEach(function (id, i) {
      var back = c.from && c.from[i] && cat.ids[String(c.from[i])] ? String(c.from[i]) : String(cat.id);
      plan.push({ id: id, categoryId: back, expect: c.categoryId });
    });
  });
  var reverted = bulkSetEntryCategories_(plan);
  var added = {};
  ((payload && payload.annualIds) || []).forEach(function (id) { added[id] = true; });
  if (Object.keys(added).length) deleteRowsWhere_('Entry Tags', function (r) { return r.tag_id === ANNUAL_TAG_ID && added[r.entry_id]; });
  return { reverted: reverted.length };
}

/**
 * Finish (only once the old category is empty): every YEARLY budget on exactly it becomes "Everything marked Annual" (same amount;
 * its Budget History rows follow, so past years keep counting the same expenses, now tagged), then the category is hidden.
 * A monthly or weekly budget on it is left alone and named in the reply. Reply: { converted: [names], leftAlone: [names] }.
 */
function finishAnnualCleanup() {
  var cat = annualCleanupCategory_();
  if (!cat) throw new Error(tr_('annualCleanup.gone'));
  if (annualCleanupEntries_(cat).length) throw new Error(tr_('annualCleanup.notEmpty'));
  var converted = [], leftAlone = [];
  var name = function (b) { return String(b.name || '').trim() || categoryLabel_(cat); };
  withWriteBatch_(function () {
    annualCleanupBudgetsOf_(cat).forEach(function (b) {
      if (budgetKind_(b.period_type) !== 'yearly') { leftAlone.push(name(b)); return; }
      updateRowFields_('Budgets', b.id, { category_id: ANNUAL_BUDGET_CATEGORY_ });
      if (budgetHistorySheetExists_()) {
        getAllRows('Budget History').forEach(function (h) {
          if (String(h.budget_id) === String(b.id) && String(h.category_id) === String(b.category_id)) updateRowFields_('Budget History', h.id, { category_id: ANNUAL_BUDGET_CATEGORY_ });
        });
      }
      converted.push(name(b));
    });
  });
  Object.keys(cat.ids).forEach(function (id) { setCategoryHidden({ id: id, hidden: true }); });
  return { converted: converted, leftAlone: leftAlone };
}
