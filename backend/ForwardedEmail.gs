/**
 * Forwarded bank e-mails (owner, 2026-11-22): a bank e-mail the person forwards to the Gmail their app runs on is read like the bank's own.
 *
 * Why: a friend's bank wrote to another address for weeks; the purchases never reached the app, and a catch-up (MailCatchup.gs) can only
 * re-read the mailbox the app already reads. Forwarding is also how a missed e-mail is sent in later, whatever its age: the forward arrives
 * today, so the normal scan sees it, and the purchase keeps the date of the ORIGINAL e-mail (principle 3).
 *
 * Two shapes:
 *  - an inline forward: the forward's text quotes the original's From / Date / Subject (Gmail, iPhone Mail, Outlook; English and Spanish);
 *  - "Forward as attachment" (Gmail on a computer, several at once): each attached .eml is a whole original e-mail.
 * Only a quoted sender that one of the bank rules knows is read, by the same rules as the bank's own e-mails; everything waits in Needs
 * review (principle 6). The forward's sender is kept in `forwarded_by`.
 *
 * Trust (owner, 2026-11-22): forwards from ANY address are read. A quoted "From:" is only typed text, so it proves nothing; the safeguard is
 * that the Needs review item says "Forwarded by <address>" unless it came from this Gmail or from an address the person listed in
 * More → Bank emails (Settings `forward_from`, a JSON list).
 */

var FORWARD_FROM_SETTING_ = 'forward_from';
var FORWARD_FROM_MAX_ = 10;
var FORWARDED_BY_COLUMN_ = 'forwarded_by';

// ---- The person's other addresses ----

function forwardListed_(settings) {
  try {
    var list = JSON.parse(String((settings || getSettingsMap())[FORWARD_FROM_SETTING_] || '[]'));
    return Array.isArray(list) ? list.map(function (a) { return String(a).toLowerCase(); }).filter(forwardIsAddress_) : [];
  } catch (err) { return []; }
}

function forwardIsAddress_(a) { return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(String(a || '')); }

// The app's `setForwardAddresses`: { addresses: [..] } replaces the list. Returns { addresses }.
function setForwardAddresses(payload) {
  var raw = (payload && payload.addresses) || [];
  if (!Array.isArray(raw)) raw = [raw];
  var seen = {};
  var list = [];
  raw.forEach(function (a) {
    var addr = String(a || '').trim().toLowerCase();
    if (!addr || seen[addr]) return;
    if (!forwardIsAddress_(addr)) throw new Error(tr_('forward.badAddress', { address: addr }));
    seen[addr] = true;
    list.push(addr);
  });
  if (list.length > FORWARD_FROM_MAX_) throw new Error(tr_('forward.tooMany', { n: FORWARD_FROM_MAX_ }));
  setSetting_(FORWARD_FROM_SETTING_, JSON.stringify(list));
  return { addresses: list };
}

// Who forwarded a waiting entry, as the bots' card shows it (the app's Needs review card does the same on the phone, reviewForwardedBy_):
// '' when it was not forwarded, or came from this Gmail or one of the person's other addresses.
function forwardShownBy_(entry) {
  var by = String((entry && entry[FORWARDED_BY_COLUMN_]) || '').toLowerCase();
  if (!by) return '';
  if (by === String(mailboxAddress_() || '').toLowerCase() || forwardListed_().indexOf(by) !== -1) return '';
  return by;
}

// ---- Finding forwards in the scan ----

// The bare address inside "Name <a@b.c>" (lower case), or ''. The display name is typed text: a quoted name or a (comment) may itself
// hold "<someone@else>", so both are dropped first and the LAST <address> is the real one (testers, 2026-11-22: a stranger's forward
// named '"x<your-gmail>" <stranger@...>' passed as the person's own and lost its "Forwarded by" line).
function forwardAddressOf_(text) {
  var s = String(text || '').replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^()]*\)/g, ' ');
  var all = s.match(/<\s*[^<>\s]+@[^<>\s]+\s*>/g);
  if (all) return all[all.length - 1].replace(/[<>\s]/g, '').toLowerCase();
  var m = /([^\s<>"'(),;:]+@[^\s<>"'(),;:]+\.[a-z]{2,})/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

// Stored as forwarded_by when the forwarder's address cannot be read: the card then says "an unknown sender" instead of nothing.
var FORWARD_UNKNOWN_ = '?';

// The bank address a piece of text names (one of `senders`), or ''.
function forwardBankIn_(text, senders) {
  var lower = String(text || '').toLowerCase();
  for (var i = 0; i < senders.length; i++) if (lower.indexOf(senders[i]) !== -1) return senders[i];
  return '';
}

// Part of the normal scan (EmailParser.gs processEmails): messages from anyone but the banks that mention a bank's address or carry an
// attached e-mail. Each is looked at once (the "Processed Emails" memory), so a message that is not a forward costs one read.
function processForwardedEmails_(days, handled, results, existingExternalIds, banks, paymentMethods, guessCtx) {
  var senders = uniqueSenders_().map(function (s) { return String(s).toLowerCase(); }).filter(function (s) { return s.indexOf('@') !== -1; });
  if (!senders.length) return;
  var query = 'newer_than:' + days + 'd -from:(' + senders.join(' OR ') + ') {' +
    senders.map(function (s) { return '"' + s + '"'; }).join(' ') + ' filename:eml}';
  gmailSearchMessages_(query, { max: 200 }).forEach(function (message) {
    var messageId = String(message.getId());
    if (handled[messageId]) return;
    // A forward that cannot be read is written down as handled anyway: it is not the bank's own mail, a failure here must not mark the
    // e-mail check as broken, and the person can forward it again.
    try {
      processForwardedMessage_(message, senders, results, existingExternalIds, banks, paymentMethods, guessCtx);
    } catch (err) {
      console.error('processForwardedMessage_: ' + err);
    }
    recordProcessedEmail_(messageId);
    handled[messageId] = true;
  });
}

function processForwardedMessage_(message, senders, results, existingExternalIds, banks, paymentMethods, guessCtx) {
  var by = forwardAddressOf_(message.getFrom());
  if (senders.indexOf(by) !== -1) return;   // the bank's own e-mail: the usual scan reads it
  if (!by) by = FORWARD_UNKNOWN_;
  var originals = [];
  (message.getAttachments({ includeInlineImages: false }) || []).forEach(function (att, i) {
    var name = String(att.getName() || '');
    var type = String((att.getContentType && att.getContentType()) || '');
    if (!/\.eml$/i.test(name) && !/^message\/rfc822/i.test(type)) return;
    var original = forwardFromEml_(att.getBytes(), senders);
    if (original) { original.suffix = '#a' + i; originals.push(original); }
  });
  if (!originals.length) {
    var inline = forwardUnwrapMessage_(message, senders);
    if (inline) { inline.suffix = '#f'; originals.push(inline); }
  }
  originals.forEach(function (o) {
    processOneMessage_(forwardedMessage_(message, o, by), o.sender, results, existingExternalIds, banks, paymentMethods, guessCtx);
    results.forwarded = (results.forwarded || 0) + 1;
  });
}

// The original e-mail, dressed as a message so the usual reading (processOneMessage_) needs no change. Its date is the ORIGINAL's; when
// the quoted date cannot be read, the forward's own date is used (the item still waits in Needs review, where the date can be changed).
function forwardedMessage_(outer, o, by) {
  var date = o.date || outer.getDate();
  return {
    forwardedBy: by,
    getId: function () { return String(outer.getId()) + o.suffix; },
    getSubject: function () { return o.subject; },
    getFrom: function () { return o.sender; },
    getTo: function () { return o.to || ''; },
    getDate: function () { return date; },
    getPlainBody: function () { return o.body; },
    getBody: function () { return o.body; },
    getAttachments: function () { return []; }
  };
}

// ---- An inline forward ----

// Its text as the rules are used to reading it: the HTML turned into text the way the app reads an HTML-only bank e-mail, else the
// plain text. Returns { sender, subject, date, to, body } or null.
function forwardUnwrapMessage_(message, senders) {
  var html = '';
  try { html = String(message.getBody() || ''); } catch (err) { html = ''; }
  var texts = [];
  if (/<[a-z][^>]*>/i.test(html)) texts.push(gmailHtmlToText_(html));
  try { texts.push(String(message.getPlainBody() || '')); } catch (err) { /* no plain part */ }
  for (var i = 0; i < texts.length; i++) {
    var found = forwardUnwrapText_(texts[i], senders);
    if (found) return found;
  }
  return null;
}

var FORWARD_LABELS_ = {
  from: /^(from|de|von|remitente)$/,
  date: /^(date|fecha|sent|enviado|enviado el|sent on)$/,
  subject: /^(subject|asunto)$/,
  to: /^(to|para|a)$/
};

// The quoted header block: a "From:"/"De:" line naming a bank address, the header lines after it, then the original's text.
function forwardUnwrapText_(text, senders) {
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(function (l) {
    return l.replace(/^\s*(>\s*)+/, '').replace(/\*/g, '').trim();
  });
  for (var i = 0; i < lines.length; i++) {
    var m = /^([A-Za-zÀ-ÿ ]{1,12}):\s*(.*)$/.exec(lines[i]);
    if (!m || !FORWARD_LABELS_.from.test(m[1].trim().toLowerCase())) continue;
    var sender = forwardBankIn_(m[2], senders);
    if (!sender) continue;
    var head = { from: m[2] };
    var j = i + 1;
    // Header lines follow (up to 8). A blank line ends them; Gmail's HTML sometimes leaves one right after "From:".
    for (var n = 0; j < lines.length && n < 8; n++) {
      if (!lines[j]) { if (head.subject || head.date) break; j++; continue; }
      var h = /^([A-Za-zÀ-ÿ ]{1,12}):\s*(.*)$/.exec(lines[j]);
      if (!h) break;
      var key = h[1].trim().toLowerCase();
      Object.keys(FORWARD_LABELS_).forEach(function (k) { if (!head[k] && FORWARD_LABELS_[k].test(key)) head[k] = h[2]; });
      j++;
    }
    var body = lines.slice(j).join('\n').trim();
    if (!body) return null;
    return { sender: sender, subject: String(head.subject || ''), date: forwardParseDate_(head.date || ''), to: head.to || '', body: body };
  }
  return null;
}

// ---- A forwarded date ----

var FORWARD_MONTHS_ = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9,
  oct: 10, nov: 11, dec: 12, dic: 12 };

function forwardFold_(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

// A date as mail programs quote it, to a Date; null when it cannot be read or is not a plausible past date.
//   "Sat, Nov 21, 2026 at 12:44 PM" · "sáb, 21 nov 2026 a las 12:44" · "November 21, 2026 at 12:44:10 PM GMT-5"
//   "21 de noviembre de 2026, 12:44:10 p.m. GMT-5" · "sábado, 21 de noviembre de 2026 12:44" · "Sat, 21 Nov 2026 12:44:10 -0500"
//   "21/11/2026 12:44" (day first, as in Peru) · "2026-11-21 12:44"
// Without a zone, the time is the person's own (personTz_).
function forwardParseDate_(text) {
  var s = forwardFold_(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  var y = 0, mo = 0, d = 0, m;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else {
    var yr = /\b(20\d{2})\b/.exec(s);
    if (!yr) return null;
    y = +yr[1];
    // A weekday first ("mar, 17 mar 2026": "mar" is Tuesday AND March) is set aside.
    var rest = s.replace(/^[a-z]+\.?,\s*/, '');
    var re = /\b(\d{1,2})(?:\s+de)?\s+([a-z]{3,})\.?|\b([a-z]{3,})\.?\s+(\d{1,2})\b/g, words;
    while (!mo && (words = re.exec(rest))) {
      mo = FORWARD_MONTHS_[(words[2] || words[3]).slice(0, 3)] || 0;
      d = +(words[1] || words[4]);
    }
  }
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000)) return null;
  var hh = 0, mi = 0, ss = 0;
  var t = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/.exec(s.replace(/(gmt|utc)\s*[+-]\d{1,2}(:?\d{2})?/g, ''));
  if (t) {
    hh = +t[1]; mi = +t[2]; ss = +(t[3] || 0);
    var ampm = (t[4] || '').replace(/[.\s]/g, '');
    if (ampm === 'pm' && hh < 12) hh += 12;
    if (ampm === 'am' && hh === 12) hh = 0;
  }
  var when;
  var off = /(?:gmt|utc)\s*([+-])(\d{1,2})(?::?(\d{2}))?/.exec(s) || /\s([+-])(\d{2})(\d{2})\b/.exec(s);
  if (off) {
    var mins = (+off[2]) * 60 + (+(off[3] || 0));
    when = new Date(Date.UTC(y, mo - 1, d, hh, mi, ss) - (off[1] === '-' ? -1 : 1) * mins * 60000);
  } else {
    when = forwardWallToDate_(y, mo, d, hh, mi, ss, personTz_());
  }
  if (isNaN(when.getTime()) || when.getTime() > Date.now() + 86400000) return null;
  return when;
}

// The moment a wall-clock time in `tz` stands for (two passes settle a daylight-saving edge).
function forwardWallToDate_(y, mo, d, hh, mi, ss, tz) {
  var naive = Date.UTC(y, mo - 1, d, hh, mi, ss);
  function offsetAt(ms) {
    var p = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd HH:mm:ss').split(/[- :]/).map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]) - Math.floor(ms / 1000) * 1000;
  }
  var guess = naive - offsetAt(naive);
  return new Date(naive - offsetAt(guess));
}

// ---- An attached e-mail (.eml) ----

// The original from an attached e-mail's bytes, or null when its sender is not a bank address a rule knows.
function forwardFromEml_(bytes, senders) {
  var raw = Array.prototype.map.call(bytes || [], function (b) { return String.fromCharCode(b & 255); }).join('');
  var mail = forwardMimeParse_(raw);
  var sender = forwardBankIn_(forwardAddressOf_(mail.headers.from), senders);
  if (!sender) return null;
  var plain = [], html = [];
  forwardMimeLeaves_(mail).forEach(function (leaf) {
    if (leaf.attachment) return;
    if (leaf.type === 'text/plain') plain.push(leaf.text());
    else if (leaf.type === 'text/html') html.push(leaf.text());
  });
  // As the app reads a bank e-mail: an HTML-only one turned into text (most banks); the plain part when there is one.
  var body = plain.length ? plain.join('\n') : (html.length ? gmailHtmlToText_(html.join('\n')) : '');
  if (!body) return null;
  return { sender: sender, subject: gmailFixMojibake_(gmailDecodeMimeWords_(mail.headers.subject || '')),
    date: forwardParseDate_(mail.headers.date || ''), to: gmailDecodeMimeWords_(mail.headers.to || ''), body: gmailFixMojibake_(body) };
}

// A MIME entity from a string of byte characters: { headers: {lower-case name: value}, type, params, body, parts }.
function forwardMimeParse_(raw) {
  var split = /\r?\n\r?\n/.exec(raw);
  var headText = split ? raw.slice(0, split.index) : raw;
  var body = split ? raw.slice(split.index + split[0].length) : '';
  var headers = {};
  headText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(function (line) {
    var m = /^([^:\s]+):\s*(.*)$/.exec(line);
    if (m && !headers.hasOwnProperty(m[1].toLowerCase())) headers[m[1].toLowerCase()] = m[2];
  });
  var ct = headers['content-type'] || 'text/plain';
  var type = ct.split(';')[0].trim().toLowerCase();
  var params = {};
  ct.replace(/;\s*([\w-]+)\s*=\s*("([^"]*)"|[^;\s]+)/g, function (all, k, v, q) { params[k.toLowerCase()] = q !== undefined ? q : v; return all; });
  var entity = { headers: headers, type: type, params: params, body: body, parts: [] };
  if (/^multipart\//.test(type) && params.boundary) {
    var chunks = body.split('--' + params.boundary);
    for (var i = 1; i < chunks.length; i++) {
      var c = chunks[i];
      if (/^--/.test(c)) break;   // the closing boundary
      entity.parts.push(forwardMimeParse_(c.replace(/^\r?\n/, '')));
    }
  }
  return entity;
}

function forwardMimeLeaves_(entity) {
  if (entity.parts.length) return entity.parts.reduce(function (all, p) { return all.concat(forwardMimeLeaves_(p)); }, []);
  var disposition = String(entity.headers['content-disposition'] || '');
  return [{
    type: entity.type,
    attachment: /^attachment/i.test(disposition) || /filename=/i.test(disposition),
    text: function () { return forwardMimeText_(entity); }
  }];
}

function forwardMimeText_(entity) {
  var cte = String(entity.headers['content-transfer-encoding'] || '').trim().toLowerCase();
  var body = entity.body;
  var bytes;
  if (cte === 'base64') {
    try { bytes = Utilities.base64Decode(body.replace(/[^A-Za-z0-9+\/=]/g, '')); } catch (err) { return ''; }
  } else {
    if (cte === 'quoted-printable') {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (all, h) { return String.fromCharCode(parseInt(h, 16)); });
    }
    bytes = [];
    for (var i = 0; i < body.length; i++) { var b = body.charCodeAt(i) & 255; bytes.push(b > 127 ? b - 256 : b); }
  }
  var charset = entity.params.charset || 'UTF-8';
  try { return Utilities.newBlob(bytes).getDataAsString(charset); }
  catch (err) { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); }
}
