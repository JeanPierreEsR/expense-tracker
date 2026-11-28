/**
 * Tidy Sheet tabs (owner, 2026-11-28: "the Google Sheet looks very disorganized"). A copy's Sheet had ~67 tabs in no order: Google puts
 * every tab the app adds right after the first one, so the newest (often empty) tabs sat in front and Entries, Categories and Settings at
 * the far end. The app finds every tab by its NAME only, so order, colour, frozen header and hidden/shown change nothing for it.
 *
 * Once per copy (heal `tidy-sheet-tabs`, Heals.gs, every copy): tabs are put in six groups, in this order and colour; the app's own logs
 * are hidden (View → Hidden sheets shows them again); every app tab gets its header row frozen; an empty leftover "Sheet1" is removed.
 * A tab the app does not know (one the person made) is left as it is, after the app's tabs.
 * Afterwards (`placeNewSheetTabs_`, in the hourly part of the timer): only a tab NOT seen before is put at the end of its group, coloured,
 * frozen and (a log) hidden. Tabs already seen stay wherever the person has them: a tab moved or shown by hand is never moved back.
 * Never renames a tab, never moves a column, never touches a cell.
 */

var SHEET_TABS_SEEN_PROPERTY_ = 'SHEET_TABS_SEEN';

function sheetTabGroups_() {
  var business = (typeof BUSINESS_TABLES_ !== 'undefined' ? Object.keys(BUSINESS_TABLES_) : []).concat(['Month Closes']);
  return [
    { key: 'money', color: '#34a853', tabs: ['Entries', 'Categories', 'Tags', 'Entry Tags', 'Entry Splits', 'Payment Methods', 'Banks',
      'Account Opening Balances', 'Budgets', 'Recurring Expenses', 'Recurring Expense Splits', 'Recurring Skips', 'Trips', 'Exchange Rates',
      'Settings'] },
    { key: 'people', color: '#4285f4', tabs: ['Friends', 'Payors', 'Loans', 'Settlements', 'Loan Installments'] },
    { key: 'planning', color: '#a142f4', tabs: ['Projection Overrides', 'Period Templates', 'Budget History', 'Budget Alert Log',
      'Loan Alert Log', 'Notices'] },
    { key: 'in', color: '#fa7b17', tabs: ['Statement Inbox', 'Statement Uploads', 'Statement Lines', 'Statement Changes', 'Statement Formats',
      'Statement Senders', 'Statement Gaps', 'Import Batches', 'Photo Jobs', 'Entry Bills', 'Account Moves', 'Parsing Rules',
      'Category Keywords', 'Payee Habits', 'Email Accounts', 'Unread Emails', 'Processed Emails'] },
    { key: 'business', color: '#9aa0a6', tabs: business },
    { key: 'logs', color: null, hidden: true, tabs: ['Perf Reports', 'Beta Events', 'Sessions', 'Telegram Messages', 'Bot Actions',
      'Statement Samples', 'Bank Samples', 'Deleted Entries', 'Entry Deletions', 'Exchange Rates before USD', 'Feedback', 'Change Log'] }
  ];
}

/** Pure: name → { group, rank } (rank = its place in the whole tidy order), for every tab the app makes. */
function sheetTabPlaces_() {
  var places = {}, rank = 0;
  sheetTabGroups_().forEach(function (g) {
    g.tabs.forEach(function (name) { if (!places[name]) places[name] = { group: g, rank: rank++ }; });
  });
  return places;
}

/** Pure: the order the full tidy wants: the app's tabs by rank, then the person's own tabs in the order they were. */
function sheetTabsWantedOrder_(names) {
  var places = sheetTabPlaces_();
  var known = names.filter(function (n) { return places[n]; }).sort(function (a, b) { return places[a].rank - places[b].rank; });
  return known.concat(names.filter(function (n) { return !places[n]; }));
}

// A sheet's look for its group: colour, frozen header, hidden for a log. Each call is skipped when already so.
function sheetTabDress_(sheet, group) {
  var color = group.color || null;
  if (String(sheet.getTabColor() || '') !== String(color || '')) sheet.setTabColor(color);
  if (!sheet.getFrozenRows() && sheet.getLastRow() >= 1) sheet.setFrozenRows(1);
  if (group.hidden && !sheet.isSheetHidden()) sheet.hideSheet();
}

function sheetTabMove_(ss, sheet, position) {
  ss.setActiveSheet(sheet);
  ss.moveActiveSheet(position);   // 1-based
}

// An empty tab Google made with the Sheet ("Sheet1", "Hoja 1"): nothing in it and never used by the app.
function sheetTabIsEmptyLeftover_(sheet) {
  return /^(sheet ?1|hoja ?1)$/i.test(sheet.getName()) && sheet.getLastRow() === 0 && sheet.getLastColumn() === 0;
}

/** The full tidy, once per copy (heal). Returns what it did, for the log and the tests. */
function tidySheetTabs_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var done = { moved: 0, removed: [] };
  ss.getSheets().forEach(function (sh) {
    if (ss.getSheets().length > 1 && sheetTabIsEmptyLeftover_(sh)) { ss.deleteSheet(sh); done.removed.push(sh.getName()); }
  });
  var sheets = ss.getSheets();
  var byName = {};
  sheets.forEach(function (sh) { byName[sh.getName()] = sh; });
  var current = sheets.map(function (sh) { return sh.getName(); });
  var wanted = sheetTabsWantedOrder_(current);
  for (var i = 0; i < wanted.length; i++) {
    if (current[i] === wanted[i]) continue;
    sheetTabMove_(ss, byName[wanted[i]], i + 1);
    current.splice(current.indexOf(wanted[i]), 1);
    current.splice(i, 0, wanted[i]);
    done.moved++;
  }
  if (byName.Entries) ss.setActiveSheet(byName.Entries);   // never leave a tab about to be hidden as the open one
  var places = sheetTabPlaces_();
  current.forEach(function (name) {
    if (!places[name]) return;
    try { sheetTabDress_(byName[name], places[name].group); } catch (err) { console.error('tidy tab ' + name + ': ' + err); }
  });
  PropertiesService.getScriptProperties().setProperty(SHEET_TABS_SEEN_PROPERTY_, JSON.stringify(current));
  return done;
}

/** Hourly: a tab the app added since the tidy goes to the end of its group, with its group's look. Nothing else moves. */
function placeNewSheetTabs_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(SHEET_TABS_SEEN_PROPERTY_);
  if (!raw) return 0;   // this copy was never tidied (the heal does it first)
  var seen = {};
  try { JSON.parse(raw).forEach(function (n) { seen[n] = true; }); } catch (err) { return 0; }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var fresh = sheets.filter(function (sh) { return !seen[sh.getName()]; });
  if (!fresh.length) return 0;
  var places = sheetTabPlaces_();
  var placed = 0;
  fresh.forEach(function (sh) {
    var name = sh.getName();
    seen[name] = true;
    var place = places[name];
    if (!place) return;   // the person's own tab: left where they put it
    // After the last tab that comes before it in the tidy order (its group's, or an earlier group's); first when there is none.
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    var after = -1;
    names.forEach(function (n, i) { if (n !== name && places[n] && places[n].rank < place.rank && seen[n]) after = i; });
    var from = names.indexOf(name);
    var position = after + 1 + (from <= after ? 0 : 1);   // 1-based; moving it out first shifts the ones after it
    try {
      if (from !== position - 1) sheetTabMove_(ss, sh, position);
      var entries = ss.getSheetByName('Entries');
      if (entries && place.group.hidden) ss.setActiveSheet(entries);
      sheetTabDress_(sh, place.group);
      placed++;
    } catch (err) { console.error('place tab ' + name + ': ' + err); }
  });
  props.setProperty(SHEET_TABS_SEEN_PROPERTY_, JSON.stringify(Object.keys(seen)));
  return placed;
}
