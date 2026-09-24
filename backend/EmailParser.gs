/**
 * Email parsing rules, built from real sample transaction emails (not the
 * generic assumption that one bank = one simple pattern). Several senders
 * reuse the same sender address and subject for multiple transaction
 * types — SIP and Interbank both do this — so a rule matches on sender
 * AND, where needed, a keyword inside the body.
 *
 * This logic lives in code rather than as raw regex in the Parsing Rules
 * sheet: that sheet stays as a readable reference of what's configured
 * (see seedParsingRulesDoc), not the literal execution engine.
 *
 * Classification rules learned from the samples:
 * - "Consumo" (a purchase) -> expense.
 * - "Pago de servicios" (a utility bill) -> expense.
 * - "Pago tarjeta de crédito" / "pago deuda" (paying off a card balance)
 *   -> transfer. The real expense was already counted when each purchase
 *   happened; counting the bill payment too would double it.
 * - A transfer/wallet payment to the owner's own full name at another
 *   bank -> transfer (confirmed from real samples).
 * - A transfer/wallet payment to anyone else -> pending expense with no
 *   category, flagged for review — could be paying a vendor (very common
 *   via Yape/Plin in Peru), a gift, or a friend. Never guessed.
 */

// Exact full-name match only (not just the surname) — the owner
// transfers to family members who share the surname "Espinoza".
var OWNER_FULL_NAME = 'jean pierre espinoza rest';

function isOwnAccount_(name) {
  if (!name) return false;
  return name.toLowerCase().indexOf(OWNER_FULL_NAME) !== -1;
}

function extractAmount_(text) {
  if (!text) return null;
  var m = text.match(/(S\/\.?|US\$|\$)\s*([\d,]+\.\d{2}|[\d,]+)/);
  if (!m) return null;
  var isUsd = m[1].indexOf('$') !== -1;
  return {
    amount: parseFloat(m[2].replace(/,/g, '')),
    currency: isUsd ? 'USD' : 'PEN'
  };
}

function extractLast4_(text) {
  if (!text) return null;
  var m = text.match(/[*Xx•]{2,}\s*(\d{4})\b/); // Apple prints bullets: "Visa •••• 3052"
  return m ? m[1] : null;
}

// Real emails often glue "Label" straight onto its value with no space
// (e.g. "Enviado aJean Pierre..."), and some senders' "plain text" body
// still carries markdown-style *bold* markers or a stray <br>. The
// connector below tolerates a colon, an asterisk, and/or a newline in any
// combination between the label and the value.
function afterLabel_(body, label) {
  var re = new RegExp(label + '\\s*:?\\s*\\*?\\s*\\r?\\n?\\s*([^\\r\\n]+)', 'i');
  var m = body.match(re);
  return m ? cleanText_(m[1]) : null;
}

function cleanText_(text) {
  if (!text) return text;
  return text
    .replace(/<[^>]+>/g, ' ')   // stray HTML tags some senders leave in
    .replace(/\*/g, '')         // markdown-style bold markers
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackExternalId_(sender, dateStr, amount, extra) {
  var raw = sender + '|' + dateStr + '|' + amount + '|' + (extra || '');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return 'gen-' + Utilities.base64EncodeWebSafe(digest).substring(0, 16);
}

var EMAIL_RULES = [
  // ---- BCP ----
  {
    bank: 'BCP', sender: 'notificaciones@notificacionesbcp.com.pe',
    label: 'Consumo tarjeta de débito',
    match: function (subject) { return /realizaste un consumo/i.test(subject) && /d.bito/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Total del consumo') || body);
      if (!amt) return null;
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: afterLabel_(body, 'Empresa'),
        merchant: afterLabel_(body, 'Empresa'),
        last4: extractLast4_(afterLabel_(body, 'Número de Tarjeta de Débito') || body),
        externalId: afterLabel_(body, 'Número de operación')
      };
    }
  },
  {
    bank: 'BCP', sender: 'notificaciones@notificacionesbcp.com.pe',
    label: 'Pago de servicios',
    match: function (subject) { return /constancia de pago de servicio/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto total') || body);
      if (!amt) return null;
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: [afterLabel_(body, 'Empresa'), afterLabel_(body, 'Servicio')].filter(Boolean).join(' - '),
        merchant: afterLabel_(body, 'Empresa'),
        last4: extractLast4_(afterLabel_(body, 'Cuenta de origen') || body),
        externalId: afterLabel_(body, 'Número de operación')
      };
    }
  },
  {
    bank: 'BCP', sender: 'notificaciones@notificacionesbcp.com.pe',
    label: 'Transferencia a terceros',
    match: function (subject) { return /constancia de transferencia a terceros/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto transferido') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Enviado a');
      var own = isOwnAccount_(recipient);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency, description: recipient,
        last4: extractLast4_(afterLabel_(body, 'Desde') || body),
        externalId: afterLabel_(body, 'Número de operación')
      };
    }
  },
  // ---- Apple (subscription / App Store receipts) ----
  // The receipt itself names the card ("Visa •••• 3052"), so unlike most
  // rules the Payment Method is resolved by last4, not guessed. The order id
  // ("ID del pedido") is the dedup key — every renewal gets a fresh one.
  {
    bank: 'Interbank', sender: 'no_reply@email.apple.com',
    label: 'Recibo de Apple',
    match: function (subject) { return /recibo de apple|receipt from apple/i.test(subject); },
    extract: function (subject, body) {
      var totalMatch = body.match(/[\u2022*Xx]{2,}\s*\d{4}\s*\n+\s*((?:S\/\.?|US\$|\$)\s*[\d,]+(?:\.\d{2})?)/);
      var amt = extractAmount_(totalMatch ? totalMatch[1] : null);
      if (!amt) return null;
      // Item name = the line right after the Apple-account email line.
      var lines = body.split(/\r?\n/).map(cleanText_).filter(Boolean);
      var acct = lines.findIndex(function (l) { return /^Cuenta de Apple/i.test(l); });
      var emailIdx = -1;
      for (var i = acct + 1; acct !== -1 && i < lines.length && emailIdx === -1; i++) {
        if (/@/.test(lines[i])) emailIdx = i;
      }
      var item = emailIdx !== -1 && lines[emailIdx + 1] ? lines[emailIdx + 1] : 'Apple';
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: item, merchant: item,
        last4: extractLast4_(body.substring(body.search(/[\u2022*Xx]{2,}\s*\d{4}/)) || null),
        externalId: afterLabel_(body, 'ID del pedido')
      };
    }
  },
  // ---- DiDi (taxi/moto trips) ----
  // DiDi sends no card notification of its own and its receipt only says
  // "Credit / Debit Card", so trips are assigned to the Interbank credit
  // card (owner's choice) and always to Transport. The receipt has no
  // order id, so the dedup key is built from the trip date, total and
  // pickup/dropoff times (two same-price trips in a day still differ).
  {
    bank: 'Interbank', sender: 'didi@pe.didiglobal.com',
    label: 'Viaje DiDi',
    match: function (subject, body) { return /fare breakdown|thanks for riding/i.test(body); },
    extract: function (subject, body) {
      var totalMatch = body.match(/(?:^|\n)\s*\*?Total\*?\s+([^\n]+)/);
      var amt = extractAmount_(totalMatch ? totalMatch[1] : null);
      if (!amt) return null;
      var service = body.match(/thanks for riding with ([^\n*]+)/i);
      var dateLine = body.match(/[A-Za-z]{3}, \d{1,2} [A-Za-z]{3}, \d{4}/);
      var times = body.match(/\d{1,2}:\d{2}\s*[ap]m/gi) || [];
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: 'DiDi' + (service ? ' ' + cleanText_(service[1]) : ''),
        merchant: 'DiDi', defaultCategory: 'Transport',
        last4: null,
        externalId: fallbackExternalId_('didi', dateLine ? dateLine[0] : '', amt.amount, times.join('-'))
      };
    }
  },
  // ---- Yape ----
  {
    bank: 'Yape', sender: 'notificaciones@yape.pe',
    label: 'Yapeo enviado',
    match: function (subject, body) { return /acabas de yapear/i.test(body); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto de yapeo') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Nombre del Beneficiario');
      return {
        type: 'expense', needsReview: true,
        amount: amt.amount, currency: amt.currency, description: 'Yape a ' + recipient,
        last4: null,
        externalId: afterLabel_(body, 'de operación')
      };
    }
  },
  // A separate USD wallet ("Yape dólares"), a different email template
  // from the PEN one above — no "Monto de yapeo"/"Nombre del
  // Beneficiario" labels at all; the amount and recipient are embedded
  // inline in a sentence instead ("Yapeaste $10.11 a Mia Lo*. Has
  // hecho un yapeo con 'Yape dólares'."). Added from a real sample
  // (Yape_dolares.pdf) — matched on that exact quoted phrase, distinct
  // enough from the PEN rule's "acabas de yapear" body text that the two
  // can never both match the same email. extractAmount_ already reads
  // the currency from the $ sign itself (see the file header comment),
  // so this doesn't need to hardcode USD.
  {
    bank: 'Yape', sender: 'notificaciones@yape.pe',
    label: 'Yapeo enviado (dólares)',
    match: function (subject, body) { return /yape\s*d[oó]lares/i.test(body); },
    extract: function (subject, body) {
      var amt = extractAmount_(body);
      if (!amt) return null;
      var recipientMatch = body.match(/Yapeaste\s+\S+\s+a\s+([^\n]+?)\.\s*Has hecho/i);
      var recipient = recipientMatch ? cleanText_(recipientMatch[1]) : null;
      return {
        type: 'expense', needsReview: true,
        amount: amt.amount, currency: amt.currency,
        description: recipient ? ('Yape a ' + recipient) : 'Yape',
        last4: null,
        externalId: afterLabel_(body, 'de operación')
      };
    }
  },
  // ---- Diners ----
  {
    bank: 'Diners', sender: 'avisos@dinersenlinea.pe',
    label: 'Consumo',
    match: function () { return true; },
    extract: function (subject, body) {
      var amt = extractAmount_(body);
      if (!amt) return null;
      var merchantMatch = body.match(/en el comercio ([^\n]+?) por/i);
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: merchantMatch ? merchantMatch[1].trim() : null,
        merchant: merchantMatch ? merchantMatch[1].trim() : null,
        last4: null, // no card digits in this email; matched by bank alone
        externalId: null
      };
    }
  },
  {
    bank: 'Diners', sender: 'dinersenlinea@dinersclub.com.pe',
    label: 'Pago de tarjeta (transferencia interna)',
    cardIsDestination: true,
    match: function () { return true; },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto') || body);
      if (!amt) return null;
      return {
        type: 'transfer', amount: amt.amount, currency: amt.currency,
        description: 'Pago tarjeta Diners',
        last4: extractLast4_(afterLabel_(body, 'Tarjeta') || body),
        externalId: afterLabel_(body, 'Operación:')
      };
    }
  },
  // ---- Interbank (card/account notifications) ----
  {
    bank: 'Interbank', sender: 'servicioalcliente@netinterbank.com.pe',
    label: 'Consumo',
    match: function (subject) { return /realizaste un consumo/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto') || body);
      if (!amt) return null;
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: afterLabel_(body, 'Comercio'),
        merchant: afterLabel_(body, 'Comercio'),
        last4: extractLast4_(afterLabel_(body, 'Tarjeta') || body),
        externalId: null
      };
    }
  },
  {
    bank: 'Interbank', sender: 'servicioalcliente@netinterbank.com.pe',
    label: 'Pago de servicios',
    match: function (subject) { return /^constancia de pago$/i.test(subject.trim()); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Moneda y monto') || body);
      if (!amt) return null;
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: afterLabel_(body, 'Empresa'),
        merchant: afterLabel_(body, 'Empresa'),
        last4: extractLast4_(afterLabel_(body, 'Cuenta cargo') || body),
        externalId: afterLabel_(body, 'Código de operación')
      };
    }
  },
  {
    bank: 'Interbank', sender: 'servicioalcliente@netinterbank.com.pe',
    label: 'Transferencia',
    match: function (subject) { return /constancia de transferencia$/i.test(subject.trim()); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto y moneda') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Cuenta destino');
      var own = isOwnAccount_(recipient);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency, description: recipient,
        last4: extractLast4_(afterLabel_(body, 'Cuenta a cargo') || body),
        externalId: afterLabel_(body, 'Código de operación')
      };
    }
  },
  // `bank: 'Plin'`, not 'Interbank', even though the email itself comes
  // from Interbank's own sender address (fixed 2026-09-23 — a real
  // transaction, "estacionamiento Morelli," was landing tagged as paid
  // by the owner's Interbank CREDIT CARD, per the owner's own report).
  // Plin isn't its own company with its own email sender — each bank
  // emails its own "Constancia de Pago Plin" for a payment made through
  // ITS app, so `sender` has to stay Interbank's address for Gmail to
  // even find the email. But `rule.bank` is what `processOneMessage_`
  // (Api.gs) uses to pick a Payment Method — filtered to Payment Methods
  // under that bank, then narrowed by `last4` if one was extracted, else
  // falling back to "the only one" if there's exactly one. This email's
  // own "Cuenta cargo" line never carries masked card digits ("Cuenta
  // Simple," not "**** 1234"), so `last4` is always null here — meaning
  // the fallback always fired, and the owner's Interbank bank has
  // exactly one OTHER payment method on file: their actual credit card.
  // Every Plin payment via Interbank was silently attributed to that
  // card instead of to the dedicated "Plin" wallet Payment Method that
  // actually exists for exactly this. Pointing `bank` at 'Plin' instead
  // makes the same fallback resolve to that wallet correctly.
  {
    bank: 'Plin', sender: 'servicioalcliente@netinterbank.com.pe',
    label: 'Pago Plin',
    match: function (subject) { return /constancia de pago plin/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto y moneda') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Destinatario');
      var own = isOwnAccount_(recipient);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency,
        description: own ? 'Plin (propio)' : 'Plin a ' + recipient,
        last4: extractLast4_(afterLabel_(body, 'Cuenta cargo') || body),
        externalId: afterLabel_(body, 'Código de operación')
      };
    }
  },
  // ---- Interbank (credit card bill payment — different sender) ----
  {
    bank: 'Interbank', sender: 'notificaciones@interbank.pe',
    label: 'Pago de deuda (transferencia interna)',
    cardIsDestination: true,
    match: function () { return true; },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto pagado') || body);
      if (!amt) return null;
      return {
        type: 'transfer', amount: amt.amount, currency: amt.currency,
        description: 'Pago tarjeta Interbank',
        last4: extractLast4_(afterLabel_(body, 'Tarjeta de crédito') || body),
        externalId: afterLabel_(body, 'código de operación')
      };
    }
  },
  // ---- SIP (card notifications) ----
  {
    bank: 'SIP', sender: 'no-reply@servicioalcliente.sip.pe',
    label: 'Consumo',
    match: function (subject) { return /realizaste un consumo/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto') || body);
      if (!amt) return null;
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: afterLabel_(body, 'Establecimiento'),
        merchant: afterLabel_(body, 'Establecimiento'),
        last4: extractLast4_(afterLabel_(body, 'Tarjeta Titular') || body),
        externalId: null
      };
    }
  },
  {
    bank: 'SIP', sender: 'no-reply@servicioalcliente.sip.pe',
    label: 'Pago de tarjeta (transferencia interna) — canonical, dedup source',
    cardIsDestination: true,
    match: function (subject) { return /pago de tu tarjeta de cr.dito sip se realiz/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto abonado') || body);
      if (!amt) return null;
      return {
        type: 'transfer', amount: amt.amount, currency: amt.currency,
        description: 'Pago tarjeta Sip',
        last4: null,
        externalId: afterLabel_(body, 'Número de operación')
      };
    }
  },
  // ---- SIP (account-level operations, one generic sender/subject) ----
  {
    bank: 'SIP', sender: 'no-reply@operaciones.agora.pe',
    label: 'Pago de tarjeta — IGNORED, duplicate of servicioalcliente.sip.pe version above',
    match: function (subject, body) { return /operaci.n realizada:\s*pago tarjeta/i.test(body); },
    skip: true
  },
  {
    bank: 'SIP', sender: 'no-reply@operaciones.agora.pe',
    label: 'Transferencia a otro banco',
    match: function (subject, body) { return /transferencia a otro banco/i.test(body); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Destino');
      var own = isOwnAccount_(recipient);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency, description: recipient,
        last4: null,
        externalId: afterLabel_(body, 'Nro. de Operación')
      };
    }
  },
  {
    bank: 'SIP', sender: 'no-reply@operaciones.agora.pe',
    label: 'Enviar a celular',
    match: function (subject, body) { return /enviar a celular/i.test(body); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Enviado a');
      var own = isOwnAccount_(recipient);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency,
        description: own ? 'Envío a celular (propio)' : 'Envío a celular: ' + recipient,
        last4: null,
        externalId: afterLabel_(body, 'Nro. de Operación')
      };
    }
  }
];

// ---- Default category for auto-captured entries ----
// See CategoryGuess.gs — merchant history first, then Programmed items.

// Shared by capture (processOneMessage_) and the merchant backfill so both
// compute the exact same dedup fingerprint for a given email.
function computeEmailExternalId_(sender, dateStr, fields) {
  return fields.externalId || fallbackExternalId_(sender, dateStr, fields.amount, fields.description);
}

/**
 * Confirms a pending entry. Shared by both the app's plain Confirm button
 * and the Telegram bot's Confirm tap. (It used to also teach the Category
 * Keywords sheet from the confirmed description; category guessing now
 * learns from confirmed entries' `merchant` directly — see
 * CategoryGuess.gs — so there's nothing to teach here.)
 *
 * Also closes a real gap found 2026-09-17: the split-entry UI's own
 * "100% to whoever paid, by default" logic (see saveEntrySplits in
 * Loans.gs) only ever ran from the frontend — the app's own entry-form
 * submit handler, and the Phase 5.7 "Split" popup. Neither the app's
 * plain Confirm button nor Telegram's ever called it, so a friend-paid
 * expense confirmed through either of those (e.g. after a Telegram
 * "paid by Ana" reply) silently got no loan at all, even though it
 * displayed "paid by Ana" — the debt just didn't exist anywhere. Now
 * every confirm path runs the same default. Skipped when a real split
 * already exists for this entry (e.g. from a Telegram "split ..." reply,
 * or the in-app Split popup already having called saveEntrySplits
 * itself) — saveEntrySplits replaces whatever's there from scratch, so
 * calling it again with an empty list here would silently wipe out a
 * split the owner just went to the trouble of setting up.
 */
function confirmEntryWithLearning_(entryId) {
  var entry = getEntryById_(entryId);
  if (entry && entry.type === 'expense' && !getEntrySplits(entryId).length) {
    saveEntrySplits(entryId, []);
  }
  setEntryField_(entryId, 'status', 'confirmed');
}

function uniqueSenders_() {
  var seen = {};
  EMAIL_RULES.forEach(function (r) { seen[r.sender] = true; });
  return Object.keys(seen);
}

function getProcessedLabel_() {
  var name = 'ExpenseTracker-Processed';
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

/**
 * opts (all optional, used by the one-off back-check route):
 *   days    — how far back to search (default 3, the normal 15-minute scan)
 *   senders — only these sender addresses (default: every rule's sender)
 * Safe to run over old mail: anything already in Entries is skipped by its
 * external_id, whatever the "processed" label says.
 */
function processEmails(opts) {
  opts = opts || {};
  var results = { created: 0, skipped: 0, duplicates: 0 };
  var label = getProcessedLabel_();

  // Read the entries table once per run rather than once per message —
  // with thousands of historical rows now imported, re-reading it for
  // every candidate email would add up fast.
  var existingExternalIds = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.external_id) existingExternalIds[e.external_id] = true;
  });
  var banks = getAllRows('Banks');
  var paymentMethods = getAllRows('Payment Methods');
  ensureEntriesMerchantColumn_();
  ensureEntriesToPaymentMethodColumn_();
  var guessCtx = buildGuessContext_();

  (opts.senders || uniqueSenders_()).forEach(function (sender) {
    var threads = GmailApp.search('from:' + sender + (opts.days ? '' : ' -label:ExpenseTracker-Processed') + ' newer_than:' + (opts.days || 3) + 'd');
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        processOneMessage_(message, sender, results, existingExternalIds, banks, paymentMethods, guessCtx);
      });
      thread.addLabel(label);
    });
  });

  Logger.log('processEmails: ' + JSON.stringify(results));
  return results;
}

function processOneMessage_(message, sender, results, existingExternalIds, banks, paymentMethods, guessCtx) {
  var subject = message.getSubject();
  var body = message.getPlainBody();
  var tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
  // The email's own timestamp, not "now" — automation runs on a delay
  // (up to 15 min), so this is closer to when the transaction actually
  // happened and is what same-day entries sort by.
  var createdAt = Utilities.formatDate(message.getDate(), tz, "yyyy-MM-dd'T'HH:mm:ss");

  var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; })
    .find(function (r) { return r.match(subject, body); });

  if (!rule || rule.skip) { results.skipped++; return; }

  var fields = rule.extract(subject, body);
  if (!fields) { results.skipped++; return; }

  var externalId = computeEmailExternalId_(sender, dateStr, fields);

  if (existingExternalIds[externalId]) { results.duplicates++; return; }
  existingExternalIds[externalId] = true;

  var bank = banks.find(function (b) { return b.name === rule.bank; });
  var paymentMethod = null;
  if (bank) {
    var pms = paymentMethods.filter(function (pm) { return pm.bank_id === bank.id; });
    paymentMethod = fields.last4
      ? pms.find(function (pm) { return String(pm.last_4) === String(fields.last4); })
      : (pms.length === 1 ? pms[0] : null);
  }

  var guess = guessCategoryForEmail_(fields, dateStr, guessCtx);

  var entry = {
    id: Utilities.getUuid(),
    type: fields.type,
    date: dateStr,
    amount: fields.amount,
    currency: fields.currency,
    category_id: guess.categoryId,
    description: fields.description || '',
    payment_method_id: paymentMethod ? paymentMethod.id : '',
    paid_by: 'me',
    status: 'pending',
    source: 'email',
    external_id: externalId,
    import_batch_id: '',
    created_at: createdAt,
    merchant: normalizeMerchant_(fields.merchant)
  };

  // A card-bill-payment email comes from the CARD's bank and names the
  // card, but the money left some other account of the owner's — so the
  // card it matched is where the money went (To), and From is left blank
  // for the owner to pick (Telegram: "from Plin"; in-app: From picker).
  if (rule.cardIsDestination && paymentMethod) {
    entry.to_payment_method_id = paymentMethod.id;
    entry.payment_method_id = '';
  }

  appendRowObject('Entries', entry);
  results.created++;

  var guessedCategory = guess.categoryId ? guessCtx.categoriesById[guess.categoryId] : null;
  sendTelegramEntryNotification_(entry, guessedCategory ? guessedCategory.name : null, guess.reason);
}

/**
 * Temporary debug helper: removes the "processed" label from the newest
 * message matching a search, so it can be re-scanned after a rule fix.
 */
function debugUnlabel_(query) {
  var threads = GmailApp.search(query, 0, 1);
  if (!threads.length) return { found: false };
  threads[0].removeLabel(getProcessedLabel_());
  return { found: true, subject: threads[0].getMessages()[0].getSubject() };
}

/**
 * Temporary debug helper: returns the raw plain-text body of the newest
 * matching message so extraction regexes can be fixed against real data.
 */
function debugGmailSearch_(query) {
  var threads = GmailApp.search(query, 0, 1);
  if (!threads.length) return { found: false };
  var messages = threads[0].getMessages();
  var msg = messages[messages.length - 1];
  return {
    found: true,
    subject: msg.getSubject(),
    from: msg.getFrom(),
    body: msg.getPlainBody()
  };
}

/**
 * Fills the Parsing Rules sheet as a human-readable log of what's
 * configured above — not executed, just for reference. Rebuilds the
 * sheet from the live EMAIL_RULES array every time (clears existing rows
 * first, then rewrites) rather than only seeding an empty sheet, so it's
 * genuinely "safe to re-run" whenever a rule is added or changed in code
 * — the original seed-only-if-empty version left the sheet silently
 * stale after the first time it was ever populated, since re-running it
 * was a no-op (found 2026-09-22 adding the Yape-dólares rule below).
 */
function seedParsingRulesDoc() {
  var banks = getAllRows('Banks');
  var rows = EMAIL_RULES.map(function (r) {
    var bank = banks.find(function (b) { return b.name === r.bank; });
    return {
      id: Utilities.getUuid(),
      bank_id: bank ? bank.id : '',
      sender: r.sender,
      pattern: r.label + (r.skip ? ' (ignored)' : ''),
      field_mappings: 'See EmailParser.gs — logic lives in code, this row is documentation only.'
    };
  });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Parsing Rules');
  if (!sheet) throw new Error('Run "1. Build sheet tabs" first — missing sheet: Parsing Rules');
  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var values = rows.map(function (row) {
    return headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; });
  });
  if (values.length) sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

/**
 * Read-only diagnostic: every recent message from the given senders, with
 * which rule (if any) matched it and a short body preview — for finding out
 * why an email was skipped. Writes nothing.
 */
function debugListEmails_(senders, days) {
  var out = [];
  var tz = Session.getScriptTimeZone();
  senders.forEach(function (sender) {
    GmailApp.search('from:' + sender + ' newer_than:' + (days || 7) + 'd', 0, 50).forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        var subject = message.getSubject();
        var body = message.getPlainBody();
        var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; })
          .find(function (r) { return r.match(subject, body); });
        out.push({
          sender: sender,
          date: Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd HH:mm'),
          subject: subject,
          rule: rule ? rule.label + (rule.skip ? ' (ignored)' : '') : null,
          preview: body.replace(/\s+/g, ' ').substring(0, 400)
        });
      });
    });
  });
  return out;
}
