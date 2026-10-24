/**
 * E-mail coverage: "did every e-mail that can be a transaction become an entry (or a known, harmless skip)?"
 * Plan: "Email coverage plan - read every transaction e-mail (DRAFT).md" (P4 + P1). Rule-based, no AI, read-only except
 * that processEmails (EmailParser.gs) uses the overlap helpers during a back-check.
 *
 * Overlap rule: an e-mail whose date (+-1 day), currency and amount match an entry that did NOT come from e-mail (typed by
 * hand, imported from a statement/Spendee, a photo) is probably the same payment already recorded, under another reference
 * number, so a back-check lists it instead of creating a second entry. Each existing entry covers ONE e-mail, so ten real
 * 140.00 transfers on one day are not swallowed by a single entry. Entries that came from e-mail are left out on purpose: two
 * taxi rides of the same price on one day are two e-mails and two entries.
 */

var COVERAGE_MAX_DAYS_ = 120;
var COVERAGE_LIST_CAP_ = 15;

function overlapDayNumber_(dateStr) {
  var m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : null;
}

function overlapKey_(currency, amount) { return String(currency) + '|' + Number(amount).toFixed(2); }

// currency|amount -> [{day, source, type, used}] for every entry not created from e-mail.
function buildEntryOverlapIndex_() {
  var index = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.source === 'email') return;
    var day = overlapDayNumber_(e.date);
    if (day === null || !(Number(e.amount) > 0)) return;
    var key = overlapKey_(e.currency, e.amount);
    (index[key] = index[key] || []).push({ day: day, source: String(e.source || ''), type: String(e.type || ''), used: false });
  });
  return index;
}

// The existing entry this e-mail most likely duplicates (and uses it up), or null.
function takeOverlap_(index, currency, amount, dateStr) {
  var day = overlapDayNumber_(dateStr);
  var list = index && index[overlapKey_(currency, amount)];
  if (day === null || !list) return null;
  for (var i = 0; i < list.length; i++) {
    if (!list[i].used && Math.abs(list[i].day - day) <= 1) { list[i].used = true; return list[i]; }
  }
  return null;
}

// A money amount AND a payment-ish word. A heuristic: it will sometimes pick a promotion ("S/ 9.90 ... pago"), never meant to be exact.
function looksLikeTransaction_(subject, body) {
  var text = String(subject || '') + ' ' + String(body || '').slice(0, 3000);
  var hasMoney = /(S\/\.?|US\$|\$)\s*\d/.test(text);
  var hasWord = /(consumo|compra|pago|transferencia|transferiste|yape|plin|retiro|dep[oó]sito|cargo|boleta|factura|comprobante|recibo|constancia|operaci[oó]n|suscripci[oó]n|pedido|purchase|payment|receipt|invoice|charged)/i.test(text);
  return hasMoney && hasWord;
}

function coverageAddShape_(list, subject, dateStr) {
  var shape = unreadSubjectShape_(subject);
  var row = list.filter(function (r) { return r.shape === shape; })[0];
  if (row) { row.count++; if (dateStr > row.last) row.last = dateStr; }
  else list.push({ shape: shape, count: 1, last: dateStr });
}

function coverageTop_(list) {
  return list.sort(function (a, b) { return b.count - a.count; }).slice(0, COVERAGE_LIST_CAP_);
}

function coverageAddress_(from) {
  var m = String(from || '').match(/<([^>]+)>/);
  return String(m ? m[1] : from || '').trim().toLowerCase();
}

/**
 * Read-only. For each sender that has rules (or `payload.senders`), over the last `payload.days` (default 30, at most 120):
 * how many e-mails there were and what became of each —
 *   parsed         an entry with that e-mail's reference number exists
 *   coveredElsewhere  no such entry, but an entry from another source matches (see the overlap rule)
 *   missing        a rule read it, but no entry exists (or it was discarded since) — date, amount, rule
 *   unreadable     a rule matched but could not read the amount (grouped by subject wording)
 *   noRule         transaction-looking, no rule matches (grouped by subject wording)
 *   notTransaction no rule, and it does not look like a payment (security codes, statements…)
 *   ignored        a rule that skips on purpose
 * plus `unknownSenders`: senders WITHOUT any rule whose recent e-mail looks like a transaction.
 */
function emailCoverageReport_(payload) {
  payload = payload || {};
  var days = Math.min(Math.max(Number(payload.days) || 30, 1), COVERAGE_MAX_DAYS_);
  var ruleSenders = uniqueSenders_();
  var senders = (payload.senders && payload.senders.length) ? payload.senders : ruleSenders;
  var tz = Session.getScriptTimeZone();
  var existingIds = {};
  getAllRows('Entries').forEach(function (e) { if (e.external_id) existingIds[e.external_id] = true; });
  var overlap = buildEntryOverlapIndex_();
  var report = { days: days, senders: [], unknownSenders: [], totals: { emails: 0, parsed: 0, coveredElsewhere: 0, missing: 0, unreadable: 0, noRule: 0 } };

  senders.forEach(function (sender) {
    var s = { sender: sender, emails: 0, parsed: 0, coveredElsewhere: 0, ignored: 0, notTransaction: 0, missing: [], unreadable: [], noRule: [] };
    gmailSearchMessages_('from:' + sender + ' newer_than:' + days + 'd', { max: 200 }).forEach(function (message) {
      var subject = message.getSubject();
      var body = message.getPlainBody();
      var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
      s.emails++;
      var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; }).find(function (r) { return r.match(subject, body); });
      if (!rule) {
        if (looksLikeTransaction_(subject, body)) coverageAddShape_(s.noRule, subject, dateStr); else s.notTransaction++;
        return;
      }
      if (rule.skip) { s.ignored++; return; }
      if (rule.exchange) {
        // An exchange house's confirmation is two legs: parsed when both exist (made by it, or the same leg from another source).
        var x = parseExchangeConfirmation_(subject, body);
        if (!x) { coverageAddShape_(s.unreadable, subject, dateStr); return; }
        var key = exchangeCodeKey_(x.code);
        var entries = getAllRows('Entries');
        var outOk = existingIds['cm-out-' + key] || findExchangeLegTwin_(entries, 'out', x.out.currency, x.out.amount, dateStr, key, 'house');
        var inOk = existingIds['cm-in-' + key] || findExchangeLegTwin_(entries, 'in', x.in.currency, x.in.amount, dateStr, key, 'house');
        if (outOk && inOk) s.parsed++;
        else s.missing.push({ date: dateStr, amount: !outOk ? x.out.amount : x.in.amount, currency: !outOk ? x.out.currency : x.in.currency, rule: rule.label });
        return;
      }
      var fields = rule.extract(subject, body);
      if (!fields) { coverageAddShape_(s.unreadable, subject, dateStr); return; }
      if (existingIds[computeEmailExternalId_(sender, dateStr, fields, message.getId())]) { s.parsed++; return; }
      if (takeOverlap_(overlap, fields.currency, fields.amount, dateStr)) { s.coveredElsewhere++; return; }
      s.missing.push({ date: dateStr, amount: fields.amount, currency: fields.currency, rule: rule.label });
    });
    var t = report.totals;
    t.emails += s.emails; t.parsed += s.parsed; t.coveredElsewhere += s.coveredElsewhere;
    t.missing += s.missing.length;
    t.unreadable += s.unreadable.reduce(function (n, r) { return n + r.count; }, 0);
    t.noRule += s.noRule.reduce(function (n, r) { return n + r.count; }, 0);
    s.unreadable = coverageTop_(s.unreadable);
    s.noRule = coverageTop_(s.noRule);
    s.missing = s.missing.slice(0, 40);
    if (s.emails) report.senders.push(s);
  });

  // Senders nobody wrote a rule for: search everything else, keep what looks like a payment.
  var known = {};
  ruleSenders.forEach(function (r) { known[r.toLowerCase()] = true; });
  var query = 'newer_than:' + days + 'd -in:spam -in:trash ' + ruleSenders.map(function (r) { return '-from:' + r; }).join(' ');
  var bySender = {};
  gmailSearchMessages_(query, { max: 100 }).forEach(function (message) {
    var address = coverageAddress_(message.getFrom());
    if (!address || known[address]) return;
    var row = bySender[address] = bySender[address] || { sender: address, emails: 0, looksLikePayment: 0, example: '', last: '' };
    var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
    row.emails++;
    if (looksLikeTransaction_(message.getSubject(), message.getPlainBody())) {
      row.looksLikePayment++;
      if (dateStr >= row.last) { row.last = dateStr; row.example = unreadSubjectShape_(message.getSubject()); }
    }
  });
  report.unknownSenders = Object.keys(bySender).map(function (k) { return bySender[k]; })
    .filter(function (r) { return r.looksLikePayment > 0; })
    .sort(function (a, b) { return b.looksLikePayment - a.looksLikePayment; })
    .slice(0, 30);
  report.unpairedExchangeLegs = unpairedExchangeLegs_();   // currency exchanges with only one side recorded (CurrencyExchange.gs)
  return report;
}
