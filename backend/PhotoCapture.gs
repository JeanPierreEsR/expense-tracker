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
    var amt = photoAmount_(clean, true);
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
  if (/te\s+yapearon/i.test(clean)) {
    var amtIn = photoAmount_(clean, false);
    if (!amtIn) return { kind: 'yape_received', error: 'amount' };
    var sender = photoLineAfter_(lines.filter(function (l) { return !/^compartir$/i.test(l); }), /te\s+yapearon/i);
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
 * Free OCR via Google Drive: uploading an image with ocr:true converts it
 * into a Google Doc whose text is the recognised text. Needs the Drive
 * advanced service (appsscript.json). The temporary doc is always deleted.
 */
function ocrImageToText_(blob) {
  // Google throttles OCR ("User rate limit exceeded") in short bursts, so
  // retry a few times with a growing pause before giving up.
  var waits = [3000, 8000, 15000];
  var file = null;
  for (var attempt = 0; ; attempt++) {
    try {
      file = Drive.Files.insert(
        { title: 'ocr-temp-' + Date.now(), mimeType: blob.getContentType() },
        blob,
        { ocr: true, ocrLanguage: 'es' }
      );
      break;
    } catch (err) {
      if (attempt >= waits.length || !/rate limit|quota|try again|backend error/i.test(err.message)) throw err;
      Utilities.sleep(waits[attempt]);
    }
  }
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

function photoReply_(msg, text) {
  telegramApi_('sendMessage', {
    chat_id: msg.chat.id, text: text,
    reply_to_message_id: msg.message_id, allow_sending_without_reply: true
  });
}

/**
 * Called from handleTelegramMessage_ for an owner message carrying an image.
 */
function handleTelegramPhoto_(msg) {
  var fileId = photoFileIdFromMessage_(msg);
  var blob = downloadTelegramFile_(fileId);
  if (!blob) { photoReply_(msg, "Couldn't download that image from Telegram."); return; }

  var text;
  try {
    text = ocrImageToText_(blob);
  } catch (err) {
    photoReply_(msg, "Couldn't read the image (" + err.message + ').');
    return;
  }

  var parsed = parsePhotoReceipt_(text);
  if (!parsed) {
    photoReply_(msg, "That doesn't look like a Plin or Yape receipt, so I saved nothing.");
    return;
  }
  if (parsed.error) {
    photoReply_(msg, "It looks like a " + parsed.kind.replace('_', ' ') +
      " receipt but I couldn't read the amount, so I saved nothing. Try a sharper screenshot.");
    return;
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
  // plain text, so Sheets stores "01234567" as the number 4051122.
  var stripZeros = function (v) { return String(v).replace(/^0+/, ''); };
  var duplicate = getAllRows('Entries').some(function (e) {
    return e.external_id && stripZeros(e.external_id) === stripZeros(externalId);
  });
  if (duplicate) { photoReply_(msg, 'Already recorded — skipped this duplicate.'); return; }

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
    // Income holds a payor id here, and a masked name like "Mia Lo*"
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
