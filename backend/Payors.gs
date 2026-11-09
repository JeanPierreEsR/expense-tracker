/**
 * Payors — who pays the owner income (a client, an employer, a friend).
 *
 * Since 2026-11-09 payors and friends are ONE list of people (the Friends tab), so that income can be owed by someone and covered by a general
 * repayment (pending income, specs/entries-and-categories.md). An income's `paid_by` holds that person's id. The old Payors tab is left in place,
 * untouched, as a record of what was merged. Until a copy has been merged (PAYORS_MERGED) everything still reads the old tab.
 */

var PAYORS_MERGED_PROPERTY_ = 'PAYORS_MERGED';
var PAYOR_SEED_NAME_ = 'Acme Corp';   // the example a new tab starts with; it is not carried over unless it was really used

function payorsMerged_() {
  return PropertiesService.getScriptProperties().getProperty(PAYORS_MERGED_PROPERTY_) === 'yes';
}

// Self-heals its own tab on first use, same reasoning and pattern as ensureRecurringExpensesSheet_.
function ensurePayorsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Payors')) return;
  var sheet = ss.insertSheet('Payors');
  var headers = TABLE_DEFINITIONS['Payors'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.appendRow([Utilities.getUuid(), PAYOR_SEED_NAME_, '']);
}

function getPayorRows_() {
  if (payorsMerged_()) return getAllRowsCached_('Friends').filter(function (f) { return !f.trip_id; });
  ensurePayorsSheet_();
  return getAllRowsCached_('Payors');
}

function listPayors() {
  return getPayorRows_().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
}

function addPayor(payload) {
  if (payorsMerged_()) return addFriend({ name: payload.name, notes: payload.notes || '' });
  ensurePayorsSheet_();
  var payor = { id: Utilities.getUuid(), name: payload.name, notes: payload.notes || '' };
  appendRowObject('Payors', payor);
  return payor;
}

function personNameKey_(name) { return String(name || '').trim().toLowerCase(); }

// Pure: which payors share their name with an existing person (not a trip's group). Returns [{ payor_id, friend_id, name }].
function payorMergePairs_(payors, friends) {
  var byName = {};
  var taken = {};
  friends.forEach(function (f) {
    taken[String(f.id)] = true;
    if (!f.trip_id && !byName[personNameKey_(f.name)]) byName[personNameKey_(f.name)] = f;
  });
  var pairs = [];
  payors.forEach(function (p) {
    var friend = byName[personNameKey_(p.name)];
    if (friend && !taken[String(p.id)]) pairs.push({ payor_id: String(p.id), friend_id: String(friend.id), name: String(friend.name) });
  });
  return pairs;
}

// Income entries (and the safety copies of deleted ones) that named a merged payor now name the person it became.
function repointMergedPayors_(idMap) {
  if (!Object.keys(idMap).length) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var entries = ss.getSheetByName('Entries');
  var n = entries ? entries.getLastRow() - 1 : 0;
  if (n > 0) {
    var headers = getHeaders(entries);
    var paidRange = entries.getRange(2, headers.indexOf('paid_by') + 1, n, 1);
    var paid = paidRange.getValues();
    var types = entries.getRange(2, headers.indexOf('type') + 1, n, 1).getValues();
    var changed = false;
    paid.forEach(function (row, i) {
      if (types[i][0] === 'income' && idMap[String(row[0])]) { row[0] = idMap[String(row[0])]; changed = true; }
    });
    if (changed) {
      paidRange.setValues(paid);
      if (ROWS_MEMO_) delete ROWS_MEMO_['Entries'];
    }
  }
  var deleted = ss.getSheetByName('Deleted Entries');
  var m = deleted ? deleted.getLastRow() - 1 : 0;
  if (m > 0) {
    var range = deleted.getRange(2, getHeaders(deleted).indexOf('payload') + 1, m, 1);
    var cells = range.getValues();
    var touched = false;
    cells.forEach(function (row) {
      var text = String(row[0]);
      Object.keys(idMap).forEach(function (oldId) {
        if (text.indexOf(oldId) !== -1) { text = text.split(oldId).join(idMap[oldId]); touched = true; }
      });
      row[0] = text;
    });
    if (touched) {
      range.setValues(cells);
      if (ROWS_MEMO_) delete ROWS_MEMO_['Deleted Entries'];
    }
  }
}

// One list of people. `separate` = { payorId: true } for a payor who only shares a name with a friend: kept as a person of their own. Everyone
// else who shares a name becomes that friend. Safe to run again: a payor already carried over is skipped and a re-point finds nothing left to change.
function mergePayorsIntoFriends_(separate) {
  separate = separate || {};
  ensurePayorsSheet_();
  var payors = getAllRows('Payors');
  var friends = getAllRows('Friends');
  var usedPayors = {};
  getAllRows('Entries').forEach(function (e) { if (e.type === 'income' && e.paid_by) usedPayors[String(e.paid_by)] = true; });
  var existingIds = {};
  var byName = {};
  friends.forEach(function (f) {
    existingIds[String(f.id)] = true;
    if (!f.trip_id && !byName[personNameKey_(f.name)]) byName[personNameKey_(f.name)] = String(f.id);
  });
  var idMap = {};
  payors.forEach(function (p) {
    var id = String(p.id);
    var key = personNameKey_(p.name);
    if (existingIds[id] || !key) return;
    if (p.name === PAYOR_SEED_NAME_ && !usedPayors[id]) return;
    if (byName[key] && !separate[id]) { idMap[id] = byName[key]; return; }
    var name = byName[key] ? String(p.name) + tr_('payor.separateSuffix') : String(p.name);
    appendRowObject('Friends', { id: id, name: name, notes: p.notes || '' });
    existingIds[id] = true;
    if (!byName[personNameKey_(name)]) byName[personNameKey_(name)] = id;
  });
  repointMergedPayors_(idMap);
  PropertiesService.getScriptProperties().setProperty(PAYORS_MERGED_PROPERTY_, 'yes');
  bumpStructureVersion_();   // the phone reloads its lists and entries
  return { merged: Object.keys(idMap).length };
}

// The owner's copy: nothing that shares a name is merged without being shown first. With no such names it just happens.
function payorMergeAskForApp_() {
  if (isFriendCopy_() || payorsMerged_()) return [];
  ensurePayorsSheet_();
  var pairs = payorMergePairs_(getAllRows('Payors'), getAllRows('Friends'));
  if (!pairs.length) mergePayorsIntoFriends_({});
  return pairs;
}

// payload.separate: the payor ids the owner said are a different person.
function applyPayorMerge(payload) {
  if (payorsMerged_()) return { merged: 0, already: true };
  var separate = {};
  ((payload && payload.separate) || []).forEach(function (id) { separate[String(id)] = true; });
  return mergePayorsIntoFriends_(separate);
}

// { personId: 'yyyy-MM-dd' }: the date of each person's latest income. Only real income: the extra of a repayment and a forgiven debt are
// money from a debt, so they do not count as this person having paid income. Kept in the cache until an entry changes (it needs every entry).
function lastIncomeByPerson_() {
  var cache = CacheService.getScriptCache();
  var key = 'last_income_' + getVersion_('ENTRIES_VERSION') + '_' + getVersion_('STRUCTURE_VERSION');
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);
  var fromDebt = {};
  getAllRows('Loans').forEach(function (l) {
    if (l.forgiveness_entry_id) fromDebt[String(l.forgiveness_entry_id)] = true;
    loanForgivenParts_(l).forEach(function (p) { if (p.entry_id) fromDebt[String(p.entry_id)] = true; });
  });
  var names = {};
  getPayorRows_().forEach(function (p) { names[String(p.id)] = p.name; });
  var last = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'income' || e.status !== 'confirmed' || !e.paid_by || fromDebt[String(e.id)]) return;
    var who = String(e.paid_by);
    var d = String(e.date || '');
    var name = names[who];
    if (name !== undefined && (String(e.description) === tr_('desc.overpaymentFrom', { name: name }, 'en') || String(e.description) === tr_('desc.overpaymentFrom', { name: name }, 'es'))) return;
    if (d && (!last[who] || d > last[who])) last[who] = d;
  });
  try { cache.put(key, JSON.stringify(last), 3600); } catch (err) { /* too big or a passing error: it is simply worked out again */ }
  return last;
}

// The list the income form shows, each person with the date of their latest income.
function getPayorsWithLastIncome_() {
  var last = lastIncomeByPerson_();
  return getPayorRows_().map(function (p) {
    var row = {};
    Object.keys(p).forEach(function (k) { row[k] = p[k]; });
    row.last_income = last[String(p.id)] || '';
    return row;
  });
}
