/**
 * Reading e-mail — one place that talks to Gmail (friends & family rollout, stage 2).
 *
 * The app only ever READS e-mail (bank notices, statement PDFs). The old way
 * (GmailApp) asks Google for FULL access ("read, compose, send and permanently
 * delete"); the newer Gmail service asks only for read-only. Everything else in
 * the backend goes through the three functions below and sees "messages" with
 * the same methods GmailApp's messages have (getId, getSubject, getFrom, getTo,
 * getDate, getPlainBody, getAttachments), so the bank rules did not change.
 *
 *   gmailUsesReadonly_()          which way is in use
 *   gmailSearchMessages_(q, opts) messages matching a Gmail search, newest first
 *   gmailGetMessage_(id)          one message by id
 *
 * Which way: a copy made by the installer (Script Property FEATURES exists) always
 * uses the read-only service. The owner's older copy keeps GmailApp until
 * GMAIL_READER is set to "readonly" (sheet menu 31) — after the side-by-side
 * check (menu 30, compareGmailReaders) showed both read the same mail the same way.
 * Until the owner asks for it, his copy changes NOTHING: the Gmail service is not
 * even enabled in his project (no manifest dependency), so no new permission is
 * requested. The old way and these switches are removed once the owner has switched.
 *
 * No labels are written any more: which e-mails were handled is remembered by
 * message id in the "Processed Emails" tab (EmailParser.gs).
 */

function gmailUsesReadonly_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FEATURES')) return true;
  return String(props.getProperty('GMAIL_READER') || '') === 'readonly';
}

// Messages matching a Gmail search query, newest first (legacy: in conversation order).
// opts.max caps how many messages come back (default 500).
function gmailSearchMessages_(query, opts) {
  var max = (opts && opts.max) || 500;
  if (!gmailUsesReadonly_()) {
    var out = [];
    GmailApp.search(query, 0, Math.min(max, 500)).forEach(function (thread) {
      thread.getMessages().forEach(function (m) { out.push(m); });
    });
    return out.slice(0, max);
  }
  var ids = [];
  var token = null;
  do {
    var res = Gmail.Users.Messages.list('me', {
      q: query,
      maxResults: Math.min(500, max - ids.length),
      pageToken: token || undefined
    });
    (res.messages || []).forEach(function (m) { ids.push(m.id); });
    token = res.nextPageToken;
  } while (token && ids.length < max);
  return ids.map(gmailLazyMessage_);
}

function gmailGetMessage_(id) {
  return gmailUsesReadonly_() ? gmailLazyMessage_(id) : GmailApp.getMessageById(id);
}

// ---- A message read through the Gmail service ----
// Only its id is known from the search; the content is fetched on first use, so
// e-mails that were already handled (known by id) cost no download.
function gmailLazyMessage_(id) {
  var res = null;
  function load() {
    if (!res) res = Gmail.Users.Messages.get('me', id, { format: 'full' });
    return res;
  }
  return {
    getId: function () { return id; },
    getSubject: function () { return gmailHeader_(load().payload, 'Subject'); },
    getFrom: function () { return gmailHeader_(load().payload, 'From'); },
    getTo: function () { return gmailHeader_(load().payload, 'To'); },
    getDate: function () { return new Date(Number(load().internalDate)); },
    getPlainBody: function () { return gmailPlainBody_(id, load().payload); },
    getAttachments: function (opts) { return gmailAttachments_(id, load().payload, opts); }
  };
}

function gmailWalkParts_(part, fn) {
  if (!part) return;
  fn(part);
  (part.parts || []).forEach(function (p) { gmailWalkParts_(p, fn); });
}

function gmailHeader_(part, name) {
  var want = String(name).toLowerCase();
  var hs = (part && part.headers) || [];
  for (var i = 0; i < hs.length; i++) {
    if (String(hs[i].name).toLowerCase() === want) return gmailDecodeMimeWords_(String(hs[i].value || ''));
  }
  return '';
}

// "=?UTF-8?B?...?=" / "=?ISO-8859-1?Q?...?=" in a header (subjects with accents), when Gmail passes them undecoded.
function gmailDecodeMimeWords_(text) {
  if (text.indexOf('=?') === -1) return text;
  return text
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([\w-]+)\?([bBqQ])\?([^?]*)\?=/g, function (all, charset, enc, data) {
      try {
        var bytes;
        if (enc.toUpperCase() === 'B') {
          bytes = Utilities.base64Decode(data);
        } else {
          var s = data.replace(/_/g, ' ');
          var arr = [];
          for (var i = 0; i < s.length; i++) {
            if (s.charAt(i) === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { arr.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
            else arr.push(s.charCodeAt(i));
          }
          bytes = arr.map(function (b) { return b > 127 ? b - 256 : b; });
        }
        return Utilities.newBlob(bytes).getDataAsString(charset);
      } catch (e) { return all; }
    });
}

// The text a person would read: the text/plain part(s); if the e-mail has none, the HTML turned into text.
function gmailPlainBody_(messageId, payload) {
  var plain = [], html = [];
  gmailWalkParts_(payload, function (part) {
    if (part.filename) return;   // attachments are not the message text
    var type = String(part.mimeType || '').toLowerCase();
    if (type === 'text/plain') plain.push(part);
    else if (type === 'text/html') html.push(part);
  });
  if (plain.length) return plain.map(function (p) { return gmailPartText_(messageId, p); }).join('\n');
  if (html.length) return gmailHtmlToText_(html.map(function (p) { return gmailPartText_(messageId, p); }).join('\n'));
  return '';
}

function gmailPartText_(messageId, part) {
  var data = part.body && part.body.data;
  if (!data && part.body && part.body.attachmentId) {
    data = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId).data;
  }
  if (!data) return '';
  var ct = gmailHeader_(part, 'Content-Type');
  var charset = (/charset="?([\w-]+)/i.exec(ct) || [])[1] || 'UTF-8';
  var bytes = gmailBase64Bytes_(data, part.mimeType);
  try { return Utilities.newBlob(bytes).getDataAsString(charset); }
  catch (e) { return Utilities.newBlob(bytes).getDataAsString('UTF-8'); }
}

// Gmail's body text -> bytes. Google's own decoders are strict (a padding "=", a stray line break or the other base64 alphabet makes
// them throw "Could not decode string"), so the text is first put in ONE canonical form: letters/digits/+/ only, padded to a multiple
// of 4, then the standard decoder. If it still cannot be read, the error says which part and how it looked (lengths only, never the
// e-mail's words) so the log of a friend's copy is enough to find the cause.
function gmailBase64Bytes_(data, mimeType) {
  var raw = String(data);
  var clean = raw.replace(/[^A-Za-z0-9_\-+\/]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (clean.length % 4 !== 0 && clean.length % 4 !== 1) clean += '=';
  var why = clean.length % 4 === 1 ? 'length is not valid base64' : '';
  if (!why) {
    try { return Utilities.base64Decode(clean); } catch (err) { why = String(err && err.message || err); }
  }
  throw new Error('Could not read the ' + (mimeType || 'unknown') + ' part of an e-mail (' + raw.length + ' characters, '
    + (raw.replace(/[A-Za-z0-9_\-=+\/]/g, '').length) + ' unexpected characters): ' + why);
}

// Named HTML characters that Spanish-language bank e-mails use (the common five are handled inline).
var GMAIL_ENTITIES_ = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü', iquest: '¿', iexcl: '¡', laquo: '«', raquo: '»', deg: '°', euro: '€',
  copy: '©', reg: '®', middot: '·', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•'
};

function gmailHtmlToText_(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&([A-Za-z]+);/g, function (all, name) { return GMAIL_ENTITIES_.hasOwnProperty(name) ? GMAIL_ENTITIES_[name] : all; })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/gi, '&')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function gmailAttachments_(messageId, payload, opts) {
  var skipInline = !!opts && opts.includeInlineImages === false;
  var out = [];
  gmailWalkParts_(payload, function (part) {
    if (!part.filename) return;
    if (skipInline && /^inline/i.test(gmailHeader_(part, 'Content-Disposition')) && /^image\//i.test(String(part.mimeType || ''))) return;
    out.push({
      getName: function () { return part.filename; },
      getSize: function () { return Number((part.body && part.body.size) || 0); },
      getContentType: function () { return part.mimeType; },
      getBytes: function () {
        var data = part.body && part.body.data;
        if (!data && part.body && part.body.attachmentId) {
          data = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId).data;
        }
        return data ? Utilities.base64DecodeWebSafe(data) : [];
      }
    });
  });
  return out;
}

// ---- One-time approval + side-by-side check (owner, from the Apps Script editor / sheet menu) ----

// Run once from the Apps Script editor (▶ Run) BEFORE deploying: it makes Google ask for the new
// read-only permission. It reads nothing but the mailbox's own address and message count.
function authorizeGmailReadonly() {
  var p = Gmail.Users.getProfile('me');
  Logger.log('Read-only e-mail access is authorized (' + p.messagesTotal + ' messages in the mailbox).');
  return { ok: true, messages: p.messagesTotal };
}

/**
 * Reads the same recent bank e-mails BOTH ways (old GmailApp, new Gmail service) and compares what the
 * bank rules would extract. Writes nothing and returns counts and field NAMES only — no e-mail content.
 * opts.days (default 14).
 */
function compareGmailReaders(opts) {
  var days = Number(opts && opts.days) || 14;
  var summary = { days: days, messagesCompared: 0, onlyOld: 0, onlyNew: 0, subjectsDiffer: 0, sendersDiffer: 0,
    datesDiffer: 0, bodiesIdentical: 0, bodiesDifferOnlyInSpacing: 0, bodiesDiffer: 0,
    ruleMatchedBoth: 0, extractionSame: 0, extractionDiffers: [] };
  var squash = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
  uniqueSenders_().forEach(function (sender) {
    var q = 'from:' + sender + ' newer_than:' + days + 'd';
    var oldById = {};
    GmailApp.search(q, 0, 500).forEach(function (t) { t.getMessages().forEach(function (m) { oldById[String(m.getId())] = m; }); });
    var newById = {};
    gmailSearchMessagesViaService_(q).forEach(function (m) { newById[String(m.getId())] = m; });
    Object.keys(oldById).forEach(function (id) {
      var o = oldById[id], n = newById[id];
      if (!n) { summary.onlyOld++; return; }
      summary.messagesCompared++;
      var oSub = o.getSubject(), nSub = n.getSubject();
      var oBody = o.getPlainBody(), nBody = n.getPlainBody();
      if (oSub !== nSub) summary.subjectsDiffer++;
      if (squash(o.getFrom()) !== squash(n.getFrom())) summary.sendersDiffer++;
      if (Math.abs(o.getDate().getTime() - n.getDate().getTime()) > 60000) summary.datesDiffer++;
      if (oBody === nBody) summary.bodiesIdentical++;
      else if (squash(oBody) === squash(nBody)) summary.bodiesDifferOnlyInSpacing++;
      else summary.bodiesDiffer++;
      var rules = EMAIL_RULES.filter(function (r) { return r.sender === sender; });
      var rOld = rules.filter(function (r) { return r.match(oSub, oBody); })[0];
      var rNew = rules.filter(function (r) { return r.match(nSub, nBody); })[0];
      if (!rOld && !rNew) return;
      if (!!rOld !== !!rNew || (rOld && rNew && rOld.label !== rNew.label)) {
        summary.extractionDiffers.push({ id: id.slice(0, 6), rule: (rOld || rNew).label, problem: 'a different rule (or none) matched' });
        return;
      }
      summary.ruleMatchedBoth++;
      var fOld = rOld.skip ? {} : (rOld.extract(oSub, oBody) || {});
      var fNew = rNew.skip ? {} : (rNew.extract(nSub, nBody) || {});
      var keys = Object.keys(fOld).concat(Object.keys(fNew)).filter(function (k, i, a) { return a.indexOf(k) === i; });
      var bad = keys.filter(function (k) { return JSON.stringify(fOld[k]) !== JSON.stringify(fNew[k]); });
      if (bad.length) summary.extractionDiffers.push({ id: id.slice(0, 6), rule: rOld.label, fields: bad });
      else summary.extractionSame++;
    });
    Object.keys(newById).forEach(function (id) { if (!oldById[id]) summary.onlyNew++; });
  });
  Logger.log(JSON.stringify(summary));
  return summary;
}

// The new way regardless of the switch (used by the comparison above).
function gmailSearchMessagesViaService_(query) {
  var ids = [], token = null;
  do {
    var res = Gmail.Users.Messages.list('me', { q: query, maxResults: 500, pageToken: token || undefined });
    (res.messages || []).forEach(function (m) { ids.push(m.id); });
    token = res.nextPageToken;
  } while (token);
  return ids.map(gmailLazyMessage_);
}
