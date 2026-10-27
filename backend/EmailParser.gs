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

// The person's own name is learned, not typed (OwnerNames.gs): the recipient is "me" only when ALL the words of one of their
// names are in it — not just the surname, since people transfer to relatives who share it.
function isOwnAccount_(name) {
  if (!name) return false;
  return isOwnFullName_(name);
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

// Interbank names the debited ACCOUNT under "Cuenta cargo"/"Cuenta a cargo"
// as a few lines ("Cuenta Simple / Soles / 000 0000000000"), not a masked
// card, so the last four digits of that account number are what identify
// which of the owner's accounts it was (falls back to a masked card's
// digits when the account is a card).
function extractAccountLast4_(body, label) {
  var i = body.search(new RegExp(label, 'i'));
  if (i === -1) return null;
  var chunk = body.substring(i, i + 300).replace(/(\d)[ -](?=\d)/g, '$1');
  var m = chunk.match(/\d{10,}/);
  return m ? m[0].slice(-4) : extractLast4_(chunk);
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

// BCP and Yape emails don't name the account (a debit-card email carries card
// digits, a Yape email nothing at all), but the money always leaves the
// BCP account of that currency — Yape is a rail on top of it, like Plin on
// Interbank. Used when the email's own last4 doesn't identify one.
var BCP_ACCOUNTS = { PEN: 'BCP soles', USD: 'BCP dolares' };

var EMAIL_RULES = [
  // ---- BCP ----
  {
    bank: 'BCP', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@notificacionesbcp.com.pe',
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
    bank: 'BCP', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@notificacionesbcp.com.pe',
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
    bank: 'BCP', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@notificacionesbcp.com.pe',
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
  // BCP to ANOTHER bank (e.g. to the owner's own Interbank account). Same shape as "a terceros", other
  // labels: the amount is under "Monto enviado" (a commission line follows, so "Total cobrado" is the real
  // debit), and "Desde" appears twice (intro sentence, then the data block), so the source account's last
  // four digits are read from the line pair "Desde *Clasica*" / "**** 0005" only.
  {
    bank: 'BCP', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@notificacionesbcp.com.pe',
    label: 'Transferencia a otros bancos',
    match: function (subject) { return /constancia de transferencia a otros bancos/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Total cobrado') || afterLabel_(body, 'Monto enviado') || body);
      if (!amt) return null;
      var recipient = afterLabel_(body, 'Enviado a');
      var own = !!recipient && isOwnNameWithInitial_(recipient);
      var from = body.match(/\n\s*\*?Desde\*?\s*\*?[^\n]*\n\s*\*{2,}\s*(\d{4})\b/);
      return {
        type: own ? 'transfer' : 'expense', needsReview: !own,
        amount: amt.amount, currency: amt.currency, description: recipient,
        last4: from ? from[1] : null,
        externalId: afterLabel_(body, 'Número de operación')
      };
    }
  },
  // Money RECEIVED by Yapeo on the BCP account ("Recibiste un yapeo de S/ 250.00 de <who>"). Built from a friend's forwarded copy
  // (2026-10-26). The email has "Monto recibido" and "Enviado por <who>" but NO operation number, so the entry's id is generated
  // from the message (computeEmailExternalId_). Always lands pending.
  {
    bank: 'BCP', rail: 'yape', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@notificacionesbcp.com.pe',
    label: 'Yapeo recibido',
    match: function (subject) { return /constancia de recepci.n de yapeo/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto recibido') || body);
      if (!amt) return null;
      var from = afterLabel_(body, 'Enviado por');
      if (!from) {   // the sentence wraps over two lines in the real email, so the label above is the reliable one
        var m = body.match(/recibiste un yapeo de\s*\*?\s*(?:S\/\.?|US\$|\$)\s*[\d,.]+\s*\*?\s+de\s+([^\r\n]+)/i);
        from = m ? cleanText_(m[1]).replace(/\.$/, '') : null;
      }
      return {
        type: 'income', needsReview: true,
        amount: amt.amount, currency: amt.currency, description: from ? 'Yape de ' + from : 'Yape recibido',
        last4: null,
        externalId: null
      };
    }
  },
  // EBANX is a payment processor many foreign shops use for Peruvian cards (the statement shows "EBN*<SHOP>"). The email names the card
  // by its last four digits ("Últimos dígitos tarjeta de crédito") but not the bank, so there is no `bank` on the rule (like the exchange
  // house) and the account is found by those digits among ALL the person's accounts (see the bank-less lookup in the entry builder);
  // if no single account has them it stays blank for review. The amount is "Valor final en <CUR>" (what was really charged). The shop is
  // read from the subject ("Pago confirmado del pedido BL123 de Adobe - Braintree" -> Adobe); the order number is the dedup id. If no
  // amount can be found the email is listed under "Bank emails I couldn't read" instead of guessed.
  {
    sender: 'payments@ebanx.com', house: 'EBANX',   // `house`: a name for "Your bank is ready" without being an account (listSupportedSenders)
    label: 'Pago confirmado (EBANX)',
    match: function (subject) { return /pago confirmado del pedido/i.test(subject); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Valor final en [A-Z]{3}') || body);
      if (!amt) return null;
      var m = subject.match(/pedido\s+(\S+)\s+de\s+(.+)$/i);
      var shop = m ? cleanText_(m[2]).split(/\s+-\s+/)[0] : null;
      return {
        type: 'expense', needsReview: true,
        amount: amt.amount, currency: amt.currency, description: shop, merchant: shop,
        last4: (String(afterLabel_(body, 'Últimos dígitos tarjeta de crédito') || '').match(/\b(\d{4})\b/) || [])[1] || null,   // plain digits, not masked
        externalId: m ? 'ebanx-' + m[1] : null
      };
    }
  },
  // ---- Exchange house: one confirmation names BOTH sides of the exchange (CurrencyExchange.gs) ----
  // The sender is the exact address the e-mails really come from (a look-alike of a webmail domain, so it is matched whole, never by domain);
  // the rule also needs the "Enviaste" and "Recibirás" lines, so a spoofed or unrelated mail from that address matches nothing.
  // No `bank`: it is not an account the person holds, so More → Bank emails does not list it.
  {
    sender: 'no-reply@gmai.com', house: 'Cambio Mundial', exchange: true,
    label: 'Cambio de moneda (Cambio Mundial): confirmación de operación',
    match: function (subject, body) { return /confirmaci[oó]n de operaci[oó]n/i.test(subject) && /Enviaste:/i.test(body) && /Recibir[aá]s:/i.test(body); },
    extract: function () { return null; }   // two legs, not one entry: processExchangeEmail_ reads it
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
        last4: '3052', // Interbank Visa Infinite — pinned, see rule comment
        externalId: fallbackExternalId_('didi', dateLine ? dateLine[0] : '', amt.amount, times.join('-'))
      };
    }
  },
  // ---- Crecer Seguros (card-protection insurance, monthly boleta) ----
  // The e-invoice email names the product and the total but no card, so the
  // charge is pinned to the Diners credit card (owner's choice; it is the
  // only Payment Method under that bank, so no last4 is needed) and to the
  // "Credit card" category. The boleta number is the dedup key — each month
  // has a new one.
  {
    bank: 'Diners', sender: 'tucomprobante@crecerseguros.pe',
    label: 'Seguro protección de tarjetas',
    match: function (subject, body) { return /Monto Total/i.test(body); },
    extract: function (subject, body) {
      var amt = extractAmount_(afterLabel_(body, 'Monto Total'));
      if (!amt) return null;
      var product = afterLabel_(body, 'Producto');
      return {
        type: 'expense', amount: amt.amount, currency: amt.currency,
        description: 'Crecer Seguros' + (product ? ' - ' + product.replace(/([a-z])([A-Z])/g, '$1 $2') : ''),
        merchant: 'Crecer Seguros', defaultCategory: 'Credit card',
        last4: null,
        externalId: afterLabel_(body, 'Número')
      };
    }
  },
  // ---- Yape ----
  {
    bank: 'Yape', rail: 'yape', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@yape.pe',
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
    bank: 'Yape', rail: 'yape', accountByCurrency: BCP_ACCOUNTS, sender: 'notificaciones@yape.pe',
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
  // Paying the Diners bill from the Interbank debit card produces TWO emails
  // for the one payment: this "consumo" (merchant "Diners Club") and Diners'
  // own "comprobante de pago" (the transfer rule below). Keep the Diners one
  // — it's the transfer, and counting this as an expense too would double it.
  {
    bank: 'Interbank', sender: 'servicioalcliente@netinterbank.com.pe',
    label: 'Consumo en "Diners Club" — IGNORED, duplicate of the Diners payment email',
    match: function (subject, body) {
      return /realizaste un consumo/i.test(subject) && /Comercio\s*:?\s*\*?\s*\r?\n?\s*Diners Club\s*(?:[\r\n]|Monto)/i.test(body);
    },
    skip: true
  },
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
        // Some purchase emails carry no masked digits, only the card's name in
        // the subject ("...con tu Tarjeta Interbank Visa Infinite"); with
        // several Interbank payment methods the "only one" fallback no longer
        // applies, so that name pins the credit card (…3052).
        last4: extractLast4_(afterLabel_(body, 'Tarjeta') || body)
          || (/visa infinite/i.test(subject) ? '3052' : null),
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
        last4: extractAccountLast4_(body, 'Cuenta cargo'),
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
        last4: extractAccountLast4_(body, 'Cuenta a cargo'),
        externalId: afterLabel_(body, 'Código de operación')
      };
    }
  },
  // Plin is a payment rail, not an account: the money always leaves one of
  // the owner's Interbank savings accounts (IBK soles / IBK dolares), and
  // this email names it under "Cuenta cargo" ("Cuenta Simple / Soles /
  // 000 0000000000"). So it resolves like any other Interbank rule — by
  // the account's last four digits. (Until 2026-09-24 this rule pointed at
  // `bank: 'Plin'` so a payment wouldn't fall back to the Interbank credit
  // card; with real accounts registered, the account number does the job.)
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
        last4: extractAccountLast4_(body, 'Cuenta cargo'),
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
// An email with no operation number is identified by sender+date+amount+
// description AND its own Gmail message id (messageId, when known): two
// genuinely separate identical purchases on one day are two different emails
// and must be two entries (the "possible duplicate" warning flags the pair),
// while re-reading the SAME email still gives the same id. Callers without a
// message (the old merchant back-fill) get the older, message-less key.
function computeEmailExternalId_(sender, dateStr, fields, messageId) {
  return fields.externalId ||
    fallbackExternalId_(sender, dateStr, fields.amount, (fields.description || '') + (messageId ? '|' + messageId : ''));
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
  // Every confirmed entry has a category (the app's own Confirm enforces it
  // too); one without would show as uncategorised in every report.
  if (entry && entry.type !== 'investment' && !entry.category_id) {
    throw new Error(tr_('err.pickCategoryFirst'));
  }
  if (entry && entry.type === 'investment' && needsInvestmentCategory_(entry.category_id)) {
    setEntryField_(entryId, 'category_id', defaultInvestmentCategoryId_());
  }
  // An investment only counts once it says which platform it went to (the
  // per-platform totals and every report read that field).
  if (entry && entry.type === 'investment' && !entry.to_payment_method_id) {
    throw new Error(tr_('err.pickPlatformFirst'));
  }
  if (entry && entry.type === 'expense' && !getEntrySplits(entryId).length) {
    saveEntrySplits(entryId, []);
  }
  if (entry && entry.trip_id === TRIP_DECLINED_) setEntryField_(entryId, 'trip_id', '');   // see Trips.gs
  setEntryField_(entryId, 'status', 'confirmed');
}

// For More → Bank emails and the "this bank can't be read yet" notes: the address whose inbox is read (empty when e-mail
// reading is off or Google won't say) and the names of the banks that have a parsing rule.
// The address whose inbox is read. A friend's copy asks Google for a short list of permissions that does not include "see your
// own address", so Session.getEffectiveUser().getEmail() comes back EMPTY there; the read-only Gmail permission it does have can
// name the mailbox (the same getProfile call the installer already makes). Remembered once found: it never changes for a copy.
function mailboxAddress_() {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperty('MAILBOX_ADDRESS');
  if (saved) return saved;
  var address = '';
  if (gmailUsesReadonly_()) {
    try { address = String(Gmail.Users.getProfile('me').emailAddress || ''); } catch (err) { address = ''; }
  }
  if (!address) {
    try { address = String(Session.getEffectiveUser().getEmail() || ''); } catch (err) { address = ''; }
  }
  if (address) props.setProperty('MAILBOX_ADDRESS', address);
  return address;
}

function getEmailInfo_() {
  var address = featureOn_('gmail') ? mailboxAddress_() : '';
  var seen = {};
  EMAIL_RULES.forEach(function (r) { if (r.bank) seen[r.bank] = true; });
  var settings = getSettingsMap();
  // `seen`: the day of the newest e-mail read for each bank ({} until the first one arrives); `since`: when the welcome questions were
  // answered (epoch milliseconds, '' on older copies). The app uses both to tick each bank and to say "no e-mail from X yet".
  return { address: address, banks: Object.keys(seen), seen: bankMailSeenMap_(settings), since: String(settings.onboarded_at || '') };
}

// Settings `bank_mail_seen` = JSON {bank: 'yyyy-mm-dd'}: the day of the newest e-mail that became an entry, per bank. It is JSON on
// purpose: a bare date in a Settings cell would be turned into a date by Sheets (see the text-date trap in the specs).
function bankMailSeenMap_(settings) {
  try {
    var map = JSON.parse(String((settings || getSettingsMap()).bank_mail_seen || '{}'));
    return (map && typeof map === 'object') ? map : {};
  } catch (err) { return {}; }
}

function noteBankMailSeen_(bank, dateStr) {
  if (!bank || !dateStr) return;
  var map = bankMailSeenMap_();
  if (map[bank] && String(map[bank]) >= String(dateStr)) return;   // only a newer day changes anything (each change bumps the sheet cache)
  map[bank] = String(dateStr);
  setSetting_('bank_mail_seen', JSON.stringify(map));
}

function uniqueSenders_() {
  var seen = {};
  EMAIL_RULES.forEach(function (r) { seen[r.sender] = true; });
  return Object.keys(seen);
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
  var results = { created: 0, skipped: 0, duplicates: 0, unparsed: 0, errors: 0, unparsedSubjects: [] };
  if (!featureOn_('gmail')) return results;   // reading e-mail was not approved for this copy: nothing to do

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

  var senders = opts.senders || uniqueSenders_();
  EXCHANGE_HOUSES_MEMO_ = null;   // learned from the entries as they are NOW (CurrencyExchange.gs)
  // Per-email memory (the "Processed Emails" tab): the one-off back-check
  // (opts.days) deliberately re-reads everything, so it skips it.
  var tracking = !opts.days;
  UNREAD_LOGGING_ = tracking;
  if (tracking) forgetMailReadByOldDecoder_();
  var handled = tracking ? loadProcessedEmailIds_() : {};
  // A back-check re-reads old mail, which overlaps entries typed or imported long ago under other reference numbers
  // (EmailCoverage.gs): such an e-mail is listed in the result, not created. `includeOverlaps: true` turns that off.
  BACKCHECK_OVERLAPS_ = (!tracking && !opts.includeOverlaps) ? buildEntryOverlapIndex_() : null;
  if (BACKCHECK_OVERLAPS_) { results.overlaps = 0; results.mayAlreadyBeIn = []; }

  try {
    processSenders_(senders, opts, tracking, handled, results, existingExternalIds, banks, paymentMethods, guessCtx);
  } finally {
    BACKCHECK_OVERLAPS_ = null;
  }

  Logger.log('processEmails: ' + JSON.stringify(results));
  return results;
}

var BACKCHECK_OVERLAPS_ = null;   // set only while a back-check runs

function processSenders_(senders, opts, tracking, handled, results, existingExternalIds, banks, paymentMethods, guessCtx) {
  senders.forEach(function (sender) {
    gmailSearchMessages_('from:' + sender + ' newer_than:' + (opts.days || 3) + 'd').forEach(function (message) {
      var messageId = String(message.getId());
      if (tracking && handled[messageId]) return;
      // One bad email must not block the rest of the run, and is NOT marked
      // handled, so the next run retries it (the duplicate check keeps
      // already-written entries from doubling).
      try {
        processOneMessage_(message, sender, results, existingExternalIds, banks, paymentMethods, guessCtx);
        if (tracking) { recordProcessedEmail_(messageId); handled[messageId] = true; }
      } catch (err) {
        results.errors++;
        console.error('processOneMessage_ (' + sender + '): ' + err);
      }
    });
  });
}

// ---- Per-email memory (sheet "Processed Emails") ----

function ensureProcessedEmailsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Processed Emails')) return;
  var sheet = ss.insertSheet('Processed Emails');
  var headers = TABLE_DEFINITIONS['Processed Emails'];
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Gmail ids are hex strings; Sheets would turn some (all digits, or like
  // "123e45") into numbers.
  sheet.getRange(1, 1, sheet.getMaxRows(), 2).setNumberFormat('@');
}

function recordProcessedEmail_(messageId) {
  appendRowObject('Processed Emails', { message_id: messageId, processed_at: nowTimestamp_() });
}

// Once, on a friend's copy: until the byte-list fix (GmailReader.gs gmailDecodePartData_) every e-mail it read was either refused or decoded
// into nonsense that matched no rule, and was then written down as "handled" — so a real bank e-mail would never be looked at again.
// Such a copy has never made an e-mail entry, so its list of handled e-mails is wiped once and the next scan reads the last 3 days afresh
// (anything already in Entries is still skipped by its external_id). A copy that HAS e-mail entries read fine, and is left alone.
function forgetMailReadByOldDecoder_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('MAIL_REREAD_BYTES_FIX')) return;
  props.setProperty('MAIL_REREAD_BYTES_FIX', '1');
  if (!isFriendCopy_()) return;
  if (getAllRows('Entries').some(function (e) { return e.source === 'email'; })) return;
  ensureProcessedEmailsSheet_();
  deleteRowsWhere_('Processed Emails', function () { return true; });
}

// message id -> true for every email already handled. Also tidies up old rows.
function loadProcessedEmailIds_() {
  ensureProcessedEmailsSheet_();
  var rows = getAllRows('Processed Emails');

  if (rows.length > 300) {
    var cutoff = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    deleteRowsWhere_('Processed Emails', function (r) { return String(r.processed_at) < cutoff; });
    rows = getAllRows('Processed Emails');
  }

  var handled = {};
  rows.forEach(function (r) { handled[String(r.message_id)] = true; });
  return handled;
}

function processOneMessage_(message, sender, results, existingExternalIds, banks, paymentMethods, guessCtx) {
  var subject = message.getSubject();
  var body = message.getPlainBody();
  learnOwnNameFromMail_(message, sender);
  var tz = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
  // The email's own timestamp, not "now" — automation runs on a delay
  // (up to 15 min), so this is closer to when the transaction actually
  // happened and is what same-day entries sort by.
  var createdAt = Utilities.formatDate(message.getDate(), tz, "yyyy-MM-dd'T'HH:mm:ss");

  var rule = EMAIL_RULES.filter(function (r) { return r.sender === sender; })
    .find(function (r) { return r.match(subject, body); });

  if (!rule) logUnreadEmail_(sender, subject, 'no_rule', dateStr);   // ManualGaps.gs; a rule with skip:true is a deliberate ignore, not logged
  if (!rule || rule.skip) { results.skipped++; return; }

  if (rule.exchange) {
    // An exchange house's confirmation: up to two legs, matched against what a bank e-mail already made (CurrencyExchange.gs).
    if (processExchangeEmail_(rule, message, sender, dateStr, createdAt, results, existingExternalIds) === -1) {
      logUnreadEmail_(sender, subject, 'unreadable', dateStr);
      results.skipped++;
      results.unparsed++;
      results.unparsedSubjects.push(String(subject || '').slice(0, 60));
    }
    return;
  }

  var fields = rule.extract(subject, body);
  if (!fields) {
    logUnreadEmail_(sender, subject, 'unreadable', dateStr);
    // The rule matched but the amount/details couldn't be read — most
    // likely the bank changed its wording. Counted separately so the
    // owner is told (see runAutomation) instead of it vanishing.
    results.skipped++;
    results.unparsed++;
    results.unparsedSubjects.push(String(subject || '').slice(0, 60));
    return;
  }

  // A payment to an exchange house is one leg of a currency exchange, not spending (CurrencyExchange.gs): it lands as a
  // one-sided transfer, and the review card offers "Currency exchange" to add the leg that arrived.
  if (fields.type === 'expense' && fields.description && exchangeHouseIn_(fields.description)) {
    fields.description = tr_('desc.exchangeHouse', { name: fields.description });
    fields.type = 'transfer';
    fields.merchant = '';
    fields.exchangeLeg = true;
  }

  var externalId = computeEmailExternalId_(sender, dateStr, fields, message.getId());

  if (existingExternalIds[externalId]) { results.duplicates++; return; }
  if (BACKCHECK_OVERLAPS_) {
    var twin = takeOverlap_(BACKCHECK_OVERLAPS_, fields.currency, fields.amount, dateStr);
    if (twin) {
      results.overlaps++;
      if (results.mayAlreadyBeIn.length < 200) {
        results.mayAlreadyBeIn.push({ date: dateStr, amount: fields.amount, currency: fields.currency, description: String(fields.description || '').slice(0, 40), matches: twin.source + ' ' + twin.type });
      }
      return;
    }
  }
  existingExternalIds[externalId] = true;

  var bank = banks.find(function (b) { return b.name === rule.bank; });
  var paymentMethod = null;
  if (bank) {
    var pms = paymentMethods.filter(function (pm) { return pm.bank_id === bank.id; });
    paymentMethod = fields.last4
      ? pms.find(function (pm) { return String(pm.last_4) === String(fields.last4); })
      : ((!rule.accountByCurrency && pms.length === 1) ? pms[0] : null);
  }
  // A rule with no bank (EBANX) still names the card by its last four digits: use them when exactly one account has them.
  if (!paymentMethod && !rule.bank && fields.last4) {
    var byCard = paymentMethods.filter(function (pm) { return String(pm.last_4) === String(fields.last4); });
    if (byCard.length === 1) paymentMethod = byCard[0];
  }
  // No account named in the email: the rule may say which account of that
  // currency the money always leaves (BCP, Yape).
  if (!paymentMethod && rule.rail) {
    paymentMethod = railAccount_(rule.rail, fields.currency, paymentMethods);   // Yape: the account the person linked (Accounts.gs)
  }
  if (!paymentMethod && rule.accountByCurrency && rule.accountByCurrency[fields.currency]) {
    paymentMethod = paymentMethods.find(function (pm) { return plainNickname_(pm.nickname) === plainNickname_(rule.accountByCurrency[fields.currency]); }) || null;
  }

  // The exchange house's own confirmation may already have made this "left" leg (it names both sides): then this e-mail only
  // tells which account paid, and a second leg would count the exchange twice.
  if (fields.exchangeLeg) {
    var leftTwin = findExchangeLegTwin_(getAllRows('Entries'), 'out', fields.currency, fields.amount, dateStr, exchangeCodeKey_(fields.externalId), 'bank');
    if (leftTwin) {
      if (paymentMethod && !leftTwin.payment_method_id) updateRowFields_('Entries', leftTwin.id, { payment_method_id: paymentMethod.id });
      results.duplicates++;
      return;
    }
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

  if (fields.exchangeLeg) { ensureEntriesExchangeColumn_(); entry.exchange = '1'; }
  appendRowObject('Entries', entry);
  autoTagTravelEntry_(entry);   // Travel is Annual by default
  results.created++;
  try { noteBankMailSeen_(rule.bank, dateStr); } catch (err) { console.error('noteBankMailSeen_: ' + err); }   // More → Bank emails ticks this bank

  var guessedCategory = guess.categoryId ? guessCtx.categoriesById[guess.categoryId] : null;
  // The entry is already saved as pending, so a failed Telegram send must
  // not abort the run or leave the email unlabeled — it still shows up in
  // the app's review queue.
  try {
    sendTelegramEntryNotification_(entry, guessedCategory ? categoryLabel_(guessedCategory) : null, telegramAutoReason_(guess));
  } catch (err) {
    console.error('Telegram notification failed: ' + err);
  }
}

/**
 * Temporary debug helper: returns the raw plain-text body of the newest
 * matching message so extraction regexes can be fixed against real data.
 */
function debugGmailSearch_(query) {
  var msgs = gmailSearchMessages_(query, { max: 1 });
  if (!msgs.length) return { found: false };
  var msg = msgs[0];
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
    gmailSearchMessages_('from:' + sender + ' newer_than:' + (days || 7) + 'd', { max: 50 }).forEach(function (message) {
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
  return out;
}

/**
 * Read-only diagnostic: a Gmail search returning, per thread, the newest
 * message's date, sender, subject and ATTACHMENT names/sizes — never the
 * body or attachment contents. Used to find out whether statements arrive
 * by email.
 */
function debugSearchEmails_(query, max) {
  var tz = Session.getScriptTimeZone();
  var out = [];
  gmailSearchMessages_(query, { max: Math.min(max || 20, 40) }).forEach(function (m) {
    out.push({
      date: Utilities.formatDate(m.getDate(), tz, 'yyyy-MM-dd'),
      from: m.getFrom(),
      subject: m.getSubject(),
      attachments: m.getAttachments().map(function (a) { return a.getName() + ' (' + Math.round(a.getSize() / 1024) + ' KB)'; })
    });
  });
  return out;
}

/**
 * Read-only: the subject, sender and plain-text body of the newest message
 * matching a Gmail search — for writing a new parsing rule from a real email
 * without asking the owner to copy the text out by hand.
 */
function debugEmailBody_(query, chars) {
  var found = gmailSearchMessages_(query, { max: 1 });
  if (!found.length) return null;
  var m = found[0];
  return {
    from: m.getFrom(), subject: m.getSubject(), date: String(m.getDate()),
    body: m.getPlainBody().substring(0, chars || 3000)
  };
}
