/**
 * The "Annual" tag (added 2026-10-14) — a built-in tag, available on any
 * entry in any category. Its only job is to CLEAN the monthly picture: an
 * expense carrying it is a lump that happens once in a while (car
 * maintenance, a yearly fee), so it must not be smoothed into every month's
 * "Expected" figure on Projections, nor eat into a MONTHLY budget. It never
 * creates a projection of its own — only items set up as Programmed
 * (recurring) are projected. See specs/entries-and-categories.md § Tags.
 *
 * Identified by a fixed id (not by name), so it keeps working whichever
 * language is shown. Stored with the English name; shown translated
 * (tagLabel_), like a built-in category.
 */

var ANNUAL_TAG_ID = 'system-annual';

// Creates the tag the first time it is needed (getMeta calls this).
function ensureAnnualTag_() {
  var has = getAllRowsCached_('Tags').some(function (t) { return t.id === ANNUAL_TAG_ID; });
  if (!has) appendRowObject('Tags', { id: ANNUAL_TAG_ID, name: 'Annual', color: '#E8C9A0' });
}

// "annual"/"anual" typed as a new tag's name means the built-in one.
function isAnnualTagName_(name) {
  var n = searchNormalize_(String(name || '').trim());
  return n === 'annual' || n === 'anual';
}

// What to SHOW for a tag. Only the built-in one is translated; tags the
// owner created show exactly as typed.
function tagLabel_(tag, langOverride) {
  if (!tag) return '';
  if (tag.id === ANNUAL_TAG_ID) {
    var lang = langOverride || currentLang_();
    return tr_('tag.annual', null, lang);
  }
  return tag.name;
}

// A copy of the tag rows with `name` as it should be shown (what the app receives).
function localizeTags_(rows, langOverride) {
  return rows.map(function (t) {
    var copy = {};
    Object.keys(t).forEach(function (k) { copy[k] = t[k]; });
    copy.name = tagLabel_(t, langOverride);
    return copy;
  });
}

// Both languages, so a search finds the tag whichever one is typed.
function tagSearchNames_(tag) {
  if (tag.id === ANNUAL_TAG_ID) return tagLabel_(tag, 'en') + ' ' + tagLabel_(tag, 'es');
  return tag.name;
}

// { entryId: true } for every entry carrying the Annual tag.
function annualEntryIdSet_() {
  var set = {};
  getAllRows('Entry Tags').forEach(function (et) {
    if (et.tag_id === ANNUAL_TAG_ID) set[et.entry_id] = true;
  });
  return set;
}

// ---- Travel is Annual by default (2026-10-19) ----
// A trip is a lump, not month-to-month spend, so every confirmed Travel
// expense carries the Annual tag. Past entries get it once through the sheet
// menu (adminTagTravelAnnual); new ones get it here, whichever door they come
// in by. On the entry form the chip is pre-selected when Travel is picked and
// can still be un-ticked by hand. See specs/entries-and-categories.md § Tags.

function isTravelCategoryRow_(c) {
  return !!c && (c.key === 'travel' || (!c.key && String(c.name).trim() === 'Travel'));
}

// { categoryId: true } for the Travel category and its sub-categories.
function travelCategoryIdSet_() {
  var cats = getAllRows('Categories').filter(function (c) { return c.type === 'expense'; });
  var set = {};
  cats.forEach(function (c) { if (isTravelCategoryRow_(c)) set[c.id] = true; });
  cats.forEach(function (c) { if (c.parent_id && set[c.parent_id]) set[c.id] = true; });
  return set;
}

function isTravelExpense_(entry, travelIds) {
  return !!entry && entry.type === 'expense' && !!(travelIds || travelCategoryIdSet_())[entry.category_id];
}

// Adds Annual to this entry unless it already has it. Returns true if it added one.
function ensureAnnualOnEntry_(entryId) {
  ensureAnnualTag_();
  var has = getAllRows('Entry Tags').some(function (et) { return et.entry_id === entryId && et.tag_id === ANNUAL_TAG_ID; });
  if (has) return false;
  appendRowObject('Entry Tags', { entry_id: entryId, tag_id: ANNUAL_TAG_ID });
  return true;
}

// For an entry that was just written (any door): Annual if it is a Travel expense.
function autoTagTravelEntry_(entry) {
  if (isTravelExpense_(entry)) ensureAnnualOnEntry_(entry.id);
}

// One-off for the entries already in the sheet: every confirmed Travel expense
// gets Annual. Preview by default (dryRun !== false), never double-tags.
function adminTagTravelAnnual(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var travelIds = travelCategoryIdSet_();
  var annual = annualEntryIdSet_();
  var report = { dryRun: dryRun, travelCategories: Object.keys(travelIds).length, expenses: 0, alreadyAnnual: 0, tagged: 0 };
  var toTag = [];
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || !isTravelExpense_(e, travelIds)) return;
    report.expenses++;
    if (annual[e.id]) report.alreadyAnnual++;
    else toTag.push(e.id);
  });
  report.tagged = toTag.length;
  if (!dryRun && toTag.length) {
    ensureAnnualTag_();
    withWriteBatch_(function () {
      toTag.forEach(function (id) { appendRowObject('Entry Tags', { entry_id: id, tag_id: ANNUAL_TAG_ID }); });
    });
  }
  return report;
}

function travelAnnualText_(r) {
  if (!r.travelCategories) return 'No Travel category was found, so nothing would change.';
  return (r.dryRun ? 'Would tag ' : 'Tagged ') + r.tagged + ' Travel expense(s) as Annual.\n' +
    r.alreadyAnnual + ' of the ' + r.expenses + ' confirmed Travel expense(s) already had it.';
}

function menuTagTravelAnnualPreview() {
  SpreadsheetApp.getUi().alert('Tag Travel as Annual', travelAnnualText_(adminTagTravelAnnual({ dryRun: true })), SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuTagTravelAnnualApply() {
  var ui = SpreadsheetApp.getUi();
  var preview = travelAnnualText_(adminTagTravelAnnual({ dryRun: true }));
  var answer = ui.alert('Tag Travel as Annual?', preview + '\n\nApply now?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  ui.alert('Tag Travel as Annual', travelAnnualText_(adminTagTravelAnnual({ dryRun: false })), ui.ButtonSet.OK);
}
