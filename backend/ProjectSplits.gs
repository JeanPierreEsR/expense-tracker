/**
 * Business 2, Phase 1, piece 6 (owner's plan, approved 2026-11-22): ONE expense or income of a company shared between its projects,
 * each with its own amount (in the entry's currency). Different every month; the next month's payment of the same kind is offered the
 * last split ("As last month: Project A 60 %, Project B 40 %"), which the person accepts or changes.
 *
 * Sheet 'Project Splits' (created on first use, BUSINESS_TABLES_): id, entry_id, project_id, amount.
 * A split entry carries its company and NO project (company_id set, project_id blank). Every place that adds up per project reads the
 * parts instead of the single project (businessRows_, the Overview filter, a project's entry list); the company counts the entry ONCE.
 * A split only counts while it still adds up: the entry is a company's expense or income with no project of its own, every project still
 * exists in that company, and the parts equal the amount. Otherwise it is ignored (the entry counts at the company's own level) and an
 * edit that breaks it (amount, currency, type, a project picked) deletes it: never a split that does not add up.
 */

function projectSplitRows_() {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Project Splits')) return [];
  return getAllRows('Project Splits');   // NOT the 1-hour reference cache: splits change all the time
}

// entry id -> [{ project_id, amount }] as stored (not yet checked).
function projectSplitsByEntry_() {
  var out = {};
  projectSplitRows_().forEach(function (r) {
    var id = String(r.entry_id || '');
    if (!id) return;
    (out[id] = out[id] || []).push({ project_id: String(r.project_id || ''), amount: Number(r.amount) || 0 });
  });
  return out;
}

// The parts of `e` that count, or null (no split, or one that no longer adds up). projById: id -> project row.
function validProjectParts_(e, parts, projById) {
  if (!parts || parts.length < 2 || !e || (e.type !== 'expense' && e.type !== 'income') || !e.company_id || e.project_id) return null;
  var sum = 0;
  for (var i = 0; i < parts.length; i++) {
    var p = projById[parts[i].project_id];
    if (!p || String(p.company_id) !== String(e.company_id) || !(parts[i].amount > 0)) return null;
    sum += parts[i].amount;
  }
  return Math.abs(sum - Number(e.amount)) < 0.005 ? parts : null;
}

function projectsById_() {
  var out = {};
  getProjectRows_().forEach(function (p) { out[String(p.id)] = p; });
  return out;
}

// For the readers: the entries with each split entry replaced by one copy per part (same id, the part's project and amount, its IGV
// in proportion). Everything else is returned as it is. Used where totals are counted PER PROJECT.
function expandProjectSplits_(entries) {
  var byEntry = projectSplitsByEntry_();
  if (!Object.keys(byEntry).length) return entries;
  var projById = projectsById_();
  var out = [];
  entries.forEach(function (e) {
    var parts = byEntry[e.id] ? validProjectParts_(e, byEntry[e.id], projById) : null;
    if (!parts) { out.push(e); return; }
    var amount = Number(e.amount), igv = Number(e.igv_amount) || 0;
    parts.forEach(function (part) {
      var c = {};
      Object.keys(e).forEach(function (k) { c[k] = e[k]; });
      c.project_id = part.project_id;
      c.amount = part.amount;
      if (igv > 0) c.igv_amount = round2_(igv * part.amount / amount);
      c.split_part = true;
      out.push(c);
    });
  });
  return out;
}

// The checked parts of one entry, for the phone ([] when none).
function projectPartsOfEntry_(e, byEntry, projById) {
  var parts = byEntry && byEntry[e.id] ? validProjectParts_(e, byEntry[e.id], projById) : null;
  return parts || [];
}

// Percentages (from a suggestion) → amounts of `total`, rounded to cents; the last part takes what rounding left.
function partsFromPercents_(total, pcts) {
  var left = round2_(total);
  return pcts.map(function (p, i) {
    var amount = i === pcts.length - 1 ? left : round2_(total * Number(p.pct) / 100);
    left = round2_(left - amount);
    return { project_id: String(p.project_id), amount: amount };
  });
}

// Saves (or, with no parts, removes) the split of one entry. payload: { entry_id, parts: [{project_id, amount}] } or
// { entry_id, percents: [{project_id, pct}] } (a suggestion accepted: amounts worked out from the entry's own amount).
function saveProjectSplit(payload) {
  requireBusiness_();
  payload = payload || {};
  var entry = getEntryById_(payload.entry_id);
  if (!entry) throw new Error(tr_('err.entryNotFound'));
  var removeOnly = !(payload.parts && payload.parts.length) && !(payload.percents && payload.percents.length);
  if (removeOnly) {
    if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Project Splits')) deleteRowsWhere_('Project Splits', function (r) { return String(r.entry_id) === String(entry.id); });
    touchEntriesById_([entry.id]);
    return { entry_id: entry.id, parts: [] };
  }
  if (entry.type !== 'expense' && entry.type !== 'income') throw new Error(tr_('psplit.onlyMoney'));
  if (getAllRows('Entry Splits').some(function (s) { return String(s.entry_id) === String(entry.id); })) throw new Error(tr_('psplit.noFriends'));
  var projById = projectsById_();
  var raw = payload.percents && payload.percents.length ? partsFromPercents_(Number(entry.amount), payload.percents) : payload.parts;
  var seen = {}, parts = [], companyId = '';
  raw.forEach(function (p) {
    var id = String(p.project_id || ''), amount = round2_(Number(p.amount) || 0);
    if (!(amount > 0)) return;
    var project = projById[id];
    if (!project) throw new Error(tr_('business.projectNotFound'));
    if (companyId && String(project.company_id) !== companyId) throw new Error(tr_('psplit.oneCompany'));
    companyId = String(project.company_id);
    if (seen[id]) { seen[id].amount = round2_(seen[id].amount + amount); return; }
    seen[id] = { project_id: id, amount: amount };
    parts.push(seen[id]);
  });
  if (parts.length < 2) throw new Error(tr_('psplit.twoProjects'));
  var sum = round2_(parts.reduce(function (n, p) { return n + p.amount; }, 0));
  if (Math.abs(sum - Number(entry.amount)) >= 0.005) {
    throw new Error(tr_('psplit.mustAdd', { sum: formatAmountText_(sum, entry.currency), total: formatAmountText_(Number(entry.amount), entry.currency) }));
  }
  ensureBusinessSheets_();
  deleteRowsWhere_('Project Splits', function (r) { return String(r.entry_id) === String(entry.id); });
  appendRowsBulk_('Project Splits', parts.map(function (p) { return { id: Utilities.getUuid(), entry_id: entry.id, project_id: p.project_id, amount: p.amount }; }));
  // The entry now belongs to the company, with no single project of its own (the parts say where it goes).
  setEntryField_(entry.id, 'company_id', companyId);
  setEntryField_(entry.id, 'project_id', '');
  setEntryField_(entry.id, 'expected_payment_id', '');
  touchEntriesById_([entry.id]);
  return { entry_id: entry.id, parts: parts };
}

// An edit that makes a split stop adding up (amount, currency, type, a project picked) removes it (updateEntryFields).
function dropProjectSplitIfBroken_(entryId, fields) {
  if (!fields) return;
  var touches = fields.amount !== undefined || fields.currency !== undefined || fields.type !== undefined || fields.project_id || fields.company_id !== undefined;
  if (!touches || !SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Project Splits')) return;
  var e = getEntryById_(entryId);
  if (!e) return;
  var mine = projectSplitsByEntry_()[e.id];
  if (mine && !validProjectParts_(e, mine, projectsById_())) deleteRowsWhere_('Project Splits', function (r) { return String(r.entry_id) === String(e.id); });
}

// "As last month": the latest earlier entry of the same kind (same type, same company, same shop / description) whose split still
// counts, as percentages. Only on a company copy (the owner's copy never changes). null when there is none.
function projectSplitKey_(e) {
  return [e.type, String(e.company_id || ''), searchNormalize_(String(e.merchant || e.description || '')).replace(/[^a-z]+/g, ' ').trim()].join('|');
}
function projectSplitSuggestions_(pending, all) {
  var byEntry = projectSplitsByEntry_();
  if (!Object.keys(byEntry).length) return {};
  var projById = projectsById_();
  var latest = {};
  all.forEach(function (e) {
    if (e.status !== 'confirmed' || !byEntry[e.id]) return;
    var parts = validProjectParts_(e, byEntry[e.id], projById);
    if (!parts) return;
    var k = projectSplitKey_(e);
    if (!latest[k] || String(e.date) > String(latest[k].entry.date)) latest[k] = { entry: e, parts: parts };
  });
  var out = {};
  pending.forEach(function (e) {
    if ((e.type !== 'expense' && e.type !== 'income') || e.project_id || !e.company_id) return;
    var hit = latest[projectSplitKey_(e)];
    if (!hit || String(hit.entry.date) > String(e.date)) return;
    var total = Number(hit.entry.amount), used = 0;
    var pcts = hit.parts.map(function (p, i) {
      var pct = i === hit.parts.length - 1 ? round2_(100 - used) : round2_(p.amount * 100 / total);
      used = round2_(used + pct);
      var proj = projById[p.project_id];
      return { project_id: p.project_id, name: proj ? String(proj.name) : '', pct: pct };
    });
    out[e.id] = { from_date: String(hit.entry.date), parts: pcts };
  });
  return out;
}
