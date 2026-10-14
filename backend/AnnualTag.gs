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
