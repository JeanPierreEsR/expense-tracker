/**
 * Milestone 5 — the statements inbox.
 *
 * The 15-minute automation notes statement emails from the owner's banks in a
 * `Statement Inbox` sheet (only who/when/which attachment — never contents) and
 * sends ONE Telegram nudge per new statement. Statements just WAIT there: the
 * PDF is fetched from the owner's Gmail (getStatementAttachment) only when he
 * taps Open on the Statements screen, is read on his phone, and asks for its
 * password every time. Saving a review marks the inbox items it used as
 * processed.
 */

var STATEMENT_INBOX_COLUMNS_ = ['id', 'message_id', 'attachment_name', 'sender_key', 'bank_label', 'bank_keyword',
  'received', 'status', 'size_kb', 'notified', 'created_at'];

// One entry per sender address that mails statements. `bank` is the word looked
// for in the Payment Methods' bank name (to tell which accounts it belongs to);
// `creditOnly` for a bank whose statement email is only the credit card's.
var STATEMENT_SENDERS_ = [
  { address: 'tarjetasdecredito@eecc.interbank.pe', label: 'Interbank Visa', bank: 'interbank', creditOnly: true },
  { address: 'estadodecuenta@dinersonline.com.pe', label: 'Diners', bank: 'diners', creditOnly: false },
  { address: 'dinersenlinea@dinersclub.com.pe', label: 'Diners', bank: 'diners', creditOnly: false },
  { address: 'no-reply@servicioalcliente.sip.pe', label: 'SIP', bank: 'sip', creditOnly: false },
  { address: 'notificaciones@notificacionesbcp.com.pe', label: 'BCP', bank: 'bcp', creditOnly: false },
  // AhorraMás is a savings product inside the SIP app (its accounts sit under the SIP bank); this
  // address also sends SIP operation emails, but those carry no PDF, so only statements get through.
  { address: 'no-reply@operaciones.agora.pe', label: 'AhorraMás', bank: 'sip', creditOnly: false }
];

function ensureStatementInboxSheet_() {
  ensureStatementSheet_('Statement Inbox', STATEMENT_INBOX_COLUMNS_, ['message_id', 'received', 'created_at']);
}

/** Only real statement PDFs: not promos, brochures, logos, or other file types. */
function stmtIsStatementAttachment_(name) {
  var n = String(name || '');
  return /\.pdf$/i.test(n) && !/promo|retira|logo|folleto|brochure|cartilla/i.test(n);
}

// Statements the owner mails to himself (banks that send nothing automatically).
// With no bank address to go on, the bank is recognized from the PDF's file name
// (the first matching rule), failing that a bank word in the file name or
// subject, failing that a known bank address quoted in a forwarded body. A self-sent PDF that matches none is not a statement as far as we
// know (he also mails himself other PDFs) and is left out of the inbox.
var STATEMENT_SELF_FILENAME_RULES_ = [
  { pattern: /^account_sum+ary/i, label: 'Interbank', bank: 'interbank' },
  { pattern: /^EECC/i, label: 'BCP', bank: 'bcp' }
];
var STATEMENT_SELF_BANK_WORDS_ = [
  { pattern: /interbank|\bibk\b/i, label: 'Interbank', bank: 'interbank' },
  { pattern: /diners/i, label: 'Diners', bank: 'diners' },
  { pattern: /\bbcp\b/i, label: 'BCP', bank: 'bcp' },
  { pattern: /\bsip\b/i, label: 'SIP', bank: 'sip' }
];

function stmtSelfSentBank_(fileName, subject, body) {
  var byName = STATEMENT_SELF_FILENAME_RULES_.filter(function (r) { return r.pattern.test(String(fileName || '')); })[0];
  if (byName) return byName;
  var text = String(fileName || '') + ' ' + String(subject || '');
  var byWord = STATEMENT_SELF_BANK_WORDS_.filter(function (r) { return r.pattern.test(text); })[0];
  if (byWord) return byWord;
  // A forwarded bank email still quotes the original sender's address ("De: … <address>").
  var lower = String(body || '').toLowerCase();
  return STATEMENT_SENDERS_.filter(function (s) { return lower.indexOf(s.address) >= 0; })[0] || null;
}

/** True when the message's sender is among its own recipients (a mail he sent to himself). */
function stmtSentToSelf_(m) {
  var from = (/[\w.+-]+@[\w.-]+/.exec(String(m.getFrom()).toLowerCase()) || [])[0];
  return !!from && String(m.getTo()).toLowerCase().indexOf(from) >= 0;
}

function scanStatementInbox_() {
  ensureStatementInboxSheet_();
  var rows = getAllRows('Statement Inbox');
  var first = rows.length === 0;
  var seenMessage = {};
  rows.forEach(function (r) { seenMessage[r.message_id] = true; });
  var window = ' has:attachment filename:pdf newer_than:' + (first ? '75d' : '6d');
  var tz = Session.getScriptTimeZone();
  var added = [];
  function note(m, sender, att, selfSent) {
    added.push({ id: Utilities.getUuid(), message_id: m.getId(), attachment_name: att.getName(), sender_key: selfSent ? 'self' : sender.address,
      bank_label: sender.label, bank_keyword: sender.bank, received: Utilities.formatDate(m.getDate(), tz, 'yyyy-MM-dd'),
      status: 'new', size_kb: Math.round(att.getSize() / 1024), notified: first ? 'true' : '', created_at: nowTimestamp_() });
  }
  GmailApp.search('from:(' + STATEMENT_SENDERS_.map(function (s) { return s.address; }).join(' OR ') + ')' + window, 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      var id = m.getId();
      if (seenMessage[id]) return;
      var from = String(m.getFrom()).toLowerCase();
      var sender = STATEMENT_SENDERS_.filter(function (s) { return from.indexOf(s.address) >= 0; })[0];
      if (!sender) return;
      m.getAttachments({ includeInlineImages: false }).forEach(function (a) {
        if (stmtIsStatementAttachment_(a.getName())) note(m, sender, a, false);
      });
      seenMessage[id] = true;
    });
  });
  // The owner's own mails to himself. Gmail's `from:me to:me` finds the threads; each message is then
  // checked to really be one he sent to himself (its sender is among its recipients), so a stranger's
  // reply inside the same thread is never taken. (No Session email lookup: that needs a permission
  // the app was never granted, and failed silently — see CHANGELOG.)
  {
    GmailApp.search('from:me to:me' + window, 0, 50).forEach(function (thread) {
      thread.getMessages().forEach(function (m) {
        var id = m.getId();
        if (seenMessage[id]) return;
        if (!stmtSentToSelf_(m)) return;
        m.getAttachments({ includeInlineImages: false }).forEach(function (a) {
          if (!stmtIsStatementAttachment_(a.getName())) return;
          var bank = stmtSelfSentBank_(a.getName(), m.getSubject(), m.getPlainBody());
          if (bank) note(m, bank, a, true);
        });
        seenMessage[id] = true;
      });
    });
  }
  // Older ones found on the very first scan are listed silently; later ones get one nudge each.
  added.forEach(function (o) {
    if (!o.notified) {
      var sent = false;
      try { sent = sendTelegramText_('📄 New ' + o.bank_label + ' statement (received ' + o.received + '). It waits in More → Statements → Inbox until you open it.'); } catch (e) { sent = false; }
      if (sent) o.notified = 'true';
    }
  });
  appendRowsBulk_('Statement Inbox', added);
  // A nudge that could not be sent (bot not configured yet) is retried next cycle.
  return { found: added.length };
}

function retryStatementInboxNudges_() {
  ensureStatementInboxSheet_();
  getAllRows('Statement Inbox').forEach(function (r) {
    if (r.status !== 'new' || r.notified === 'true' || r.notified === true) return;
    var sent = false;
    try { sent = sendTelegramText_('📄 New ' + r.bank_label + ' statement (received ' + r.received + '). It waits in More → Statements → Inbox until you open it.'); } catch (e) { sent = false; }
    if (sent) updateRowFields_('Statement Inbox', r.id, { notified: 'true' });
  });
}

function sendTelegramText_(text) {
  var chatId = getOwnerTelegramChatId_();
  if (!chatId || !getTelegramToken_()) return false;
  var res = telegramApi_('sendMessage', { chat_id: chatId, text: text });
  return !!(res && res.ok);
}

function updateRowFields_(sheetName, id, fields) {
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var idx = findRowIndexById(sheet, headers, id);
  if (idx === -1) return false;
  Object.keys(fields).forEach(function (f) { sheet.getRange(idx, headers.indexOf(f) + 1).setValue(fields[f]); });
  return true;
}

/** Which accounts a statement email is about (Payment Methods of that bank). */
function stmtInboxAccounts_(item, pms, banksById) {
  var sender = STATEMENT_SENDERS_.filter(function (s) { return s.address === item.sender_key; })[0] || {};
  return pms.filter(function (pm) {
    var bank = String((banksById[pm.bank_id] || {}).name || '').toLowerCase();
    if (bank.indexOf(item.bank_keyword) < 0) return false;
    if (sender.creditOnly && pm.type !== 'credit') return false;
    return pm.type === 'credit' || pm.type === 'debit';
  });
}

/** Newest processed_at over the statements already processed for these accounts. */
function stmtLastProcessedFor_(accounts, uploads) {
  var keys = {};
  accounts.forEach(function (pm) { keys[covKey_(pm.last_4)] = true; });
  var last = '';
  uploads.forEach(function (u) { if (keys[covKey_(u.account_key)] && String(u.processed_at) > last) last = String(u.processed_at); });
  return last;
}

function listStatementInbox() {
  ensureStatementInboxSheet_();
  ensureStatementUploadsSheet_();
  var rows = getAllRows('Statement Inbox').filter(function (r) { return r.status === 'new' || r.status === 'processed'; });
  var pms = getAllRows('Payment Methods'), banksById = rowsById_(getAllRows('Banks')), uploads = getAllRows('Statement Uploads');
  var items = rows.map(function (r) {
    var last = stmtLastProcessedFor_(stmtInboxAccounts_(r, pms, banksById), uploads);
    return { id: r.id, bank: r.bank_label, received: String(r.received), file_name: r.attachment_name, size_kb: Number(r.size_kb),
      status: r.status, last_processed: last, probably_processed: r.status === 'new' && !!last && String(r.received) <= last };
  });
  items.sort(function (a, b) { return (a.status === b.status ? 0 : (a.status === 'new' ? -1 : 1)) || (a.received < b.received ? 1 : -1); });
  return { items: items.filter(function (i) { return i.status === 'new'; }).concat(items.filter(function (i) { return i.status === 'processed'; }).slice(0, 8)) };
}

/** Fetches ONE statement PDF from the owner's Gmail (only when he taps Open). */
function getStatementAttachment(payload) {
  var row = getAllRows('Statement Inbox').filter(function (r) { return r.id === payload.id; })[0];
  if (!row) throw new Error('That statement is not in the inbox');
  var msg = GmailApp.getMessageById(row.message_id);
  var att = msg.getAttachments({ includeInlineImages: false }).filter(function (a) { return a.getName() === row.attachment_name; })[0];
  if (!att) throw new Error('The attachment is no longer in that email');
  return { id: row.id, name: att.getName(), base64: Utilities.base64Encode(att.getBytes()) };
}

function dismissStatement(payload) {
  ensureStatementInboxSheet_();
  if (!updateRowFields_('Statement Inbox', payload.id, { status: payload.undo ? 'new' : 'dismissed' })) throw new Error('That statement is not in the inbox');
  return { ok: true };
}

/** Called after a review is saved: the inbox items whose PDFs were used are done. */
function markStatementInboxProcessed_(ids) {
  (ids || []).forEach(function (id) { updateRowFields_('Statement Inbox', id, { status: 'processed' }); });
}

/** Read-only: how many unprocessed inbox statements wait per account key (for the coverage list). */
function stmtInboxWaitingByAccount_(pms, banksById, uploads) {
  ensureStatementInboxSheet_();
  var waiting = {};
  getAllRows('Statement Inbox').filter(function (r) { return r.status === 'new'; }).forEach(function (r) {
    var accts = stmtInboxAccounts_(r, pms, banksById);
    var last = stmtLastProcessedFor_(accts, uploads);
    if (last && String(r.received) <= last) return; // probably already processed
    accts.forEach(function (pm) { var k = covKey_(pm.last_4); if (k) waiting[k] = (waiting[k] || 0) + 1; });
  });
  return waiting;
}
