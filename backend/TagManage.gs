/**
 * Tags on More → Categories & tags (owner's request, 2026-11-14): how many entries carry each tag,
 * rename one, delete one. Deleting a tag only takes that label off its entries; no entry is
 * deleted and no money moves. The built-in Annual tag (AnnualTag.gs) can be neither renamed nor
 * deleted: budgets and Travel rely on it. See specs/entries-and-categories.md § Tags.
 */

// { tagId: number of entries carrying it }, for the list ("12 entries").
function getTagCounts() {
  var counts = {};
  getAllRows('Entry Tags').forEach(function (et) {
    var id = String(et.tag_id || '');
    if (id) counts[id] = (counts[id] || 0) + 1;
  });
  // Programmed items carrying each tag (owner, 2026-11-16): the delete question names them too.
  var items = {};
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Recurring Expenses')) {
    getAllRows('Recurring Expenses').forEach(function (r) {
      recurringTagIds_(r).forEach(function (t) { items[t] = (items[t] || 0) + 1; });
    });
  }
  return { counts: counts, items: items };
}

function managedTagRow_(id) {
  var tag = getAllRows('Tags').find(function (t) { return String(t.id) === id; });
  if (!tag) throw new Error(tr_('bulk.tagNotFound'));
  if (id === ANNUAL_TAG_ID) throw new Error(tr_('err.tagProtected'));
  return tag;
}

// Another tag already called this (any case, accents; "annual"/"anual" is the built-in one).
function tagNameTaken_(name, exceptId) {
  if (isAnnualTagName_(name)) return true;
  var n = searchNormalize_(String(name).trim());
  return getAllRows('Tags').some(function (t) {
    return String(t.id) !== String(exceptId || '') && searchNormalize_(String(tagLabel_(t)).trim()) === n;
  });
}

function renameTag(payload) {
  var id = String((payload && payload.id) || '');
  var name = String((payload && payload.name) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  var tag = managedTagRow_(id);
  if (!name) throw new Error(tr_('err.tagName'));
  if (name === String(tag.name)) return { id: id, name: name };
  if (tagNameTaken_(name, id)) throw new Error(tr_('err.tagExists', { name: name }));
  if (!updateRowFields_('Tags', id, { name: name })) throw new Error(tr_('bulk.tagNotFound'));
  bumpStructureVersion_();
  // The phone's search copy holds each entry's tag names: stamp the tagged entries so it picks up the new name.
  var ids = getAllRows('Entry Tags').filter(function (et) { return String(et.tag_id) === id; }).map(function (et) { return et.entry_id; });
  if (ids.length) touchEntriesById_(ids);
  return { id: id, name: name };
}

// Removes the tag and takes it off every entry that had it. Returns how many entries lost it.
function deleteTag(payload) {
  var id = String((payload && payload.id) || '');
  managedTagRow_(id);
  var removed = 0;
  deleteRowsWhere_('Entry Tags', function (r) { if (String(r.tag_id) === id) { removed++; return true; } return false; });
  deleteRowsWhere_('Tags', function (r) { return String(r.id) === id; });
  // ...and off every Programmed item that had it.
  var items = 0;
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Recurring Expenses')) {
    getAllRows('Recurring Expenses').forEach(function (r) {
      var ids = String(r.tag_ids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (ids.indexOf(id) < 0) return;
      updateRowFields_('Recurring Expenses', r.id, { tag_ids: ids.filter(function (x) { return x !== id; }).join(',') });
      items++;
    });
  }
  bumpStructureVersion_();
  return { id: id, entries: removed, items: items };
}

// Several tags at once (More → Categories & tags, Edit mode; owner 2026-11-27): the same as deleteTag for each, in ONE call (speed rule).
// The built-in Annual and unknown ids are left out. payload: { ids } -> { tags, entries, items }
function deleteTags(payload) {
  var known = {};
  getAllRows('Tags').forEach(function (t) { known[String(t.id)] = true; });
  var gone = {};
  ((payload && payload.ids) || []).forEach(function (id) { id = String(id || ''); if (known[id] && id !== ANNUAL_TAG_ID) gone[id] = true; });
  var n = Object.keys(gone).length;
  if (!n) throw new Error(tr_('bulk.tagNotFound'));
  var removed = 0;
  deleteRowsWhere_('Entry Tags', function (r) { if (gone[String(r.tag_id)]) { removed++; return true; } return false; });
  deleteRowsWhere_('Tags', function (r) { return !!gone[String(r.id)]; });
  var items = 0;
  if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Recurring Expenses')) {
    getAllRows('Recurring Expenses').forEach(function (r) {
      var ids = String(r.tag_ids || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var kept = ids.filter(function (x) { return !gone[x]; });
      if (kept.length === ids.length) return;
      updateRowFields_('Recurring Expenses', r.id, { tag_ids: kept.join(',') });
      items++;
    });
  }
  bumpStructureVersion_();
  return { tags: n, entries: removed, items: items };
}
