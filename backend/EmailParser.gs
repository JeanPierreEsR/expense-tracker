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
  var m = text.match(/[*Xx]{2,}\s*(\d{4})\b/);
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
        last4: null, // no card digits in this email; matched by bank alone
        externalId: null
      };
    }
  },
  {
    bank: 'Diners', sender: 'dinersenlinea@dinersclub.com.pe',
    label: 'Pago de tarjeta (transferencia interna)',
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
  {
    bank: 'Interbank', sender: 'servicioalcliente@netinterbank.com.pe',
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
        last4: extractLast4_(afterLabel_(body, 'Tarjeta Titular') || body),
        externalId: null
      };
    }
  },
  {
    bank: 'SIP', sender: 'no-reply@servicioalcliente.sip.pe',
    label: 'Pago de tarjeta (transferencia interna) — canonical, dedup source',
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

function uniqueSenders_() {
  var seen = {};
  EMAIL_RULES.forEach(function (r) { seen[r.sender] = true; });
  return Object.keys(seen);
}

function getProcessedLabel_() {
  var name = 'ExpenseTracker-Processed';
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function processEmails() {
  var results = { created: 0, skipped: 0, duplicates: 0 };
  var label = getProcessedLabel_();

  uniqueSenders_().forEach(function (sender) {
    var threads = GmailApp.search('from:' + sender + ' -label:ExpenseTracker-Processed newer_than:3d');
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        processOneMessage_(message, sender, results);
      });
      thread.addLabel(label);
    });
  });

  Logger.log('processEmails: ' + JSON.stringify(results));
  return results;
}

function processOneMessage_(message, sender, results) {
  var subject = message.getSubject();
  var body = message.getPlainBody();
  var dateStr = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; })
    .find(function (r) { return r.match(subject, body); });

  if (!rule || rule.skip) { results.skipped++; return; }

  var fields = rule.extract(subject, body);
  if (!fields) { results.skipped++; return; }

  var externalId = fields.externalId || fallbackExternalId_(sender, dateStr, fields.amount, fields.description);

  var existing = getAllRows('Entries').find(function (e) { return e.external_id === externalId; });
  if (existing) { results.duplicates++; return; }

  var bank = getAllRows('Banks').find(function (b) { return b.name === rule.bank; });
  var paymentMethod = null;
  if (bank) {
    var pms = getAllRows('Payment Methods').filter(function (pm) { return pm.bank_id === bank.id; });
    paymentMethod = fields.last4
      ? pms.find(function (pm) { return String(pm.last_4) === String(fields.last4); })
      : (pms.length === 1 ? pms[0] : null);
  }

  var entry = {
    id: Utilities.getUuid(),
    type: fields.type,
    date: dateStr,
    amount: fields.amount,
    currency: fields.currency,
    category_id: '',
    description: fields.description || '',
    payment_method_id: paymentMethod ? paymentMethod.id : '',
    paid_by: 'me',
    status: 'pending',
    source: 'email',
    external_id: externalId,
    import_batch_id: ''
  };

  appendRowObject('Entries', entry);
  results.created++;

  sendTelegramEntryNotification_(entry, null);
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
 * configured above — not executed, just for reference. Safe to re-run.
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
  seedIfEmpty('Parsing Rules', rows);
}
