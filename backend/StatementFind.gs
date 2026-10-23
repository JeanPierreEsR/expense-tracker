/**
 * "Find statements in Gmail": an on-demand search over the past months (for example all of last year), instead of downloading each
 * PDF by hand and picking it from the phone's Files.
 *
 *   findStatementEmails({months})   lists (writes nothing) the PDFs that look like statements, newest first. Never opens a PDF.
 *   addStatementsToInbox({items})   puts the ones the person ticked into the Statement Inbox, so Open / processed / coverage work as
 *                                   for any other inbox statement. Re-checks every item against the mailbox.
 *   rememberStatementSender({id})   a statement from Gmail was READ by a reader: its sender becomes a bank this copy knows
 *                                   (sheet "Statement Senders"), so the 15-minute scan finds that bank's later statements.
 *
 * The PDFs themselves are fetched one at a time by getStatementAttachment and read on the phone, as before.
 */

// Words that make a PDF look like a statement. Used twice: in the Gmail search (to narrow it) and again in code on every hit, so a
// search that is looser than expected never lists unrelated PDFs.
var STATEMENT_WORDS_RE_ = /estado|statement|eecc|extracto|resumen|cartola|cuenta/i;
var STATEMENT_SEARCH_WORDS_ = '(subject:("estado de cuenta" OR statement OR eecc OR extracto OR "resumen de cuenta" OR "resumen de tarjeta" OR cartola)'
  + ' OR filename:(estado OR statement OR eecc OR extracto OR cuenta OR resumen OR cartola))';
var STATEMENT_FIND_MAX_MONTHS_ = 36;
var STATEMENT_FIND_MAX_RESULTS_ = 200;
// Free-mail addresses are never remembered as "a bank" (a statement someone forwarded from a personal address).
var STATEMENT_FREE_MAIL_RE_ = /@(gmail|googlemail|hotmail|outlook|live|yahoo|icloud|me|protonmail)\./i;

function stmtAddressOf_(from) {
  return (/[\w.+-]+@[\w.-]+/.exec(String(from || '').toLowerCase()) || [])[0] || '';
}

function stmtDisplayNameOf_(from) {
  var name = String(from || '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
  return name.length > 40 ? name.substring(0, 40) : name;
}

function findStatementEmails(payload) {
  requireFeature_('gmail', 'feature.gmailOff');
  var months = Math.max(1, Math.min(STATEMENT_FIND_MAX_MONTHS_, Math.floor(Number((payload || {}).months) || 12)));
  var window = ' newer_than:' + (months * 31) + 'd';
  var senders = statementSenders_();
  var known = {};
  senders.forEach(function (s) { known[s.address] = s; });
  ensureStatementInboxSheet_();
  var done = {};
  getAllRows('Statement Inbox').forEach(function (r) { done[r.message_id + '|' + r.attachment_name] = r.status; });
  var tz = Session.getScriptTimeZone();
  var seen = {};
  var items = [];
  function take(m) {
    if (seen[m.getId()]) return;
    seen[m.getId()] = true;
    var from = m.getFrom();
    var address = stmtAddressOf_(from);
    var subject = String(m.getSubject() || '');
    var isKnown = !!known[address];
    m.getAttachments({ includeInlineImages: false }).forEach(function (a) {
      var name = a.getName();
      if (!stmtIsStatementAttachment_(name)) return;
      // From a known bank any real statement PDF counts; from anyone else the subject or the file name must sound like a statement.
      if (!isKnown && !STATEMENT_WORDS_RE_.test(subject + ' ' + name)) return;
      items.push({ message_id: m.getId(), attachment_name: name, sender: address, sender_name: stmtDisplayNameOf_(from),
        bank: isKnown ? known[address].label : '', known: isKnown, subject: subject.length > 80 ? subject.substring(0, 80) : subject,
        received: Utilities.formatDate(m.getDate(), tz, 'yyyy-MM-dd'), size_kb: Math.round(a.getSize() / 1024),
        status: done[m.getId() + '|' + name] || '' });
    });
  }
  gmailSearchMessages_('from:(' + senders.map(function (s) { return s.address; }).join(' OR ') + ') has:attachment filename:pdf' + window,
    { max: STATEMENT_FIND_MAX_RESULTS_ }).forEach(take);
  gmailSearchMessages_('has:attachment filename:pdf' + window + ' ' + STATEMENT_SEARCH_WORDS_,
    { max: STATEMENT_FIND_MAX_RESULTS_ }).forEach(take);
  items.sort(function (a, b) { return a.received < b.received ? 1 : (a.received > b.received ? -1 : 0); });
  return { months: months, items: items.slice(0, STATEMENT_FIND_MAX_RESULTS_) };
}

function addStatementsToInbox(payload) {
  requireFeature_('gmail', 'feature.gmailOff');
  var picks = ((payload || {}).items || []).slice(0, STATEMENT_FIND_MAX_RESULTS_);
  ensureStatementInboxSheet_();
  var rows = getAllRows('Statement Inbox');
  var senders = statementSenders_();
  var tz = Session.getScriptTimeZone();
  var added = [];
  var ids = [];
  var senderOf = {};
  picks.forEach(function (p) {
    var messageId = String(p.message_id || ''), name = String(p.attachment_name || '');
    if (!messageId || !name) return;
    var existing = rows.concat(added).filter(function (r) { return r.message_id === messageId && r.attachment_name === name; })[0];
    if (existing) { ids.push(existing.id); senderOf[existing.id] = existing.sender_key === 'self' ? '' : String(existing.sender_key); return; }   // already there (a processed one can be read again)
    var m = gmailGetMessage_(messageId);
    // Re-checked here, so this is never a general way to pull any attachment out of the mailbox.
    var att = m.getAttachments({ includeInlineImages: false }).filter(function (a) { return a.getName() === name && stmtIsStatementAttachment_(a.getName()); })[0];
    if (!att) return;
    var address = stmtAddressOf_(m.getFrom());
    var sender = senders.filter(function (s) { return s.address === address; })[0];
    var label = sender ? sender.label : (stmtDisplayNameOf_(m.getFrom()) || address);
    var row = { id: Utilities.getUuid(), message_id: messageId, attachment_name: name, sender_key: address, bank_label: label,
      bank_keyword: sender ? sender.bank : String(label).toLowerCase().split(/\s+/)[0], received: Utilities.formatDate(m.getDate(), tz, 'yyyy-MM-dd'),
      status: 'new', size_kb: Math.round(att.getSize() / 1024), notified: 'true', created_at: nowTimestamp_() };
    added.push(row);
    ids.push(row.id);
    senderOf[row.id] = address;
  });
  if (added.length) appendRowsBulk_('Statement Inbox', added);
  return { ids: ids, senders: senderOf };
}

function rememberStatementSender(payload) {
  var row = getAllRows('Statement Inbox').filter(function (r) { return r.id === (payload || {}).id; })[0];
  if (!row) return { remembered: false };
  var address = String(row.sender_key || '').toLowerCase();
  if (!address || address === 'self' || STATEMENT_FREE_MAIL_RE_.test(address)) return { remembered: false };
  if (statementSenders_().some(function (s) { return s.address === address; })) return { remembered: false };
  appendRowsBulk_('Statement Senders', [{ address: address, label: String(row.bank_label), bank_keyword: String(row.bank_keyword), added_at: nowTimestamp_() }]);
  return { remembered: true };
}
