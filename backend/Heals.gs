/**
 * Heals: one-time repairs a copy needs because an UPDATE only swaps the code (2026-10-28).
 *
 * A fresh install builds its Sheet with today's rules (time zone, formats, starter data); a copy installed earlier keeps whatever it was built
 * with — the update page replaces the files and nothing else (docs/setup/Install.gs builds the Sheet once, never again). Anything a fix needs to
 * change in an EXISTING Sheet or its settings therefore goes here, as an entry in HEALS_: each runs once per copy (the ids already done are kept in
 * the script property HEALS_DONE), on the first app open after the update (getMeta), on friends' copies only (a heal marked `owner: true`
 * also runs on the owner's copy). Rules for a heal:
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
  { id: 'sheet-time-zone', run: healSheetTimeZone_ },
  // Pause was removed from Programmed items (2026-10-31). A paused repeating item is turned into an ended one (end date = its last paid occurrence)
  // so every figure stays exactly the same and nobody has to decide. DELIBERATE EXCEPTION to "a heal never rewrites data" (owner's OK, 2026-11-01):
  // it changes two fields of those items (Active, End date) and loses nothing. See convertPausedProgrammed_ in RecurringExpenses.gs.
  { id: 'paused-programmed-to-ended', run: function () { convertPausedProgrammed_(); } },
  // The built-in cash account was named before the welcome chose the language, so Spanish copies show "Cash" (2026-11-04). It is renamed
  // to the copy's language only while it still has the built-in name (relocalizeCashName_, Accounts.gs); a typed name stays.
  { id: 'cash-name-language', run: function () { relocalizeCashName_(currentLang_()); } },
  // More -> Bank emails names the inbox the app reads. A copy that cannot ask Google for its own address (the owner's: full Gmail access,
  // no "see your address" permission) showed "the account you signed in with" instead (2026-11-05). This heal reads the address once from
  // the To line of a bank e-mail already in the inbox and keeps it (MAILBOX_ADDRESS). Runs on the owner's copy too (`owner: true`).
  { id: 'mailbox-address-to-line', owner: true, run: healMailboxAddressFromToLine_ },
  // Payors and friends became one list of people (2026-11-09). A payor with a friend's exact name is that friend; everyone else is added with their own id,
  // so past income keeps its payer. DELIBERATE EXCEPTION to "a heal never rewrites data" (owner's OK, 2026-11-09): only the payer of those same-name incomes
  // changes, and the old Payors tab stays as it was. Since 1.76.1 (owner) a copy where a payer and a friend share a name is asked first, in the
  // app, like the owner's (payorMergeAskForApp_); the heal merges by itself only when no name is shared.
  { id: 'payors-into-friends', run: function () { mergePayorsIfNothingShared_(); } },
  // Repayments saved before 2026-10-27 that came in as two entries (what the loans took + an extra income/expense) were linked only when
  // someone opened that person's repayment history, so a bank statement showed their single line as "not in the app" (owner, 2026-11-10).
  // Links every unambiguous one once (linkAllEarlierGapEntries_, Loans.gs). Adds a link only; no amount, date or entry changes.
  { id: 'link-old-repayment-extras', owner: true, run: function () { linkAllEarlierGapEntries_(); } },
  // That linking once paired a repayment with an extra entry in another currency (shown as one total in the wrong currency; testers,
  // 2026-11-10). Takes back only such links; the linking itself now checks the currency.
  { id: 'unlink-cross-currency-extras', owner: true, run: function () { unlinkCrossCurrencyGapEntries_(); } }
];

function healMailboxAddressFromToLine_() {
  var props = PropertiesService.getScriptProperties();
  if (!featureOn_('gmail') || props.getProperty('MAILBOX_ADDRESS') || mailboxAddress_()) return;
  var senders = uniqueSenders_();
  for (var i = 0; i < senders.length; i++) {
    var msgs = gmailSearchMessages_('from:' + senders[i] + ' newer_than:180d', { max: 3 });
    for (var j = 0; j < msgs.length; j++) {
      var address = firstAddressIn_(msgs[j].getTo());
      if (address) { props.setProperty('MAILBOX_ADDRESS', address); return; }
    }
  }
}

/** Pure: the first e-mail address in a header such as 'Ana Lo <ana@example.com>, b@example.com' ('' when none). */
function firstAddressIn_(header) {
  var m = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i.exec(String(header || ''));
  return m ? m[0].toLowerCase() : '';
}

function healSheetTimeZone_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var want = Session.getScriptTimeZone();
  if (!want) return;
  if (ss.getSpreadsheetTimeZone() !== want) ss.setSpreadsheetTimeZone(want);
}

function runHealsOnce_() {
  var friend = isFriendCopy_();   // the owner's own copy is looked after by hand, except for a heal marked `owner: true`
  if (!friend && !HEALS_.some(function (h) { return h.owner; })) return;
  var props = PropertiesService.getScriptProperties();
  var done = String(props.getProperty(HEALS_DONE_PROPERTY_) || '').split(',').filter(function (id) { return id; });
  HEALS_.forEach(function (heal) {
    if (done.indexOf(heal.id) !== -1 || (!friend && !heal.owner)) return;
    try {
      heal.run();
      done.push(heal.id);
      props.setProperty(HEALS_DONE_PROPERTY_, done.join(','));
    } catch (err) {
      console.error('heal ' + heal.id + ': ' + err);   // tried again at the next open
    }
  });
}
