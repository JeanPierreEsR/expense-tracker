/**
 * "Not captured automatically" (More → Not captured automatically).
 *
 * Works out which KINDS of money movement still reach the app by hand — typed in, sent as a receipt photo, or found only
 * when a bank statement was read — so the person knows what to add themselves and the owner can see where a workaround
 * is worth building. Computed on demand from Entries and Statement Lines; nothing is stored and nothing leaves the copy.
 *
 * The result is a short list of fixed kinds (GAP_KINDS_) with a count and the last date seen. Friends' copies get only
 * that; the owner's copy also gets totals per currency and the share of entries that were manual.
 */

var GAP_WINDOW_DAYS_ = 90;

// The kinds, in the order shown. The wording for each (name + tip) lives in docs/strings.js as gaps.kind.<key> / gaps.tip.<key>.
var GAP_KINDS_ = ['plin_out_whatsapp', 'yape_in', 'plin_in', 'yape_out', 'plin_out', 'cash', 'friend_paid', 'no_email_bank', 'other_manual'];

function gapIsoToday_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function gapIsoDaysAgo_(n) {
  var p = gapIsoToday_().split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) - n * 86400000);
  return d.toISOString().slice(0, 10);
}

/**
 * Pure: which kind one item is. item = { source: 'manual' | 'photo' | 'statement', direction: 'in' | 'out', text,
 * pmType, bankName, paidByFriend }; ctx = { emailBanks: [bank names that have a parsing rule] }.
 */
function gapClassify_(item, ctx) {
  var text = String(item.text || '').toLowerCase();
  var incoming = item.direction === 'in';
  var yape = /yape/.test(text);
  var plin = /plin/.test(text);
  if (item.source === 'photo') {
    // Receipt photos exist for exactly these cases (PhotoCapture.gs): Plin from WhatsApp, Yape in/out without an email.
    if (plin) return incoming ? 'plin_in' : 'plin_out_whatsapp';
    if (yape) return incoming ? 'yape_in' : 'yape_out';
  }
  if (yape) return incoming ? 'yape_in' : 'yape_out';
  if (plin) return incoming ? 'plin_in' : 'plin_out';
  if (item.pmType === 'cash') return 'cash';
  if (item.paidByFriend) return 'friend_paid';
  var bank = String(item.bankName || '').toLowerCase();
  var covered = ((ctx && ctx.emailBanks) || []).some(function (b) { return String(b).toLowerCase() === bank; });
  if (bank && !covered) return 'no_email_bank';
  return 'other_manual';
}

/** Pure: items -> [{ key, count, last, totals? }] in GAP_KINDS_ order, only kinds that occurred. */
function gapSummarize_(items, ctx, withTotals) {
  var by = {};
  items.forEach(function (it) {
    var key = gapClassify_(it, ctx);
    var g = by[key] || (by[key] = { key: key, count: 0, last: '', totals: {} });
    g.count++;
    if (it.date && it.date > g.last) g.last = it.date;
    if (withTotals && it.currency) g.totals[it.currency] = Math.round(((g.totals[it.currency] || 0) + Math.abs(Number(it.amount) || 0)) * 100) / 100;
  });
  return GAP_KINDS_.filter(function (k) { return by[k]; }).map(function (k) {
    var g = by[k];
    var out = { key: g.key, count: g.count, last: g.last };
    if (withTotals) out.totals = g.totals;
    return out;
  });
}

function getManualGaps(payload) {
  var owner = !isFriendCopy_();
  var from = gapIsoDaysAgo_(GAP_WINDOW_DAYS_);
  var pms = {};
  var banks = {};
  getAllRows('Banks').forEach(function (b) { banks[String(b.id)] = String(b.name || ''); });
  getAllRows('Payment Methods').forEach(function (pm) {
    pms[String(pm.id)] = { id: String(pm.id), type: String(pm.type || ''), bankName: banks[String(pm.bank_id)] || '' };
  });
  var pmByKey = {};
  getAllRows('Payment Methods').forEach(function (pm) {
    [pm.nickname, pm.id].forEach(function (k) { if (k !== '' && k != null) pmByKey[String(k).trim().toLowerCase()] = pms[String(pm.id)]; });
  });

  var items = [];
  var totalEntries = 0;
  var manualEntries = 0;
  getAllRows('Entries').forEach(function (e) {
    var date = String(e.date || '');
    if (date < from || (e.type !== 'expense' && e.type !== 'income')) return;
    totalEntries++;
    if (e.source !== 'manual' && e.source !== 'photo') return;
    manualEntries++;
    var pm = pms[String(e.payment_method_id)] || {};
    items.push({
      source: e.source, direction: e.type === 'income' ? 'in' : 'out', text: e.description, date: date,
      amount: e.amount, currency: e.currency, pmType: pm.type || '', bankName: pm.bankName || '',
      paidByFriend: e.type === 'expense' && !!e.paid_by && String(e.paid_by) !== 'me'
    });
  });

  // Lines only a bank statement revealed (the statement reader added them: purchases, income, refunds not in the app).
  ensureStatementLinesSheet_();
  getAllRows('Statement Lines').forEach(function (l) {
    if (l.outcome !== 'added') return;
    var date = String(l.date || '');
    if (date < from) return;
    var pm = pmByKey[String(l.account_key || '').trim().toLowerCase()] || {};
    items.push({
      source: 'statement', direction: Number(l.amount) > 0 ? 'in' : 'out', text: l.description, date: date,
      amount: l.amount, currency: l.currency, pmType: pm.type || '', bankName: pm.bankName || '', paidByFriend: false
    });
  });

  var ctx = { emailBanks: getEmailInfo_().banks };
  var out = { windowDays: GAP_WINDOW_DAYS_, kinds: gapSummarize_(items, ctx, owner), owner: owner, unread: listUnreadEmails_(from) };
  if (owner) out.manualShare = { manual: manualEntries, total: totalEntries };
  return out;
}

// ---- Bank emails the app could not read (tab "Unread Emails") ----
// One row per (sender, subject shape, kind) with a running count, never one per email: no amounts, no names, no body text.
// kind 'no_rule' = a known bank sender whose email matches none of our rules; 'unreadable' = a rule matched but the fields
// could not be read (the bank probably changed its wording).

var UNREAD_COLUMNS_ = ['id', 'sender', 'subject', 'kind', 'count', 'first_seen', 'last_seen'];
// Off during the one-off back-check, which re-reads old mail and would count it twice.
var UNREAD_LOGGING_ = true;

function ensureUnreadEmailsSheet_() {
  ensureStatementSheet_('Unread Emails', UNREAD_COLUMNS_, ['id', 'first_seen', 'last_seen']);
}

// "Realizaste un consumo 123" -> "realizaste un consumo #": the wording of the email, without the numbers that vary.
function unreadSubjectShape_(subject) {
  return String(subject || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function logUnreadEmail_(sender, subject, kind, dateStr) {
  if (!UNREAD_LOGGING_) return;
  try {
    ensureUnreadEmailsSheet_();
    var shape = unreadSubjectShape_(subject);
    var id = [String(sender).toLowerCase(), shape, kind].join('|');
    var row = getAllRows('Unread Emails').filter(function (r) { return String(r.id) === id; })[0];
    if (row) {
      updateRowFields_('Unread Emails', id, { count: Number(row.count || 0) + 1, last_seen: dateStr });
    } else {
      appendRowObject('Unread Emails', { id: id, sender: String(sender).toLowerCase(), subject: shape, kind: kind, count: 1, first_seen: dateStr, last_seen: dateStr });
    }
  } catch (err) {
    console.error('logUnreadEmail_: ' + err);   // a logging problem must never stop the email run
  }
}

function listUnreadEmails_(fromIso) {
  ensureUnreadEmailsSheet_();
  return getAllRows('Unread Emails')
    .filter(function (r) { return String(r.last_seen) >= fromIso; })
    .sort(function (a, b) { return Number(b.count) - Number(a.count); })
    .slice(0, 20)
    .map(function (r) { return { sender: String(r.sender), subject: String(r.subject), kind: String(r.kind), count: Number(r.count), last: String(r.last_seen) }; });
}
