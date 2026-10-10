/**
 * Photo capture — a receipt image sent to the Telegram bot becomes a
 * `pending` entry, exactly like an email would (principle 6: nothing
 * automated is ever confirmed).
 *
 * Built for payments that generate NO email: a Plin payment made from
 * WhatsApp (Interbank's "¡Plineaste!" image) and money received by Yape
 * ("¡Te Yapearon!" screen). Flow:
 *   Telegram photo -> download -> free Google Drive OCR -> per-receipt
 *   reader (parsePhotoReceipt_, below) -> pending Entry -> the usual
 *   Confirm/Discard card.
 *
 * Deterministic on purpose, like EmailParser.gs: keyword/regex readers, no
 * AI (the $0 rule). An image that isn't a recognised receipt, or whose
 * amount can't be read, saves NOTHING and says so.
 *
 * The readers are pure functions of the OCR text so they can be tested
 * without Apps Script; everything that touches Telegram/Drive/Sheets is in
 * the handler at the bottom.
 */

// Plin is a rail, not an account: money always leaves an Interbank savings
// account of that currency (same rule as the Plin email rule).
var PLIN_ACCOUNTS = { PEN: 'IBK soles', USD: 'IBK dolares' };

var SPANISH_MONTHS_ = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12
};

// ---- Pure readers (no Apps Script services) ----

function photoAmount_(text, allowBareDollar) {
  // "S/ 70", "S/5.00", "S/.12.50" — OCR sometimes reads the stylised "S/"
  // as "s/" or "5/", so be lenient about the prefix. Soles are tried first.
  var m = text.match(/([Ss5])\s*\/\s*\.?\s*(\d[\d,]*(?:\.\d{1,2})?)/);
  var currency = 'PEN';
  if (!m) {
    // Dollars only when explicit ("US$"), or a bare "$" on screens that
    // carry no ads (a Yape screen has "*$150 y gana" further down, which
    // must never be mistaken for the payment if the soles amount is lost).
    m = text.match(allowBareDollar
      ? /(US\s*\$|\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/
      : /(US\s*\$)\s*(\d[\d,]*(?:\.\d{1,2})?)/);
    currency = 'USD';
  }
  if (!m) return null;
  var amount = parseFloat(m[2].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  return { amount: amount, currency: currency };
}

// Tesseract (the Mac Mini reader) often turns the big stylised "S/" into
// "51" or "5" ("S/ 70" -> "5170", "S/5.00" -> "55.00"). Looked for ONLY on
// the first few lines after the receipt's title line, as a line that is
// nothing but that misread prefix plus the number — never anywhere else,
// so an ad or a date can't be mistaken for the amount.
function photoLooseAmount_(lines, titleRe) {
  for (var i = 0; i < lines.length; i++) {
    if (!titleRe.test(lines[i])) continue;
    for (var j = i + 1; j < lines.length && j <= i + 6; j++) {
      var m = lines[j].match(/^[Ss5$]\s*[\/1lI|i]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*\S{0,2}$/);
      if (!m) continue;
      var amount = parseFloat(m[1].replace(/,/g, ''));
      // "5170" -> the "51" was "S/"; a bare 4+ digit token with no slash-like
      // prefix is not trusted.
      if (amount > 0 && /^[Ss5$]\s*[\/1lI|i]/.test(lines[j])) return { amount: amount, currency: 'PEN' };
    }
    // Sometimes the "S/" is dropped entirely and the line is just the
    // number with two decimals plus a stray character ("35.00 u"). Only a
    // two-decimal figure is trusted: the masked card line, the date and the
    // operation code never look like that.
    for (var k = i + 1; k < lines.length && k <= i + 6; k++) {
      var d = lines[k].match(/^(\d[\d,]*\.\d{2})\s*\S{0,2}$/);
      if (!d) continue;
      var bare = parseFloat(d[1].replace(/,/g, ''));
      if (bare > 0) return { amount: bare, currency: 'PEN' };
    }
  }
  return null;
}

// "22 Set 2026 | 12:21 PM" / "24 set. 2026 | 8:17 a.m." -> { date, time }
function photoDateTime_(text) {
  var m = text.match(/(\d{1,2})\s+([A-Za-zñÑ]{3,4})\.?\s+(\d{4})/);
  if (!m) return null;
  var month = SPANISH_MONTHS_[m[2].toLowerCase().substring(0, 3)];
  if (!month) return null;
  var out = {
    date: m[3] + '-' + ('0' + month).slice(-2) + '-' + ('0' + m[1]).slice(-2),
    time: null
  };
  var after = text.substring(m.index + m[0].length, m.index + m[0].length + 40);
  var t = after.match(/(\d{1,2}):(\d{2})\s*([ap])\.?\s*m/i);
  if (t) {
    var h = parseInt(t[1], 10) % 12;
    if (t[3].toLowerCase() === 'p') h += 12;
    out.time = ('0' + h).slice(-2) + ':' + t[2] + ':00';
  }
  return out;
}

function photoOperationCode_(text) {
  var m = text.match(/(?:c[oó]digo\s+de\s+operaci[oó]n|nro\.?\s*de\s+operaci[oó]n)\s*:?\s*(\d{6,})/i);
  return m ? m[1] : null;
}

// First non-empty line after a marker line, skipping lines that are only
// symbols/digits (the masked "··· ··· 556 - Yape" line, an amount).
function photoLineAfter_(lines, markerRe) {
  for (var i = 0; i < lines.length; i++) {
    if (!markerRe.test(lines[i])) continue;
    for (var j = i + 1; j < lines.length && j <= i + 3; j++) {
      var l = lines[j].replace(/[*]/g, '*').trim();
      if (l && /[A-Za-zÁÉÍÓÚáéíóúñÑ]{2,}/.test(l) && !/^[\W\d_]*\d/.test(l)) return l;
    }
  }
  return null;
}

// Lower-case, accent-free, "*" and punctuation removed, words split.
function photoNameTokens_(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Is the (masked) name printed on a Yape image the owner's? Yape masks the end of
 * the surname ("Ana Lo*"), so each word of the masked name must match a word of
 * one of the owner's names in order, the LAST one as a prefix. `ownerNames` is the
 * Settings value `owner_names`: comma-separated, e.g. the full name and/or how Yape
 * shows it. At least two words must match, so a lone first name never counts.
 */
function photoIsOwnerName_(maskedName, ownerNames) {
  var m = photoNameTokens_(maskedName);
  if (m.length < 2) return false;
  return String(ownerNames || '').split(',').some(function (variant) {
    var v = photoNameTokens_(variant), at = 0;
    if (v.length < 2) return false;
    for (var j = 0; j < m.length; j++) {
      var last = j === m.length - 1, found = -1;
      for (var k = at; k < v.length; k++) {
        if (last ? v[k].indexOf(m[j]) === 0 : v[k] === m[j]) { found = k; break; }
      }
      if (found < 0) return false;
      at = found + 1;
    }
    return true;
  });
}

// The optional message the sender typed ("almuerzo del menu"): the line right
// after the date/time line, unless that is already the next block.
function photoNoteAfterDate_(lines) {
  for (var i = 0; i < lines.length - 1; i++) {
    if (!/\d{1,2}\s+[A-Za-zñÑ]{3,4}\.?\s+\d{4}/.test(lines[i])) continue;
    var l = lines[i + 1].trim();
    // OCR turns the little message icon into a stray character in front of the text.
    l = l.replace(/^[^A-Za-zÁÉÍÓÚáéíóúñÑ0-9]*[A-Za-z0-9]\s+(?=\S{2})/, '').trim();
    if (l && /[A-Za-zÁÉÍÓÚáéíóúñÑ]{3,}/.test(l) && !/c[oó]digo\s+de\s+seguridad|datos\s+de\s+la\s+transacci/i.test(l)) return l;
    return null;
  }
  return null;
}

// Yape prints the other person's name masked ("Ana Lo*"). When the text holds a title
// followed, within a few lines, by a line ending in "*", that is the name — more reliable
// than "the first wordy line", which OCR noise (icons, the logo) can fool.
function photoMaskedNameAfter_(lines, markerRe) {
  for (var i = 0; i < lines.length; i++) {
    if (!markerRe.test(lines[i])) continue;
    for (var j = i + 1; j < lines.length && j <= i + 4; j++) {
      if (/^[^\d]*[A-Za-zÁÉÍÓÚáéíóúñÑ]{2,}[^\d]*\*\s*$/.test(lines[j]) && !/compartir|\$/i.test(lines[j])) return lines[j].replace(/^[^A-Za-zÁÉÍÓÚáéíóúñÑ]+/, '').trim();
    }
  }
  return null;
}

/**
 * Returns null when the text isn't a recognised receipt, otherwise
 * { kind, type, amount, currency, description, date, time, externalId,
 *   accountByCurrency, counterparty } — externalId may be null (the
 * caller falls back to a hash, like the email path does).
 */
function parsePhotoReceipt_(text) {
  if (!text) return null;
  var clean = String(text).replace(/^﻿/, '');
  var lines = clean.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var when = photoDateTime_(clean);
  var opCode = photoOperationCode_(clean);

  // Interbank Plin image sent from WhatsApp: money OUT.
  if (/pl[i1l]neaste/i.test(clean)) {
    var amt = photoAmount_(clean, true) || photoLooseAmount_(lines, /pl[i1l]neaste/i);
    if (!amt) return { kind: 'plin_sent', error: 'amount' };
    var recipient = photoLineAfter_(lines, /pl[i1l]neaste/i);
    return {
      kind: 'plin_sent', type: 'expense',
      amount: amt.amount, currency: amt.currency,
      description: recipient ? 'Plin a ' + recipient : 'Plin',
      counterparty: recipient,
      date: when && when.date, time: when && when.time,
      externalId: opCode, accountByCurrency: PLIN_ACCOUNTS
    };
  }

  // Yape "¡Te Yapearon!" screen: money IN, to the BCP account of that
  // currency (Yape is a rail on BCP, same as BCP_ACCOUNTS for sent ones).
  if (/yapearon/i.test(clean)) {
    var amtIn = photoAmount_(clean, false) || photoLooseAmount_(lines, /yapearon/i);
    if (!amtIn) return { kind: 'yape_received', error: 'amount' };
    var sender = photoMaskedNameAfter_(lines, /yapearon/i) || photoLineAfter_(lines.filter(function (l) { return !/compartir/i.test(l); }), /yapearon/i);
    // The amount sits on its own line between the title and the name; the
    // helper skips it (digits) and lands on the sender's name.
    return {
      kind: 'yape_received', type: 'income',
      amount: amtIn.amount, currency: amtIn.currency,
      description: sender ? 'Yape de ' + sender : 'Yape recibido',
      counterparty: sender,
      date: when && when.date, time: when && when.time,
      externalId: opCode, accountByCurrency: BCP_ACCOUNTS
    };
  }

  // Yape "¡Yapeaste!" screen: money OUT (to the BCP account of that currency) —
  // unless the name on it is the owner's own, which processPhotoText_ turns into income
  // (people send him their own "Yapeaste" screenshot as proof of payment).
  if (/yapeaste/i.test(clean)) {
    var amtOut = photoAmount_(clean, false) || photoLooseAmount_(lines, /yapeaste/i);
    if (!amtOut) return { kind: 'yape_sent', error: 'amount' };
    var recipientY = photoMaskedNameAfter_(lines, /yapeaste/i) || photoLineAfter_(lines, /yapeaste/i);
    var note = photoNoteAfterDate_(lines);
    return {
      kind: 'yape_sent', type: 'expense',
      amount: amtOut.amount, currency: amtOut.currency,
      description: (recipientY ? 'Yape a ' + recipientY : 'Yape') + (note ? ' — ' + note : ''),
      counterparty: recipientY, note: note,
      date: when && when.date, time: when && when.time,
      externalId: opCode, accountByCurrency: BCP_ACCOUNTS
    };
  }

  return null;
}

// ---- Telegram / Drive plumbing ----

function downloadTelegramFile_(fileId) {
  var info = telegramApi_('getFile', { file_id: fileId });
  if (!info.ok || !info.result || !info.result.file_path) return null;
  var res = UrlFetchApp.fetch(
    'https://api.telegram.org/file/bot' + getTelegramToken_() + '/' + info.result.file_path,
    { muteHttpExceptions: true }
  );
  if (res.getResponseCode() !== 200) return null;
  return res.getBlob();
}

/**
 * OCR via Google Drive (free): uploading an image with ocr:true converts it
 * into a Google Doc whose text is the recognised text. Needs the Drive
 * advanced service (appsscript.json). The temporary doc is always deleted.
 * Google throttles this hard for some accounts ("User rate limit exceeded
 * for OCR"), so ONE attempt is made and any failure hands the photo to the
 * Mac Mini's Tesseract instead (see the job queue below).
 */
function ocrImageToText_(blob) {
  var file = Drive.Files.insert(
    { title: 'ocr-temp-' + Date.now(), mimeType: blob.getContentType() },
    blob,
    { ocr: true, ocrLanguage: 'es' }
  );
  try {
    return DriveApp.getFileById(file.id).getAs('text/plain').getDataAsString('UTF-8');
  } finally {
    try { Drive.Files.remove(file.id); } catch (e) { /* best effort */ }
  }
}

function photoFileIdFromMessage_(msg) {
  if (msg.photo && msg.photo.length) {
    // Telegram sends several sizes; the last is the largest.
    return msg.photo[msg.photo.length - 1].file_id;
  }
  if (msg.document && /^image\//i.test(msg.document.mime_type || '')) {
    return msg.document.file_id;
  }
  return null;
}

function photoReply_(chatId, replyToMessageId, text) {
  telegramApi_('sendMessage', {
    chat_id: chatId, text: text,
    reply_to_message_id: replyToMessageId, allow_sending_without_reply: true
  });
}

/**
 * Called from handleTelegramMessage_ for an owner message carrying an image.
 * Tries Google's OCR once; if that fails for any reason the photo is queued
 * for the Mac Mini helper (mac-helper/ocr_worker.py), which reads it with
 * Tesseract and posts the text back via submitPhotoJobText.
 */
function handleTelegramPhoto_(msg) {
  var fileId = photoFileIdFromMessage_(msg);
  var blob = downloadTelegramFile_(fileId);
  if (!blob) { photoReply_(msg.chat.id, msg.message_id, "Couldn't download that image from Telegram."); return; }

  var text;
  try {
    text = ocrImageToText_(blob);
  } catch (err) {
    enqueuePhotoJob_(fileId, msg.chat.id, msg.message_id);
    photoReply_(msg.chat.id, msg.message_id,
      "Google's text reader is unavailable, so I queued this for your Mac Mini — it should show up within a minute or so.");
    return;
  }
  processPhotoText_(msg.chat.id, msg.message_id, text);
}

/**
 * Reads the recognised text and, if it's a known receipt, writes the pending
 * entry and sends its Confirm/Discard card. Shared by the Google path and the
 * Mac Mini path so both behave identically.
 */
function processPhotoText_(chatId, replyToMessageId, text) {
  var parsed = parsePhotoReceipt_(text);
  if (!parsed) {
    photoReply_(chatId, replyToMessageId, "That doesn't look like a Plin or Yape receipt, so I saved nothing.");
    return;
  }
  if (parsed.error) {
    photoReply_(chatId, replyToMessageId, "It looks like a " + parsed.kind.replace('_', ' ') +
      " receipt but I couldn't read the amount, so I saved nothing. Try a sharper screenshot.");
    return;
  }

  // A "Yapeaste" image whose name is the owner's was a payment TO him: income, not expense.
  var ownerMatched = false;
  if (parsed.kind === 'yape_sent' && photoIsOwnerName_(parsed.counterparty, getSettingsMap().owner_names)) {
    ownerMatched = true;
    parsed.type = 'income';
    parsed.description = 'Yape recibido' + (parsed.note ? ' — ' + parsed.note : '');
  }

  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var dateStr = parsed.date || Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var createdAt = parsed.date && parsed.time
    ? parsed.date + 'T' + parsed.time
    : Utilities.formatDate(now, tz, "yyyy-MM-dd'T'HH:mm:ss");

  // Same dedup fingerprint as the email path, so a receipt that ALSO
  // arrives by email (or is sent twice) is caught by the operation number.
  var externalId = parsed.externalId ||
    fallbackExternalId_('photo-' + parsed.kind, dateStr, parsed.amount, parsed.description);
  // Compared without leading zeros: the Entries.external_id column isn't
  // plain text, so Sheets stores "01234567" as the number 1234567.
  var stripZeros = function (v) { return String(v).replace(/^0+/, ''); };
  var duplicate = getAllRows('Entries').some(function (e) {
    return e.external_id && stripZeros(e.external_id) === stripZeros(externalId);
  });
  if (duplicate) { photoReply_(chatId, replyToMessageId, 'Already recorded — skipped this duplicate.'); return; }

  var pm = getAllRows('Payment Methods').find(function (p) {
    return p.nickname === parsed.accountByCurrency[parsed.currency];
  });

  ensureEntriesMerchantColumn_();
  ensureEntriesToPaymentMethodColumn_();
  var categoryId = '', autoReason = '';
  if (parsed.type === 'expense') {
    var guess = guessCategoryForEmail_(
      { type: 'expense', amount: parsed.amount, currency: parsed.currency, merchant: '' },
      dateStr, buildGuessContext_());
    categoryId = guess.categoryId; autoReason = guess.reason;
  }

  var entry = {
    id: Utilities.getUuid(),
    type: parsed.type,
    date: dateStr,
    amount: parsed.amount,
    currency: parsed.currency,
    category_id: categoryId,
    description: parsed.description,
    payment_method_id: pm ? pm.id : '',
    // Income holds a payor id here, and a masked name like "Ana Lo*"
    // shouldn't spawn a Payor by itself — left for the owner to set.
    paid_by: parsed.type === 'income' ? '' : 'me',
    status: 'pending',
    source: 'photo',
    external_id: externalId,
    import_batch_id: '',
    created_at: createdAt,
    merchant: ''
  };
  appendRowObject('Entries', entry);
  sendTelegramEntryNotification_(entry, null, autoReason);
  if (ownerMatched) photoReply_(chatId, replyToMessageId, "The name on this image matches yours, so I counted it as money you received (income). If that's wrong, discard it and tell me.");
}

// ---- Job queue for the Mac Mini's Tesseract helper ----
// The Mac can't be reached from the internet, so it PULLS: every ~30 s it
// asks listPhotoJobs, fetches each image (getPhotoJob), reads it locally and
// posts the text back (submitPhotoJobText) — or reports failPhotoJob.

var PHOTO_JOB_HEADERS_ = ['id', 'file_id', 'chat_id', 'message_id', 'status', 'created_at', 'updated_at'];

function ensurePhotoJobsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Photo Jobs');
  if (sheet) return sheet;
  sheet = ss.insertSheet('Photo Jobs');
  sheet.getRange(1, 1, 1, PHOTO_JOB_HEADERS_.length).setValues([PHOTO_JOB_HEADERS_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  return sheet;
}

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
}

function enqueuePhotoJob_(fileId, chatId, messageId) {
  ensurePhotoJobsSheet_();
  var now = nowIso_();
  appendRowObject('Photo Jobs', {
    id: Utilities.getUuid(), file_id: String(fileId), chat_id: String(chatId),
    message_id: String(messageId), status: 'queued', created_at: now, updated_at: now
  });
}

function photoJobById_(id) {
  ensurePhotoJobsSheet_();
  return getAllRows('Photo Jobs').find(function (j) { return j.id === id; });
}

function setPhotoJobStatus_(id, status) {
  var sheet = getSheet('Photo Jobs');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, id);
  if (rowIndex === -1) return;
  setCellByRow_(sheet, headers, rowIndex, 'status', status);
  setCellByRow_(sheet, headers, rowIndex, 'updated_at', nowIso_());
}

// Queued jobs, plus any the Mac claimed but never finished (crashed, asleep)
// more than 5 minutes ago.
function listPhotoJobs() {
  ensurePhotoJobsSheet_();
  var cutoff = Utilities.formatDate(new Date(Date.now() - 5 * 60 * 1000), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  return getAllRows('Photo Jobs').filter(function (j) {
    return j.status === 'queued' || (j.status === 'processing' && String(j.updated_at) < cutoff);
  }).map(function (j) { return { id: j.id }; });
}

function getPhotoJob(payload) {
  var job = photoJobById_(payload.id);
  if (!job) throw new Error('Unknown photo job');
  setPhotoJobStatus_(job.id, 'processing');
  var blob = downloadTelegramFile_(job.file_id);
  if (!blob) {
    setPhotoJobStatus_(job.id, 'failed');
    photoReply_(job.chat_id, job.message_id, "Couldn't download that image from Telegram (it may be too old) — please send it again.");
    throw new Error('Could not download the image');
  }
  return { id: job.id, mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

function submitPhotoJobText(payload) {
  var job = photoJobById_(payload.id);
  if (!job) throw new Error('Unknown photo job');
  if (job.status === 'done') return { done: true, alreadyDone: true };
  setPhotoJobStatus_(job.id, 'done');
  processPhotoText_(job.chat_id, job.message_id, String(payload.text || ''));
  return { done: true };
}

function failPhotoJob(payload) {
  var job = photoJobById_(payload.id);
  if (!job) throw new Error('Unknown photo job');
  setPhotoJobStatus_(job.id, 'failed');
  photoReply_(job.chat_id, job.message_id, "The Mac Mini couldn't read that image (" + String(payload.error || 'unknown error') + '). Try a sharper screenshot.');
  return { done: true };
}

/**
 * Run ONCE from the Apps Script editor after this feature is pushed: it
 * makes Google ask you to approve the new Drive permission (used only for
 * the temporary OCR copy of each image, deleted right after). Until this is
 * approved, deploying would break the web app's existing endpoints.
 */
function authorizeDriveOcr() {
  var about = Drive.About.get();
  Logger.log('Drive OCR is authorized for ' + about.user.emailAddress);
}
