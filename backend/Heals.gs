/**
 * Heals: one-time repairs a copy needs because an UPDATE only swaps the code (2026-10-28).
 *
 * A fresh install builds its Sheet with today's rules (time zone, formats, starter data); a copy installed earlier keeps whatever it was built
 * with — the update page replaces the files and nothing else (docs/setup/Install.gs builds the Sheet once, never again). Anything a fix needs to
 * change in an EXISTING Sheet or its settings therefore goes here, as an entry in HEALS_: each runs once per copy (the ids already done are kept in
 * the script property HEALS_DONE), on the first app open after the update (getMeta), on friends' copies only. Rules for a heal:
 *  - idempotent: running it twice must change nothing the second time;
 *  - it never loses or rewrites the person's data (it may fix a setting or add structure);
 *  - a failure is only logged and leaves the id undone, so the next open tries again; it never breaks the request;
 *  - add new ones at the END and never reuse or rename an id.
 * What a heal cannot do: repair data already damaged (a date a wrong server stored); that needs a tool of its own.
 */

var HEALS_DONE_PROPERTY_ = 'HEALS_DONE';

var HEALS_ = [
  // Sheets made before 2026-10-25 have no time zone of their own (GMT, most likely) while the script runs in another: the app then had to read
  // dates through two zones, and a server that did not (an old one) read them a day early. Aligning the Sheet's zone with the script's removes
  // the mismatch for every version of the code. A date cell holds the day as written (a serial number), so changing the zone changes no date.
  { id: 'sheet-time-zone', run: healSheetTimeZone_ }
];

function healSheetTimeZone_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var want = Session.getScriptTimeZone();
  if (!want) return;
  if (ss.getSpreadsheetTimeZone() !== want) ss.setSpreadsheetTimeZone(want);
}

function runHealsOnce_() {
  if (!isFriendCopy_()) return;   // the owner's own copy is looked after by hand
  var props = PropertiesService.getScriptProperties();
  var done = String(props.getProperty(HEALS_DONE_PROPERTY_) || '').split(',').filter(function (id) { return id; });
  HEALS_.forEach(function (heal) {
    if (done.indexOf(heal.id) !== -1) return;
    try {
      heal.run();
      done.push(heal.id);
      props.setProperty(HEALS_DONE_PROPERTY_, done.join(','));
    } catch (err) {
      console.error('heal ' + heal.id + ': ' + err);   // tried again at the next open
    }
  });
}
