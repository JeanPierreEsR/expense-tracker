/**
 * WhatsApp capture (owner's request, 2026-11-16; specs/review-telegram-email.md § WhatsApp capture).
 *
 * The person writes to the app's WhatsApp Business number (Meta's free Cloud API). Meta calls a webhook; the Cloudflare Worker
 * `cloudflare-worker/whatsapp-relay.js` answers Meta's verification check, checks Meta's signature and that the message comes
 * from the person's own number, then forwards the text here with a shared secret (the web app's address is public and Apps Script
 * cannot read headers, so the secret travels in the body, the same way as the Telegram relay). The Worker sends our answer back
 * on WhatsApp.
 *
 * Reading a message, in order:
 *   1. the bank e-mail rules (EmailParser.gs + the rule pack), so a bank or Yape notice pasted or forwarded into WhatsApp is read
 *      exactly like the e-mail. A rule that matches on its sender alone (it matches an empty text) is never used: a WhatsApp
 *      message has no sender address, and such a rule would read any text.
 *   2. a typed line: "25 almuerzo", "S/ 12.50 taxi", "USD 10 Netflix", "ingreso 1500 sueldo".
 * The entry lands as a WAITING entry in Needs review (principle 6), source "whatsapp". A bank notice keeps the bank's operation
 * number as its id, so the bank's own e-mail for the same payment is not saved a second time.
 */
var WHATSAPP_SECRET_PROP_ = 'WHATSAPP_RELAY_SECRET';

function isWhatsAppRelayAuthorized_(body) {
  var stored = String(PropertiesService.getScriptProperties().getProperty(WHATSAPP_SECRET_PROP_) || '');
  // Not set up = closed (unlike Telegram's older door, which stayed open until protected).
  return stored.length >= 24 && String((body && body.relay_secret) || '') === stored;
}

// Sheet menu: paste the relay key (the same value as WA_RELAY_SECRET in Cloudflare and in the private secrets file).
function promptSetWhatsAppRelaySecret() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt('WhatsApp relay key',
    'Paste the WA_RELAY_SECRET value (the same one you put in Cloudflare). Leave empty and press OK to switch WhatsApp capture off.',
    ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() !== ui.Button.OK) return;
  var key = result.getResponseText().trim();
  var props = PropertiesService.getScriptProperties();
  if (!key) { props.deleteProperty(WHATSAPP_SECRET_PROP_); ui.alert('WhatsApp capture is OFF.'); return; }
  if (key.length < 24) { ui.alert('That key is too short (at least 24 characters). Nothing was changed.'); return; }
  props.setProperty(WHATSAPP_SECRET_PROP_, key);
  ui.alert('Saved. WhatsApp messages from your number will now land in Needs review.');
}

// ---- reading ----

// Pure-ish: { rule, fields } from the bank rules, or null.
function whatsappReadByRules_(text) {
  var rules = emailRules_();
  for (var i = 0; i < rules.length; i++) {
    var r = rules[i];
    if (r.skip || r.exchange || r.amazonShipment) continue;
    var senderOnly = false;
    try { senderOnly = !!r.match('', ''); } catch (err) { senderOnly = false; }
    if (senderOnly) continue;
    try {
      if (!r.match(text, text)) continue;
      var fields = r.extract(text, text);
      if (fields && Number(fields.amount) > 0) return { rule: r, fields: fields };
    } catch (err) { /* a rule that cannot read this text: try the next */ }
  }
  return null;
}

var WHATSAPP_INCOME_WORDS_ = /^(?:ingreso|income|cobr[eé]|cobro|recib[ií]|\+)\s*/i;
var WHATSAPP_CURRENCY_WORDS_ = { soles: 'PEN', sol: 'PEN', 'dólares': 'USD', dolares: 'USD', 'dólar': 'USD', dolar: 'USD', euros: 'EUR', euro: 'EUR' };

// Pure: a typed line → { type, amount, currency, description } or null. home = the main currency.
function whatsappReadTyped_(text, home) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  var type = 'expense';
  var inc = WHATSAPP_INCOME_WORDS_.exec(s);
  if (inc) { type = 'income'; s = s.slice(inc[0].length); }
  var num = /\d[\d.,]*/.exec(s);
  if (!num) return null;
  var token = num[0].replace(/[.,]+$/, '');
  var amount = parseTypedAmount_(token);
  if (!(amount > 0)) return null;
  var before = s.slice(0, num.index), after = s.slice(num.index + num[0].length);
  var currency = '';
  // A sign or code right before the number ("S/ 25", "US$10", "USD 10")…
  var pre = /(S\/\.?|US\$|\$|€|£|\b[A-Za-z]{3})\s*$/.exec(before);
  if (pre) {
    var c = applePayCurrency_(pre[1] + ' 1', [], home);
    if (c.sure) { currency = c.currency; before = before.slice(0, pre.index); }
  }
  // …or a code or word right after it ("25 soles", "10 usd").
  if (!currency) {
    var post = /^\s*([A-Za-zÀ-ÿ]{3,7})\b/.exec(after);
    if (post) {
      var w = post[1].toLowerCase();
      var code = post[1].toUpperCase();
      if (WHATSAPP_CURRENCY_WORDS_[w]) currency = WHATSAPP_CURRENCY_WORDS_[w];
      else if (code.length === 3 && KNOWN_CURRENCY_CODES_.indexOf(code) >= 0) currency = code;
      if (currency) after = after.slice(post[0].length);
    }
  }
  var description = (before + ' ' + after).replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  if (description) description = description.charAt(0).toUpperCase() + description.slice(1);
  return { type: type, amount: Math.round(amount * 100) / 100, currency: currency || home, description: description.slice(0, 120) };
}

// ---- the door ----

// payload: { id (Meta's message id), from, text, timestamp (seconds) }. Returns { saved, repeat, reply }.
function captureWhatsApp_(payload) {
  payload = payload || {};
  var text = String(payload.text || '').slice(0, 4000);
  var msgId = String(payload.id || '').slice(0, 200);
  if (!text.trim()) return { saved: false, reply: tr_('whatsapp.onlyText') };

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var whenMs = Number(payload.timestamp) * 1000;
  if (!(whenMs > 0) || Math.abs(whenMs - Date.now()) > 2 * 86400000) whenMs = Date.now();
  var when = new Date(whenMs);
  var dateStr = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
  var createdAt = Utilities.formatDate(when, tz, "yyyy-MM-dd'T'HH:mm:ss");

  var home = homeCurrency_();
  var read = whatsappReadByRules_(text);
  var fields = read ? read.fields : whatsappReadTyped_(text, home);
  if (!fields) return { saved: false, reply: tr_('whatsapp.unreadable') };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var entries = getAllRows('Entries');
    var msgExternalId = 'whatsapp-' + sha256Hex_(msgId || text + '|' + createdAt.slice(0, 16)).slice(0, 20);
    var externalId = (read && fields.externalId) ? String(fields.externalId) : msgExternalId;
    var already = entries.find(function (e) { return e.external_id === externalId || e.external_id === msgExternalId; });
    if (already) return { saved: false, repeat: true, reply: tr_('whatsapp.repeat') };

    var paymentMethods = withoutPracticeAccounts_(getAllRows('Payment Methods'));
    var paymentMethod = read ? emailAccountFor_(read.rule, fields, getAllRows('Banks'), paymentMethods) : null;
    var guessCtx = buildGuessContext_();
    var type = fields.type || 'expense';
    var description = fields.description || tr_('whatsapp.noDesc');
    // A typed category name ("25 taxi transport") wins; otherwise the same guess a bank e-mail gets.
    var named = (!read && (type === 'expense' || type === 'income') && fields.description) ? fuzzyFindCategory_(fields.description, type) : null;
    var guess = named ? { categoryId: named.id, reason: '' }
      : guessCategoryForEmail_({ type: type, amount: fields.amount, currency: fields.currency, merchant: fields.merchant || fields.description,
        defaultCategory: fields.defaultCategory, defaultCategoryAlt: fields.defaultCategoryAlt }, dateStr, guessCtx);

    var entry = {
      id: Utilities.getUuid(),
      type: type,
      date: dateStr,
      amount: fields.amount,
      currency: fields.currency,
      category_id: guess.categoryId || '',
      description: description,
      payment_method_id: paymentMethod ? paymentMethod.id : '',
      paid_by: 'me',
      status: 'pending',
      source: 'whatsapp',
      external_id: externalId,
      import_batch_id: '',
      created_at: createdAt,
      merchant: normalizeMerchant_(fields.merchant) || normalizeMerchant_(fields.description)
    };
    ensureEntriesMerchantColumn_();
    if (read && read.rule.cardIsDestination && paymentMethod) {
      ensureEntriesToPaymentMethodColumn_();
      entry.to_payment_method_id = paymentMethod.id;
      entry.payment_method_id = '';
    }
    if (!named && !fields.defaultCategory) {
      var payeeGuess = applyPayeeGuessToNewEntry_(entry, buildPayeeHistory_(), payeeLookups_());
      if (payeeGuess) ensureEntriesToPaymentMethodColumn_();
    }
    appendRowObject('Entries', entry);
    autoTagTravelEntry_(entry);

    var cat = entry.category_id ? guessCtx.categoriesById[entry.category_id] : null;
    if (!cat && entry.category_id) cat = getAllRows('Categories').find(function (c) { return c.id === entry.category_id; }) || null;
    return {
      saved: true,
      entryId: entry.id,
      reply: tr_('whatsapp.saved', {
        amount: formatAmountText_(entry.amount, entry.currency),
        what: entry.description + (cat ? ' · ' + categoryLabel_(cat) : '')
      })
    };
  } finally {
    lock.releaseLock();
  }
}
