/**
 * Mail catch-ups: a new rule in the e-mail rule pack reads the bank e-mails that arrive AFTER it, but the normal scan only looks back a few
 * days, and an e-mail no rule could read was already written down as handled. A catch-up re-reads, ONCE per copy, that rule's e-mails since
 * the copy was first used, so what the person missed lands in Needs review (owner, 2026-11-20: Mia's BCP credit-card purchases, never read
 * before the pack rule `bcp-consumo-credito`).
 *  - Friends' copies only, and only once the pack that has the rule is in the copy (a catch-up run with the old rules would read nothing and be
 *    spent); until then it waits, and is tried again after each scan.
 *  - Only that rule's e-mails are used (ONLY_PACK_IDS_, EmailParser.gs): every other kind of e-mail was already decided, and an entry the
 *    person discarded must not come back.
 *  - It is the usual back-check: an e-mail already in Entries is skipped by its reference, one that looks like an entry typed by hand (same
 *    amount, around the same day) is left out, everything made is pending (principle 6).
 * Add a new catch-up at the END with a new id; never reuse or rename one (the done ids are kept in MAIL_CATCHUPS_DONE).
 */

var MAIL_CATCHUPS_DONE_PROPERTY_ = 'MAIL_CATCHUPS_DONE';
var MAIL_CATCHUP_MAX_DAYS_ = 90;

var MAIL_CATCHUPS_ = [
  { id: 'bcp-credit-purchases', packId: 'bcp-consumo-credito', sender: 'notificaciones@notificacionesbcp.com.pe' }
];

// Days to look back: from the day the copy was first used (Loans.gs firstUseDate_), at least the usual 3, at most MAIL_CATCHUP_MAX_DAYS_.
function mailCatchupDays_() {
  var first = firstUseDate_();
  var days = MAIL_CATCHUP_MAX_DAYS_;
  if (/^\d{4}-\d{2}-\d{2}$/.test(first)) {
    var p = first.split('-');
    days = Math.ceil((Date.now() - Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]))) / 86400000) + 1;
  }
  return Math.max(3, Math.min(MAIL_CATCHUP_MAX_DAYS_, days));
}

// Runs the catch-ups that are due; what they make is added to the scan's results (so the app's "new" count includes it).
function runMailCatchups_(scanResults) {
  if (!isFriendCopy_()) return;
  var props = PropertiesService.getScriptProperties();
  var done = String(props.getProperty(MAIL_CATCHUPS_DONE_PROPERTY_) || '').split(',').filter(function (id) { return id; });
  var packIds = rulePackRules_().map(function (r) { return r.packId; });
  MAIL_CATCHUPS_.forEach(function (c) {
    if (done.indexOf(c.id) !== -1 || packIds.indexOf(c.packId) === -1) return;   // done, or its rule has not arrived yet
    var res = processEmails({ days: mailCatchupDays_(), senders: [c.sender], onlyPackIds: [c.packId] });
    done.push(c.id);
    props.setProperty(MAIL_CATCHUPS_DONE_PROPERTY_, done.join(','));
    if (scanResults && res) scanResults.created = (Number(scanResults.created) || 0) + (Number(res.created) || 0);
    console.log('mail catch-up ' + c.id + ': ' + JSON.stringify({ created: res && res.created, overlaps: res && res.overlaps }));
  });
}
