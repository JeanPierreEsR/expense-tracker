/**
 * Interbank "Constancia de pago" — money a company paid INTO the person's account (2026-11-07, owner's request).
 *
 * Interbank's "Pago Activo" service e-mails "<NAME>, has recibido un pago" from pagoactivo@notificaciones.interbank.pe.
 * The e-mail itself only says who paid; the amount is only in the attached PDF ("Constancia de pago": Ordenante, Fecha,
 * Tipo, then one line per invoice with Moneda and Monto). The owner gets these at his WORK address, so he sends the PDF
 * to his own Gmail by hand: a mail from himself to himself with the PDF attached (or the whole e-mail forwarded).
 *
 * Each such PDF becomes ONE waiting INCOME entry: payer as description, the PDF's date, the invoices added up per currency
 * (one entry per currency in the rare mixed case), into the account named in PAYMENT_NOTICE_ACCOUNT_ when it holds that
 * currency, else the person's only Interbank account for it, else none (picked on confirm). The PDF's file name (Interbank
 * names each notice uniquely) is the reference, so the same PDF sent twice, or the bank's own e-mail plus a forward of it,
 * makes one entry. Self-sent statements (account_summary…, EECC…) are never looked at here: they belong to the Statements
 * Inbox (StatementInbox.gs), which in turn leaves these notices out.
 */

var PAYMENT_NOTICE_SENDER_ = 'pagoactivo@notificaciones.interbank.pe';
var PAYMENT_NOTICE_ACCOUNT_ = 'IBK sueldo';      // owner's choice (2026-11-07); a copy without it falls back to its only Interbank account
var PAYMENT_NOTICE_MAX_KB_ = 400;                 // a one-page notice is ~40 KB; anything far bigger is some other document
var PAYMENT_NOTICE_FILE_ = /^\d{8}_\d{6}_\w+\.pdf$/i;   // how Interbank names them (date_time_number_code.pdf)

var PAYMENT_NOTICE_LABELS_ = ['ordenante', 'fecha', 'tipo', 'codigo del lote'];

function paymentNoticeFold_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An amount cell as it appears in the PDF ("S/. 1,234.50", "$ 99.00", "US$ 5.00") → {currency, amount}, or null. */
function paymentNoticeAmount_(s) {
  var m = /^(S\/\.?|US\$|\$)\s*([\d,]+\.\d{2})$/.exec(String(s || '').replace(/\s+/g, ' ').trim());
  if (!m) return null;
  var amount = Number(m[2].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  return { currency: /^S/.test(m[1]) ? 'PEN' : 'USD', amount: amount };
}

/**
 * The notice's fields from the PDF's words, or null when the words are not a Constancia de pago.
 * { payer, date: 'yyyy-MM-dd' | '', kind, totals: {PEN: n, USD: n} }
 */
function readPaymentNotice_(strings) {
  var folded = strings.map(paymentNoticeFold_);
  if (folded.indexOf('constancia de pago') < 0) return null;
  var iPayer = folded.indexOf('ordenante');
  if (iPayer < 0) return null;
  // Two layouts are possible: all labels first then all values (what Interbank's PDF does today), or label, value, label, value.
  var value = {};
  if (PAYMENT_NOTICE_LABELS_.indexOf(folded[iPayer + 1]) >= 0) {
    var labels = [], k = iPayer;
    while (k < folded.length && PAYMENT_NOTICE_LABELS_.indexOf(folded[k]) >= 0) labels.push(folded[k++]);
    labels.forEach(function (l, j) { value[l] = strings[k + j] || ''; });
  } else {
    PAYMENT_NOTICE_LABELS_.forEach(function (l) { var i = folded.indexOf(l, iPayer); if (i >= 0) value[l] = strings[i + 1] || ''; });
  }
  var payer = String(value.ordenante || '').trim();
  if (!payer || paymentNoticeAmount_(payer)) return null;
  var d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value.fecha || '').trim());
  var totals = {}, n = 0;
  strings.forEach(function (s) {
    var a = paymentNoticeAmount_(s);
    if (!a) return;
    totals[a.currency] = Math.round(((totals[a.currency] || 0) + a.amount) * 100) / 100;
    n++;
  });
  if (!n) return null;
  return { payer: payer, date: d ? d[3] + '-' + d[2] + '-' + d[1] : '', kind: String(value.tipo || '').trim(), totals: totals };
}

/** The account the money went into: the named one when it holds the currency, else the only Interbank account that does. */
function paymentNoticeAccount_(currency, paymentMethods, banks) {
  function holds(pm) {
    var list = String(pm.currencies || '').toUpperCase().split(/[\s,;|]+/).filter(String);
    if (list.length) return list.indexOf(currency) >= 0;
    var own = String(pm.opening_balance_currency || '').toUpperCase();
    return !own || own === currency;
  }
  var usable = paymentMethods.filter(function (pm) { return String(pm.hidden).toLowerCase() !== 'true' && pm.type !== 'credit'; });   // money comes IN: never a card
  var named = usable.filter(function (pm) { return plainNickname_(pm.nickname) === plainNickname_(PAYMENT_NOTICE_ACCOUNT_); })[0];
  if (named && holds(named)) return named;
  var bank = banks.filter(function (b) { return String(b.name) === 'Interbank'; })[0];
  if (!bank) return null;
  var ibk = usable.filter(function (pm) { return pm.bank_id === bank.id && holds(pm); });
  return ibk.length === 1 ? ibk[0] : null;
}

/** True for a PDF attachment that could be a Constancia de pago (not a self-sent statement, not huge). */
function paymentNoticeCandidate_(att) {
  var name = String(att.getName() || '');
  if (!/\.pdf$/i.test(name)) return false;
  if (STATEMENT_SELF_FILENAME_RULES_.some(function (r) { return r.pattern.test(name); })) return false;
  var kb = att.getSize() / 1024;
  return kb > 0 && kb <= PAYMENT_NOTICE_MAX_KB_;
}

/**
 * Part of the e-mail scan (processEmails): the bank's own notices and the person's mails to themself, read for
 * Constancia de pago PDFs. Same memory as the bank e-mails (Processed Emails), same duplicate check (external_id).
 */
function processPaymentNotices_(days, tracking, handled, results, existingExternalIds, banks, paymentMethods) {
  var tz = Session.getScriptTimeZone();
  var queries = ['from:' + PAYMENT_NOTICE_SENDER_ + ' newer_than:' + days + 'd',
    'from:me to:me has:attachment filename:pdf newer_than:' + days + 'd'];
  var seen = {};
  queries.forEach(function (query, qi) {
    gmailSearchMessages_(query, { max: 100 }).forEach(function (message) {
      var messageId = String(message.getId());
      if (seen[messageId] || (tracking && handled[messageId])) return;
      seen[messageId] = true;
      if (qi === 1 && !stmtSentToSelf_(message)) return;   // a stranger's reply inside one of his own threads
      try {
        processPaymentNoticeMessage_(message, tz, results, existingExternalIds, banks, paymentMethods);
        if (tracking) { recordProcessedEmail_(messageId); handled[messageId] = true; }
      } catch (err) {
        results.errors++;
        console.error('processPaymentNoticeMessage_: ' + err);
      }
    });
  });
}

function processPaymentNoticeMessage_(message, tz, results, existingExternalIds, banks, paymentMethods) {
  message.getAttachments({ includeInlineImages: false }).forEach(function (att) {
    if (!paymentNoticeCandidate_(att)) return;
    var notice = readPaymentNotice_(pdfTextStrings_(att.getBytes()));
    if (!notice) return;   // some other PDF he sent himself
    var name = String(att.getName()).replace(/\.pdf$/i, '');
    var dateStr = notice.date || Utilities.formatDate(message.getDate(), tz, 'yyyy-MM-dd');
    var createdAt = Utilities.formatDate(message.getDate(), tz, "yyyy-MM-dd'T'HH:mm:ss");
    var currencies = Object.keys(notice.totals);
    currencies.forEach(function (currency) {
      var ref = PAYMENT_NOTICE_FILE_.test(att.getName()) ? name : (notice.payer + '|' + dateStr + '|' + notice.totals[currency]);
      var externalId = 'ibk-pago:' + ref + (currencies.length > 1 ? ':' + currency : '');
      if (existingExternalIds[externalId]) { results.duplicates++; return; }
      existingExternalIds[externalId] = true;
      var account = paymentNoticeAccount_(currency, paymentMethods, banks);
      var entry = {
        id: Utilities.getUuid(), type: 'income', date: dateStr, amount: notice.totals[currency], currency: currency,
        category_id: '', description: notice.payer, payment_method_id: account ? account.id : '', paid_by: 'me',
        status: 'pending', source: 'email', external_id: externalId, import_batch_id: '', created_at: createdAt,
        merchant: normalizeMerchant_(notice.payer)
      };
      appendRowObject('Entries', entry);
      results.created++;
      results.paymentNotices = (results.paymentNotices || 0) + 1;
      try { noteBankMailSeen_('Interbank', dateStr); } catch (err) { console.error('noteBankMailSeen_: ' + err); }
      try { sendTelegramEntryNotification_(entry, null, null); } catch (err) { console.error('Telegram notification failed: ' + err); }
    });
  });
}
