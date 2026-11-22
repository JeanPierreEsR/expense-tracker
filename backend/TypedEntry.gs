/**
 * Typed transactions: ONE building block for WhatsApp and Telegram (owner, 2026-11-16: "both should work as similarly as
 * possible"). specs/review-telegram-email.md § Typed transactions.
 *
 * A message that starts with an amount is a new transaction ("25 almuerzo", "S/ 12.50 taxi", "USD 10 Netflix",
 * "ingreso 1500 sueldo"): amount and description need no comma; every other field goes after a comma with the reply keywords
 * of the Telegram engine ("25 almuerzo, account Interbank, category restaurants, date 2026-11-14"), applied by the same engine
 * (applyEditCommand_), so the same rules decide: everything applied and nothing missing -> confirmed; otherwise it waits and the
 * answer says why. A pasted bank or Yape notice is read with the e-mail rules instead (its commas are not keywords).
 *
 * Reading a message, in order:
 *   1. the bank e-mail rules (EmailParser.gs + the rule pack): a pasted notice is read exactly like the e-mail. A rule that
 *      matches on its sender alone (it matches an empty text) is never used: a message has no sender address.
 *   2. a typed line (typedReadLine_).
 * The entry lands as a WAITING entry (principle 6), source "whatsapp" or "telegram", until the keywords confirm it. A bank notice
 * keeps the bank's operation number as its id, so the bank's own e-mail for the same payment is not saved a second time.
 */

// True when this text is a new transaction (an amount first, or a bank notice), not an edit or a word for the last message.
function typedIsNewEntry_(text) {
  return !!typedReadLine_(text, homeCurrency_()) || !!typedReadByRules_(text);
}

// The building block: save the transaction, then apply the comma keywords through the engine. Returns saveTypedEntry_'s answer
// plus `editMessage` (the engine's note: what could not be applied, why it is not confirmed; '' when all is well). The caller
// clears telegramTagAskAfter_ before and reads it after (a confirmed entry may ask about its tags).
function newTypedEntry_(payload, source) {
  var text = String(payload.text || '');
  var parts = !text.trim() || typedReadByRules_(text) ? [text] : splitEditCommands_(text);
  var first = payload;
  if (parts.length > 1) {
    first = {};
    Object.keys(payload).forEach(function (k) { first[k] = payload[k]; });
    first.text = parts[0];
  }
  var r = saveTypedEntry_(first, source);
  r.editMessage = r.coNote || '';   // a company copy's notes under the card (CompanyBot.gs)
  if (!r.saved || !r.entry || parts.length < 2) return r;
  var res = applyEditCommand_(r.entry.id, parts.slice(1).join(', '));
  r.entry = getEntryById_(r.entry.id) || r.entry;
  if (res.categoryName) r.categoryName = res.categoryName;
  r.editMessage = [r.coNote || '', res.message || ''].filter(function (m) { return m; }).join('\n\n');
  if (r.entry.status === 'confirmed') r.reply = tr_('whatsapp.savedConfirmed', { amount: formatAmountText_(r.entry.amount, r.entry.currency), what: r.entry.description });
  if (r.editMessage) r.reply += '\n\n' + r.editMessage;
  return r;
}

// ---- reading ----

// Pure-ish: { rule, fields } from the bank rules, or null.
function typedReadByRules_(text) {
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

var TYPED_INCOME_WORDS_ = /^(?:ingreso|income|cobr[eé]|cobro|recib[ií]|\+)\s*/i;
var TYPED_CURRENCY_WORDS_ = { soles: 'PEN', sol: 'PEN', 'dólares': 'USD', dolares: 'USD', 'dólar': 'USD', dolar: 'USD', euros: 'EUR', euro: 'EUR' };

// Pure: a typed line → { type, amount, currency, description } or null. home = the main currency.
function typedReadLine_(text, home) {
  var s = String(text || '').replace(/\s+/g, ' ').trim();
  // A date on its own ("31/02/2026", "15-11", "2026-11-15") is not a purchase of 31 (found 2026-11-16). "15.50" stays an amount.
  if (/^\d{1,4}[\/-]\d{1,2}(?:[\/.-]\d{2,4})?$|^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(s)) return null;
  var type = 'expense';
  var inc = TYPED_INCOME_WORDS_.exec(s);
  if (inc) { type = 'income'; s = s.slice(inc[0].length); }
  var num = /\d[\d.,]*/.exec(s);
  if (!num) return null;
  // Description first ("almuerzo con Lucia, Mia 40", "taxi a Miraflores 2 personas 15", "menu 2x1 pizza S/ 35"; owner,
  // 2026-11-16): the amount is the LAST number standing on its own (a sign before it is fine; "2x1" is not one). When the
  // message starts with the amount (or a sign / code and the amount: "S/ 12.50 taxi", "USD 10 Netflix"), that first number is it.
  if (!/^(?:(?:S\/\.?|US\$|\$|€|£|[A-Za-z]{3})\s*)?\d/.test(s)) {
    var re = /(^|\s)((?:S\/\.?|US\$|\$|€|£)\s?)?(\d[\d.,]*)(?=\s|$)/g, m, last = null;
    while ((m = re.exec(s))) {
      var at = m.index + m[1].length + (m[2] ? m[2].length : 0);
      last = { index: at, 0: m[3] };
    }
    if (last) num = last;
  }
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
      if (TYPED_CURRENCY_WORDS_[w]) currency = TYPED_CURRENCY_WORDS_[w];
      else if (code.length === 3 && KNOWN_CURRENCY_CODES_.indexOf(code) >= 0) currency = code;
      if (currency) after = after.slice(post[0].length);
    }
  }
  var description = (before + ' ' + after).replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
  if (description) description = description.charAt(0).toUpperCase() + description.slice(1);
  return { type: type, amount: Math.round(amount * 100) / 100, currency: currency || home, description: description.slice(0, 120) };
}

// ---- saving ----

// payload: { id (the message's own id: a repeat of it is saved once), text, timestamp (seconds) }; source: 'whatsapp' | 'telegram'.
// Returns { saved, repeat, reply, entry, categoryName }: `reply` is a short answer for a channel that sends one line back.
function saveTypedEntry_(payload, source) {
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
  var read = typedReadByRules_(text);
  // A company copy reads a line in parts, in any order: unit, amount, concept, client (CompanyBot.gs, Business 2 piece 5).
  var co = !read && isCompanyCopy_() ? companyReadLine_(text, companyBotContext_()) : null;
  if (co && co.ask) return { saved: false, reply: tr_('coBot.whichAmount', { list: co.ask.join(tr_('coBot.or')) }) };
  var fields = read ? read.fields : (co || typedReadLine_(text, home));
  if (!fields) return { saved: false, reply: tr_('whatsapp.unreadable') };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var entries = getAllRows('Entries');
    var msgExternalId = source + '-' + sha256Hex_(msgId || text + '|' + createdAt.slice(0, 16)).slice(0, 20);
    var externalId = (read && fields.externalId) ? String(fields.externalId) : msgExternalId;
    var already = entries.find(function (e) { return e.external_id === externalId || e.external_id === msgExternalId; });
    if (already) return { saved: false, repeat: true, reply: tr_('whatsapp.repeat') };

    var paymentMethods = withoutPracticeAccounts_(getAllRows('Payment Methods'));
    var paymentMethod = read ? emailAccountFor_(read.rule, fields, getAllRows('Banks'), paymentMethods) : null;
    var guessCtx = buildGuessContext_();
    var type = fields.type || 'expense';
    var description = fields.description || tr_(source === 'telegram' ? 'typed.noDesc.telegram' : 'whatsapp.noDesc');
    // The same guess a bank e-mail gets. A category the person names goes after a comma with its keyword ("25 almuerzo, category
    // restaurants", WhatsAppBot.gs; owner 2026-11-16): a word inside the description is never read as one.
    var guess = co && co.category ? { categoryId: co.category.id } : guessCategoryForEmail_({ type: type, amount: fields.amount, currency: fields.currency, merchant: fields.merchant || fields.description,
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
      source: source,
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
    if (!fields.defaultCategory) {
      var payeeGuess = applyPayeeGuessToNewEntry_(entry, buildPayeeHistory_(), payeeLookups_());
      if (payeeGuess) ensureEntriesToPaymentMethodColumn_();
    }
    // The client of a company's income (a new one is made, with the client role): the payer of the income.
    var clientName = co && co.type === 'income' ? (co.client ? co.client.name : co.clientNew) : '';
    if (clientName) {
      if (co.clientNew) addFriend({ name: clientName, role: 'client' });
      entry.paid_by = findOrCreatePayorByName_(clientName).id;
    }
    appendRowObject('Entries', entry);
    if (co && co.unit) appendRowObject('Entry Tags', { entry_id: entry.id, tag_id: co.unit.id });   // the unit is a tag
    autoTagTravelEntry_(entry);

    var cat = entry.category_id ? guessCtx.categoriesById[entry.category_id] : null;
    if (!cat && entry.category_id) cat = getAllRows('Categories').find(function (c) { return c.id === entry.category_id; }) || null;
    return {
      saved: true,
      entryId: entry.id,
      entry: entry,
      coNote: co ? companyNotes_(co, false) : '',
      categoryName: cat ? categoryLabel_(cat) : null,
      reply: co ? companyUnderstood_(co) + '\n' + tr_('coBot.waits') : tr_('whatsapp.saved', {
        amount: formatAmountText_(entry.amount, entry.currency),
        what: entry.description + (cat ? ' · ' + categoryLabel_(cat) : '')
      })
    };
  } finally {
    lock.releaseLock();
  }
}
