/**
 * UNITS OF A PROJECT (owner, 2026-11-27, option B): a unit ("Depa 101") belongs to ONE project and is no longer a tag, so two buildings
 * can each have a "Depa 101". Company copies only.
 *
 * - Tab 'Units' gains `name` (the unit's own name, unique inside its project). `tag_id` is only the old link, kept for history.
 * - An entry carries `unit_id` (an expense or income of that unit's project); an expected collection carries `unit_id` too.
 * - What used to be read from the unit's tag (collected, stages paid, the bots' "depa 101") is read from `unit_id` (Sales.gs,
 *   CompanyBot.gs, BusinessPayments.gs, Projections.gs).
 *
 * CONVERSION (once per copy, `ensureUnitsModel_`, Settings `units_model` = '2'): every unit made from a tag takes the tag's name; the
 * entries carrying that tag (in that project, or in no project: they get it) take the unit; the expected collections that named the
 * tag take the unit; then the tags that became units are removed with their labels on entries, unless some entry of ANOTHER project
 * still carries one (that tag stays a tag). Tags made by "Add units" that no project had taken stay ordinary tags.
 */

var UNITS_MODEL_ = '2';

function unitsModelOn_() { return isCompanyCopy_() && businessOn_(); }

// The columns, and the one-time conversion from tags. Cheap after the first time (one Settings read).
function ensureUnitsModel_() {
  if (!unitsModelOn_()) return;
  if (String(getSettingsMap().units_model || '') === UNITS_MODEL_) return;
  ensureBusinessSheets_();
  ensureBusinessColumn_('Units', 'name', true);
  ensureBusinessColumn_('Entries', 'unit_id', true);
  ensureBusinessColumn_('Expected Payments', 'unit_id', true);
  convertUnitTags_();
  setSetting_('units_model', UNITS_MODEL_);
}

function convertUnitTags_() {
  var units = getAllRows('Units');
  if (!units.length) return;
  var tagName = {};
  getAllRows('Tags').forEach(function (t) { tagName[t.id] = String(t.name); });
  var byTag = {};
  units.forEach(function (u) {
    if (!u.tag_id) return;
    byTag[u.tag_id] = u;
    if (!String(u.name || '').trim() && tagName[u.tag_id]) updateRowFields_('Units', u.id, { name: tagName[u.tag_id] });
  });
  if (!Object.keys(byTag).length) return;

  // Entries: the unit of their tag (same project, or none yet).
  var entryTags = getAllRows('Entry Tags');
  var entries = {};
  getAllRows('Entries').forEach(function (e) { entries[e.id] = e; });
  var setUnit = {}, setProject = {}, keepTag = {};
  entryTags.forEach(function (et) {
    var u = byTag[et.tag_id], e = entries[et.entry_id];
    if (!u || !e) return;
    if (e.project_id && String(e.project_id) !== String(u.project_id)) { keepTag[et.tag_id] = true; return; }
    setUnit[e.id] = u.id;
    if (!e.project_id) setProject[e.id] = u.project_id;
  });
  writeEntryColumn_('unit_id', setUnit);
  if (Object.keys(setProject).length) {
    var companyOf = {};
    getProjectRows_().forEach(function (p) { companyOf[p.id] = p.company_id; });
    var setCompany = {};
    Object.keys(setProject).forEach(function (id) { if (!entries[id].company_id || String(entries[id].company_id) === String(companyOf[setProject[id]])) setCompany[id] = companyOf[setProject[id]]; else delete setProject[id]; });
    writeEntryColumn_('project_id', setProject);
    writeEntryColumn_('company_id', setCompany);
  }

  // Expected collections that named the tag.
  var expected = getAllRows('Expected Payments');
  expected.forEach(function (x) {
    var u = x.unit_tag_id && byTag[x.unit_tag_id];
    if (u && String(x.project_id) === String(u.project_id) && !x.unit_id) updateRowFields_('Expected Payments', x.id, { unit_id: u.id });
  });

  // The tags that became units go (with their labels), unless another project's entry still carries one.
  var gone = {};
  Object.keys(byTag).forEach(function (tagId) { if (!keepTag[tagId]) gone[tagId] = true; });
  deleteRowsWhere_('Entry Tags', function (r) { return !!gone[r.tag_id] && !!setUnit[r.entry_id]; });
  deleteRowsWhere_('Tags', function (r) { return !!gone[r.id]; });
  bumpStructureVersion_();
}

// Writes one column of Entries for many rows in one go (id -> value): the conversion touches up to hundreds of entries.
function writeEntryColumn_(column, byId) {
  if (!Object.keys(byId).length) return;
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var idCol = headers.indexOf('id'), col = headers.indexOf(column);
  if (idCol === -1 || col === -1) return;
  var last = sheet.getLastRow();
  if (last < 2) return;
  var ids = sheet.getRange(2, idCol + 1, last - 1, 1).getValues();
  var range = sheet.getRange(2, col + 1, last - 1, 1);
  var vals = range.getValues();
  ids.forEach(function (r, i) { if (byId[r[0]] !== undefined) vals[i][0] = byId[r[0]]; });
  range.setValues(vals);
  getSheet('Entries');   // drops what this request remembered of the tab
}

// Units of every project (the app's lists): [{ id, name, project_id }].
function unitsForMeta_() {
  if (!unitsModelOn_()) return [];
  ensureUnitsModel_();
  return unitRows_().filter(function (u) { return String(u.name || '').trim(); })
    .map(function (u) { return { id: String(u.id), name: String(u.name), project_id: String(u.project_id) }; });
}

function unitById_(id) {
  if (!id) return null;
  return unitRows_().find(function (u) { return String(u.id) === String(id); }) || null;
}

// The `unit_id` of a new entry, checked: the unit must exist and belong to the entry's project. {} when none is sent or outside a
// company copy (an older phone sends none).
function unitFieldFrom_(src, projectId) {
  if (!src || src.unit_id === undefined || !unitsModelOn_()) return {};
  ensureUnitsModel_();
  var id = String(src.unit_id || '');
  if (!id) return { unit_id: '' };
  var u = unitById_(id);
  if (!u) throw new Error(tr_('units.gone'));
  if (String(u.project_id) !== String(projectId || '')) throw new Error(tr_('units.otherProject'));
  return { unit_id: id };
}

// For updateEntryFields: the unit checked against the project the entry will have; a project changed without a unit drops a unit
// of the old project.
function unitFieldsForUpdate_(entryId, fields) {
  if (!fields || !unitsModelOn_() || (fields.unit_id === undefined && fields.project_id === undefined)) return fields;
  ensureUnitsModel_();
  var e = getEntryById_(entryId) || {};
  var project = fields.project_id !== undefined ? fields.project_id : e.project_id;
  if (fields.unit_id !== undefined) return Object.assign({}, fields, unitFieldFrom_(fields, project));
  var u = unitById_(e.unit_id);
  if (u && String(u.project_id) !== String(project || '')) return Object.assign({}, fields, { unit_id: '' });
  return fields;
}

// A unit's name in the requests' language of lists: "Depa 101".
function unitNameById_(id) {
  var u = unitById_(id);
  return u ? String(u.name || '') : '';
}

// Unit names for a project, made from the "Add units" numbering. Names already in THAT project (any case) are skipped; the same
// name in another project is fine. payload: { project_id, names } (an older phone may still send tag_ids: their names are used).
function unitNamesToAdd_(projectId, payload) {
  var names = Array.isArray(payload.names) ? payload.names : [];
  if (!names.length && Array.isArray(payload.tag_ids)) {
    var tags = {};
    getAllRows('Tags').forEach(function (t) { tags[t.id] = String(t.name); });
    names = payload.tag_ids.map(function (id) { return tags[id] || ''; });
  }
  var have = {};
  unitRows_().forEach(function (u) { if (String(u.project_id) === String(projectId)) have[String(u.name || '').trim().toLowerCase()] = true; });
  var out = [];
  names.forEach(function (n) {
    var name = String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    var k = name.toLowerCase();
    if (name && !have[k]) { have[k] = true; out.push(name); }
  });
  return { names: out, skipped: names.length - out.length };
}

// unit id -> its name and its project's, as the search reads text ("depa 101 edificio los pinos"), once per request.
var UNIT_SEARCH_NAMES_ = null;
function unitSearchNames_() {
  if (UNIT_SEARCH_NAMES_ && UNIT_SEARCH_NAMES_.memo && UNIT_SEARCH_NAMES_.memo === ROWS_MEMO_) return UNIT_SEARCH_NAMES_.map;
  var projects = {};
  getProjectRows_().forEach(function (p) { projects[p.id] = p.name; });
  var map = {};
  unitRows_().forEach(function (u) { if (u.name) map[u.id] = searchNormalize_(String(u.name) + ' ' + String(projects[u.project_id] || '')); });
  UNIT_SEARCH_NAMES_ = { memo: ROWS_MEMO_, map: map };
  return map;
}
