/**
 * What each bank's e-mails cover (More → Bank emails, "By bank"; owner's design 2026-11-03).
 *
 * For every bank the app can read, the KINDS of transaction its e-mail rules cover, each with the day an e-mail of that kind last became an
 * entry in THIS person's copy ('' = none has arrived yet). Whether a bank e-mails a given person depends on that person's alert settings,
 * so the app never says "arrives" on its own: a day = "arrived in your mailbox", no day = "can arrive, if your alert is on".
 * `none` lists kinds with no e-mail at all, only where the owner confirmed it (BANK_NO_EMAIL_FACTS_). Anything else is simply not listed.
 *
 * The kinds come from the rules themselves (bankKindOfRule_), so the screen cannot claim something the app cannot read.
 */

var BANK_KIND_ORDER_ = ['purchase', 'bill', 'transfer_out', 'plin_out', 'yape_out', 'yape_in', 'card_payment', 'insurance', 'receipt', 'other'];

// Confirmed by the owner (2026-11-03): banks send no e-mail for money received in an account (the "What emails do not cover" note said
// so since 2026-10-23). Nothing is declared for Yape received: the Yape app may or may not e-mail it, and BCP's own e-mail is per person.
var BANK_NO_EMAIL_FACTS_ = { BCP: ['money_in'], Interbank: ['money_in'], SIP: ['money_in'] };

/** Pure: the coarse kind one e-mail rule reads, from its label (code rules and pack rules alike). */
function bankKindOfRule_(rule) {
  var label = String((rule && rule.label) || '').toLowerCase();
  if (/yapeo recibido/.test(label)) return 'yape_in';
  if (/yapeo enviado/.test(label)) return 'yape_out';
  if (/plin/.test(label)) return 'plin_out';
  if (/pago de (tarjeta|deuda)/.test(label)) return 'card_payment';
  if (/seguro/.test(label)) return 'insurance';
  if (/pago de servicio/.test(label)) return 'bill';
  if (/transferencia|enviar a celular/.test(label)) return 'transfer_out';
  if (/consumo/.test(label)) return 'purchase';
  if (/recibo|viaje/.test(label)) return 'receipt';
  return 'other';
}

// Settings `bank_mail_seen_kinds` = JSON {bank: {kind: 'yyyy-mm-dd'}}: the day of the newest e-mail of each kind that became an entry.
// JSON on purpose (a bare date in a Settings cell turns into a date in Sheets). Starts empty: it fills as e-mails arrive.
function bankKindSeenMap_(settings) {
  try {
    var map = JSON.parse(String((settings || getSettingsMap()).bank_mail_seen_kinds || '{}'));
    return (map && typeof map === 'object') ? map : {};
  } catch (err) { return {}; }
}

function noteBankKindSeen_(rule, dateStr) {
  if (!rule || !rule.bank || !dateStr) return;
  var kind = bankKindOfRule_(rule);
  var map = bankKindSeenMap_();
  var byBank = map[rule.bank] && typeof map[rule.bank] === 'object' ? map[rule.bank] : (map[rule.bank] = {});
  if (byBank[kind] && String(byBank[kind]) >= String(dateStr)) return;   // only a newer day changes anything (each change bumps the sheet cache)
  byBank[kind] = String(dateStr);
  setSetting_('bank_mail_seen_kinds', JSON.stringify(map));
}

// One-time catch-up (2026-11-05): the per-kind days only started filling on 2026-11-03, so a kind that last arrived before that (or whose
// e-mails are rare) read "Can arrive if this alert is on" although it does arrive. Once per copy, at the end of a normal scan, the last 90 days
// of each bank sender are read again with the rules: an e-mail of a kind counts only when its entry is still in Entries (the same "really became
// an entry" rule as noteBankKindSeen_). It writes the Setting once and never changes an entry. Script property BANK_KINDS_BACKFILLED marks it done.
var BANK_KINDS_BACKFILL_PROPERTY_ = 'BANK_KINDS_BACKFILLED';
var BANK_KINDS_BACKFILL_DAYS_ = 90;

function backfillBankKindDaysOnce_(senders, existingExternalIds) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(BANK_KINDS_BACKFILL_PROPERTY_)) return;
  var tz = Session.getScriptTimeZone();
  var found = {};   // bank -> kind -> newest day
  senders.forEach(function (sender) {
    gmailSearchMessages_('from:' + sender + ' newer_than:' + BANK_KINDS_BACKFILL_DAYS_ + 'd', { max: 300 }).forEach(function (message) {
      try {
        var read = readEmailWithRules_(sender, message.getSubject(), message.getPlainBody());
        if (!read.rule || !read.rule.bank || !read.fields) return;
        var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
        if (!existingExternalIds[computeEmailExternalId_(sender, dateStr, read.fields, message.getId())]) return;
        var kind = bankKindOfRule_(read.rule);
        var byBank = found[read.rule.bank] || (found[read.rule.bank] = {});
        if (!byBank[kind] || byBank[kind] < dateStr) byBank[kind] = dateStr;
      } catch (err) { /* one e-mail that cannot be read again changes nothing */ }
    });
  });
  var map = mergeBankKindDays_(bankKindSeenMap_(), found);
  if (JSON.stringify(map) !== JSON.stringify(bankKindSeenMap_())) setSetting_('bank_mail_seen_kinds', JSON.stringify(map));
  props.setProperty(BANK_KINDS_BACKFILL_PROPERTY_, Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'));
}

/** Pure: the per-kind days with the newer day of the two for every bank and kind. */
function mergeBankKindDays_(map, found) {
  var out = JSON.parse(JSON.stringify(map || {}));
  Object.keys(found || {}).forEach(function (bank) {
    var byBank = out[bank] && typeof out[bank] === 'object' ? out[bank] : (out[bank] = {});
    Object.keys(found[bank]).forEach(function (kind) {
      if (!byBank[kind] || String(byBank[kind]) < String(found[bank][kind])) byBank[kind] = String(found[bank][kind]);
    });
  });
  return out;
}

/** { <bank>: { kinds: [{ key, seen }], none: [key] } } for every bank with a (non-ignored) rule. */
function bankCoverage_(settings) {
  var kindSeen = bankKindSeenMap_(settings);
  var bankSeen = bankMailSeenMap_(settings);
  var out = {};
  emailRules_().forEach(function (r) {
    if (!r.bank || r.skip) return;
    var kind = bankKindOfRule_(r);
    var b = out[r.bank] || (out[r.bank] = { kinds: [], none: (BANK_NO_EMAIL_FACTS_[r.bank] || []).slice() });
    if (b.kinds.some(function (k) { return k.key === kind; })) return;
    var day = (kindSeen[r.bank] && kindSeen[r.bank][kind]) || (r.bank === 'Yape' ? bankSeen.Yape : '') || '';   // Yape only has one kind: its old per-bank day counts
    b.kinds.push({ key: kind, seen: String(day) });
  });
  Object.keys(out).forEach(function (bank) {
    out[bank].kinds.sort(function (a, b) { return BANK_KIND_ORDER_.indexOf(a.key) - BANK_KIND_ORDER_.indexOf(b.key); });
  });
  return out;
}
