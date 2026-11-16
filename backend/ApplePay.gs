/**
 * Apple Pay capture (owner's plan, 2026-11-15; "Apple Pay shortcut - plan" in the private folder).
 *
 * The iPhone's Shortcuts app can run a shortcut by itself after every Apple Pay payment (Automation → Transaction). Ours sends what
 * iOS gives it — the amount as the phone writes it ("S/ 12.50", "US$ 4.99", "100 €"), the merchant and the Wallet card's name — to
 * this copy's web address with the person's own Apple Pay key in the link (?k=…). The payment lands in Needs review as a WAITING
 * entry (principle 6), source "shortcut".
 *
 *   - The key opens this one door only: it can add a waiting entry, nothing else (Api.gs routes it before any sign-in check).
 *   - Account: learned from the card's name. The first time a card is seen the entry has no account; once the person gives one
 *     (on Needs review, or a bank e-mail joins it), the next payment with that card gets it (`wallet_card` column).
 *   - Currency (owner's rule, 2026-11-15): a code or unambiguous sign wins; a bare "$" is the card's own currency when it has only
 *     one, else the main currency when that is a "$" currency, else US dollars; anything else waits with "check the currency".
 *   - The same purchase also brings a bank e-mail: whichever arrives second JOINS the first (same amount and currency, the account
 *     not in conflict, at most APPLE_PAY_JOIN_HOURS_ apart, the closest wins). The Apple Pay side brings the shop's name, the e-mail
 *     the account. `applepay` column: "wait" until joined, then "joined|<id of the other side>".
 *
 * Owner's copy first (owner, 2026-11-15): friends' copies get it when APPLE_PAY_OPEN_TO_FRIENDS_ becomes true.
 */
var APPLE_PAY_OPEN_TO_FRIENDS_ = false;
var APPLE_PAY_JOIN_HOURS_ = 24;
var APPLE_PAY_COLUMN_ = 'applepay';
var APPLE_PAY_CARD_COLUMN_ = 'wallet_card';

// The owner's copy is known by its own web address (the same one docs/app.js names as OWNER_API_URL), not only by having no
// FEATURES: the owner's copy carries a FEATURES list too (found on the first ship, 2026-11-16: the tab never showed on his phone).
var OWNER_WEB_APP_ID_ = 'AKfycbxqUmzc0xqrgeF3lpy3nSsCnAhlJSrHJxNOWn-WBPGSEa-6qKeTZb8mvF_veh5MdX1H6g';

function isOwnerCopyByAddress_() {
  return getWebAppUrl_().indexOf('/s/' + OWNER_WEB_APP_ID_ + '/') !== -1;
}

function applePayOffered_() {
  return APPLE_PAY_OPEN_TO_FRIENDS_ || !isFriendCopy_() || isOwnerCopyByAddress_();
}

// ---- the key ----

function applePayKey_() {
  return String(PropertiesService.getScriptProperties().getProperty('APPLE_PAY_KEY') || '');
}

function newApplePayKey_() {
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  PropertiesService.getScriptProperties().setProperty('APPLE_PAY_KEY', key);
  return key;
}

// More → Apple Pay capture. The key is this copy's own (a signed-in phone may see it again any time, to copy the link once more).
function getApplePaySetup() {
  if (!applePayOffered_()) throw codedError_('feature_off', tr_('applepay.off'));
  var props = PropertiesService.getScriptProperties();
  return {
    key: applePayKey_(),
    lastAt: String(props.getProperty('APPLE_PAY_LAST_AT') || ''),
    count: Number(props.getProperty('APPLE_PAY_COUNT') || 0)
  };
}

// Makes the key the first time, or replaces it (`replace: true`): the old link stops working at once.
function makeApplePayKey(payload) {
  if (!applePayOffered_()) throw codedError_('feature_off', tr_('applepay.off'));
  if (applePayKey_() && !(payload && payload.replace)) return getApplePaySetup();
  newApplePayKey_();
  return getApplePaySetup();
}

function isApplePayKey_(key) {
  var stored = applePayKey_();
  return !!stored && String(key || '') === stored && applePayOffered_();
}

// ---- reading the amount ----

// Signs that name one currency whatever the phone's region. Longest first (so "US$" is never read as "$").
var APPLE_PAY_SIGNS_ = [
  ['S/.', 'PEN'], ['S/', 'PEN'], ['US$', 'USD'], ['U$S', 'USD'], ['USD$', 'USD'], ['MX$', 'MXN'], ['CA$', 'CAD'], ['AU$', 'AUD'],
  ['A$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['R$', 'BRL'], ['RD$', 'DOP'], ['COL$', 'COP'], ['CLP$', 'CLP'], ['$U', 'UYU'],
  ['Bs.', 'BOB'], ['Bs', 'BOB'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₩', 'KRW'], ['₹', 'INR'], ['₡', 'CRC'], ['₲', 'PYG'],
  ['₺', 'TRY'], ['₪', 'ILS'], ['฿', 'THB'], ['₱', 'PHP'], ['₫', 'VND'], ['zł', 'PLN'], ['Fr.', 'CHF'], ['Q', 'GTQ']
];
// Currencies a bare "$" stands for in their own country.
var APPLE_PAY_DOLLAR_CURRENCIES_ = ['USD', 'MXN', 'CLP', 'COP', 'ARS', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'UYU', 'DOP', 'CUP', 'TWD', 'BSD', 'BZD', 'BMD', 'BBD', 'FJD', 'JMD', 'TTD', 'GYD', 'SRD', 'LRD', 'NAD', 'KYD', 'XCD'];

// Pure: the number in "S/ 1,234.50", "1.234,50 €", "4,99". A lone separator followed by 1-2 digits is the decimal point;
// followed by 3 digits it groups thousands. NaN when there is no number.
function applePayNumber_(text) {
  var m = String(text || '').match(/\d[\d.,'   ]*/);
  if (!m) return NaN;
  var s = m[0].replace(/['   ]/g, '').replace(/[.,]+$/, '');
  var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  var dec = '';
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
  else if (lastDot >= 0 || lastComma >= 0) {
    var sep = lastDot >= 0 ? '.' : ',';
    var parts = s.split(sep);
    if (parts.length === 2 && parts[1].length <= 2) dec = sep;
  }
  var clean = dec ? s.split(dec).map(function (p, i, all) { return i === all.length - 1 ? p : p.replace(/[.,]/g, ''); }).join('.') : s.replace(/[.,]/g, '');
  var n = Number(clean);
  return isNaN(n) ? NaN : Math.round(n * 100) / 100;
}

// Pure: { currency, sure } from the amount's text. accountCurrencies = the card's own currencies ([] = not known); home = main currency.
function applePayCurrency_(text, accountCurrencies, home) {
  var s = String(text || '').replace(/\d[\d.,'   ]*/g, ' ').replace(/[-+]/g, ' ').trim();
  var code = s.toUpperCase().match(/\b[A-Z]{3}\b/);
  if (code && KNOWN_CURRENCY_CODES_.indexOf(code[0]) >= 0) return { currency: code[0], sure: true };
  for (var i = 0; i < APPLE_PAY_SIGNS_.length; i++) {
    var sign = APPLE_PAY_SIGNS_[i][0];
    // A one-letter sign ("Q") must stand alone, not be part of a word.
    var hit = sign.length === 1 && /[A-Za-z]/.test(sign) ? new RegExp('(^|\\s)' + sign + '(\\s|$)').test(s) : s.indexOf(sign) >= 0;
    if (hit) return { currency: APPLE_PAY_SIGNS_[i][1], sure: true };
  }
  var own = accountCurrencies || [];
  if (/^\$$/.test(s.replace(/\s+/g, ''))) {
    if (own.length === 1) return { currency: own[0], sure: true };
    if (APPLE_PAY_DOLLAR_CURRENCIES_.indexOf(home) >= 0) return { currency: home, sure: true };
    return { currency: 'USD', sure: true };
  }
  // No sign at all, or one we do not know: the card's only currency, else the main currency, and the person checks it.
  return { currency: own.length === 1 ? own[0] : home, sure: false };
}

// The currencies an account has, as the app reads them (accountCurrencyList_ in app.js): its own list, else what its kind names.
function applePayAccountCurrencies_(pm) {
  if (!pm || (pm.type !== 'debit' && pm.type !== 'credit')) return [];
  var own = String(pm.currencies || '');
  if (own === 'none') return [];
  if (own) return own.split(',');
  if (pm.alias_kind === 'credit') return ['PEN', 'USD'];
  if (pm.alias_kind === 'sueldo') return ['PEN'];
  var m = /^(?:debit|sueldo|credit)_([a-z]{3})$/.exec(pm.alias_kind || '');
  return m ? [m[1].toUpperCase()] : [];
}

function applePayCardKey_(card) {
  return String(card || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The account for a Wallet card: the one this card's last payment ended up with, else the one whose last four digits the name
// carries. Null when not known yet.
function applePayAccountFor_(card, entries, paymentMethods) {
  var key = applePayCardKey_(card);
  if (!key) return null;
  var byId = {};
  paymentMethods.forEach(function (pm) { byId[pm.id] = pm; });
  var best = null;
  entries.forEach(function (e) {
    if (applePayCardKey_(e[APPLE_PAY_CARD_COLUMN_]) !== key || !e.payment_method_id || !byId[e.payment_method_id]) return;
    if (e.status !== 'pending' && e.status !== 'confirmed') return;
    if (!best || String(e.created_at) > String(best.created_at)) best = e;
  });
  if (best) return byId[best.payment_method_id];
  var digits = key.match(/\b\d{4}\b/g) || [];
  for (var i = digits.length - 1; i >= 0; i--) {
    var hits = paymentMethods.filter(function (pm) { return pmLast4_(pm.last_4) === digits[i]; });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

function applePayTime_(v) {
  if (v instanceof Date) return v.getTime();
  var t = new Date(String(v || '').replace(' ', 'T')).getTime();
  return isNaN(t) ? null : t;
}

function ensureApplePayColumns_() {
  ensureEntriesMerchantColumn_();
  ensureEntriesToPaymentMethodColumn_();
  ensureColumn_('Entries', APPLE_PAY_COLUMN_);
  ensureColumn_('Entries', APPLE_PAY_CARD_COLUMN_);
}

// A bank e-mail entry this Apple Pay payment repeats (it came first), or null.
function findApplePayEmailTwin_(entries, amount, currency, at, pm) {
  var best = null, bestGap = null;
  entries.forEach(function (e) {
    if (e.source !== 'email' || e.type !== 'expense' || String(e[APPLE_PAY_COLUMN_] || '')) return;
    if (e.status !== 'pending' && e.status !== 'confirmed') return;
    if (e.currency !== currency || Math.abs(Number(e.amount)).toFixed(2) !== amount.toFixed(2)) return;
    if (pm && e.payment_method_id && String(e.payment_method_id) !== String(pm.id)) return;
    var t = applePayTime_(e.created_at);
    if (t === null) return;
    var gap = Math.abs(t - at);
    if (gap > APPLE_PAY_JOIN_HOURS_ * 3600000) return;
    if (bestGap === null || gap < bestGap) { best = e; bestGap = gap; }
  });
  return best;
}

// Called by the e-mail scan (EmailParser.gs) before it makes an entry: the Apple Pay entry this bank e-mail repeats, or null.
function findApplePayTwin_(fields, createdAt, paymentMethod) {
  if (!fields || fields.type !== 'expense' || fields.exchangeLeg) return null;
  var at = applePayTime_(createdAt);
  if (at === null) return null;
  var amount = Math.abs(Number(fields.amount)).toFixed(2);
  var best = null, bestGap = null;
  getAllRows('Entries').forEach(function (e) {
    if (e.source !== 'shortcut' || String(e[APPLE_PAY_COLUMN_] || '') !== 'wait') return;
    if (e.status !== 'pending' && e.status !== 'confirmed') return;
    if (e.currency !== fields.currency || Math.abs(Number(e.amount)).toFixed(2) !== amount) return;
    if (paymentMethod && e.payment_method_id && String(e.payment_method_id) !== String(paymentMethod.id)) return;
    var t = applePayTime_(e.created_at);
    if (t === null) return;
    var gap = Math.abs(t - at);
    if (gap > APPLE_PAY_JOIN_HOURS_ * 3600000) return;
    if (bestGap === null || gap < bestGap) { best = e; bestGap = gap; }
  });
  return best;
}

// The bank e-mail came second: it only tells which account paid (the Apple Pay side keeps its shop name, date and category).
function joinApplePayTwin_(twin, externalId, paymentMethod) {
  var change = {};
  change[APPLE_PAY_COLUMN_] = 'joined|' + externalId;
  if (paymentMethod && !twin.payment_method_id) change.payment_method_id = paymentMethod.id;
  updateRowFields_('Entries', twin.id, change);
}

// The e-mail id inside a joined Apple Pay entry, so the scan counts that e-mail as already read.
function applePayJoinedId_(value) {
  var parts = String(value || '').split('|');
  return parts[0] === 'joined' && parts[1] ? parts.slice(1).join('|') : '';
}

// ---- the door ----

// payload: { amount (text as iOS writes it, or a number), merchant, card, time (optional, any date text) }
// Returns { saved, repeat, message } — `message` is what the shortcut shows on the phone.
function captureApplePay_(payload) {
  payload = payload || {};
  var raw = String(payload.amount === undefined || payload.amount === null ? '' : payload.amount).trim().slice(0, 60);
  var merchant = String(payload.merchant || '').trim().slice(0, 120);
  var card = String(payload.card || '').trim().slice(0, 80);
  var whenMs = applePayTime_(payload.time);
  var now = Date.now();
  if (whenMs === null || Math.abs(whenMs - now) > 2 * 86400000) whenMs = now;   // a time we cannot read, or far off: now
  var when = new Date(whenMs);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var dateStr = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
  var createdAt = Utilities.formatDate(when, tz, "yyyy-MM-dd'T'HH:mm:ss");

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureApplePayColumns_();
    var entries = getAllRows('Entries');
    // iOS may send the same payment twice (a slow answer): same card, amount text and shop within the same minute = the same payment.
    var externalId = 'applepay-' + sha256Hex_([applePayCardKey_(card), raw, merchant.toLowerCase(), createdAt.slice(0, 16)].join('|')).slice(0, 20);
    var already = entries.find(function (e) {
      return e.external_id === externalId || applePayJoinedId_(e[APPLE_PAY_COLUMN_]) === externalId;
    });
    if (already) return { saved: false, repeat: true, message: tr_('applepay.repeat') };

    var paymentMethods = withoutPracticeAccounts_(getAllRows('Payment Methods'));
    var pm = applePayAccountFor_(card, entries, paymentMethods);
    var number = applePayNumber_(raw);
    var cur = applePayCurrency_(raw, applePayAccountCurrencies_(pm), homeCurrency_());
    var amount = isNaN(number) ? 0 : Math.abs(number);
    var unsure = !cur.sure || !(amount > 0);
    var shop = merchant || tr_('applepay.noShop');
    var description = unsure ? tr_('applepay.check', { shop: shop, raw: raw || '?' }) : shop;

    var props = PropertiesService.getScriptProperties();
    props.setProperty('APPLE_PAY_LAST_AT', new Date(now).toISOString());
    props.setProperty('APPLE_PAY_COUNT', String(Number(props.getProperty('APPLE_PAY_COUNT') || 0) + 1));

    var guessCtx = buildGuessContext_();
    var guess = guessCategoryForEmail_({ type: 'expense', amount: amount, currency: cur.currency, merchant: merchant }, dateStr, guessCtx);

    // The bank's e-mail came first: join it instead of making a second entry.
    var twin = (!unsure) ? findApplePayEmailTwin_(entries, amount, cur.currency, whenMs, pm) : null;
    if (twin) {
      var change = {};
      change[APPLE_PAY_COLUMN_] = 'joined|' + externalId;
      if (!String(twin[APPLE_PAY_CARD_COLUMN_] || '') && card) change[APPLE_PAY_CARD_COLUMN_] = card;   // learns which account this card is
      if (twin.status === 'pending') {
        if (merchant) { change.description = merchant; change.merchant = normalizeMerchant_(merchant) || twin.merchant || ''; }
        if (!twin.category_id && guess.categoryId) change.category_id = guess.categoryId;
      }
      if (!twin.payment_method_id && pm) change.payment_method_id = pm.id;
      updateRowFields_('Entries', twin.id, change);
      return { saved: true, joined: true, message: tr_('applepay.saved', { amount: formatAmountText_(amount, cur.currency), shop: shop }) };
    }

    var entry = {
      id: Utilities.getUuid(),
      type: 'expense',
      date: dateStr,
      amount: amount,
      currency: cur.currency,
      category_id: guess.categoryId,
      description: description,
      payment_method_id: pm ? pm.id : '',
      paid_by: 'me',
      status: 'pending',
      source: 'shortcut',
      external_id: externalId,
      import_batch_id: '',
      created_at: createdAt,
      merchant: normalizeMerchant_(merchant)
    };
    entry[APPLE_PAY_COLUMN_] = 'wait';
    entry[APPLE_PAY_CARD_COLUMN_] = card;
    var payeeGuess = applyPayeeGuessToNewEntry_(entry, buildPayeeHistory_(), payeeLookups_());
    if (payeeGuess) guess = { categoryId: entry.type === 'investment' ? '' : entry.category_id, reason: payeeGuess.reason, quiet: payeeGuess.quiet };
    appendRowObject('Entries', entry);
    autoTagTravelEntry_(entry);
    var guessed = guess.categoryId ? guessCtx.categoriesById[guess.categoryId] : null;
    try { sendTelegramEntryNotification_(entry, guessed ? categoryLabel_(guessed) : null, telegramAutoReason_(guess)); }
    catch (err) { console.error('Telegram notification failed: ' + err); }
    return { saved: true, message: tr_(unsure ? 'applepay.savedCheck' : 'applepay.saved', { amount: formatAmountText_(amount, cur.currency), shop: shop }) };
  } finally {
    lock.releaseLock();
  }
}

// "PEN 12.50" — plain, for the shortcut's notification.
function formatAmountText_(amount, currency) {
  return currency + ' ' + Number(amount || 0).toFixed(2);
}
