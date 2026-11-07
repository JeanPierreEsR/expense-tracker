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
  // The owner's accounts are older than account kinds, so the app knows no currency for most of them and the exchange form cannot warn (owner's
  // request, 2026-11-06). Fills the `currencies` list of a savings account or card only where the app knows nothing yet, from its name or else its
  // entries. Names and kinds are never touched. DELIBERATE EXCEPTION to "a heal never rewrites data", on the owner's request. `ownerOnly`: friends' accounts stay.
  { id: 'owner-account-currencies', owner: true, ownerOnly: true, run: healAccountCurrencies_ }
];

/** Pure: the currency an account's name states ('' when none, or more than one). 'BCP soles' -> 'PEN', 'IBK dolares' -> 'USD'. */
function accountNameCurrency_(name) {
  var n = ' ' + String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9$\/]+/g, ' ') + ' ';
  var found = [];
  if (/ (sol|soles|pen) | s\/ /.test(n)) found.push('PEN');
  if (/ (dolar|dolares|dollar|dollars|usd) | us\$ /.test(n)) found.push('USD');
  if (/ (euro|euros|eur) /.test(n)) found.push('EUR');
  return found.length === 1 ? found[0] : '';
}

/** Pure: every currency with at least 10% of an account's entries (5 entries or more), most used first, or []. */
function accountEntriesCurrencies_(currencies) {
  if (currencies.length < 5) return [];
  var counts = {};
  currencies.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
  return Object.keys(counts).filter(function (c) { return counts[c] / currencies.length >= 0.1; }).sort(function (a, b) { return counts[b] - counts[a]; });
}

function healAccountCurrencies_() {
  var empty = function (pm) {   // (the same reading as the phone's accountCurrencyList_: a kind that names a currency, or a plain card, already says)
    var kind = String(pm.alias_kind || '');
    return !String(pm.currencies || '') && kind !== 'credit' && kind !== 'sueldo' && !/_[a-z]{3}$/.test(kind);
  };
  var accounts = getAllRows('Payment Methods').filter(function (pm) { return (pm.type === 'debit' || pm.type === 'credit') && empty(pm) && !isPracticeAccount_(pm); });
  if (!accounts.length) return;
  var byAccount = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.status !== 'confirmed' || !e.currency) return;
    [e.payment_method_id, e.to_payment_method_id].forEach(function (id) {
      if (id) (byAccount[String(id)] = byAccount[String(id)] || []).push(String(e.currency));
    });
  });
  ensurePaymentMethodCurrenciesColumn_();
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var changed = 0;
  accounts.forEach(function (pm) {
    var named = accountNameCurrency_(pm.nickname);
    var list = named ? [named] : accountEntriesCurrencies_(byAccount[String(pm.id)] || []);
    if (!list.length) return;
    setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, pm.id), 'currencies', accountCurrenciesValue_(list));
    changed++;
  });
  if (changed) { if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods']; bumpStructureVersion_(); }
}

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
    if (done.indexOf(heal.id) !== -1 || (!friend && !heal.owner) || (friend && heal.ownerOnly)) return;
    try {
      heal.run();
      done.push(heal.id);
      props.setProperty(HEALS_DONE_PROPERTY_, done.join(','));
    } catch (err) {
      console.error('heal ' + heal.id + ': ' + err);   // tried again at the next open
    }
  });
}
