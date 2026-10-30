/**
 * Currency exchange, both ways (soles -> dollars, dollars -> soles, any pair).
 *
 * An exchange is TWO one-sided transfers, one per currency (specs/accounts.md § Currency exchange): the money that left is a
 * transfer From its account with To empty; the money that arrived is a transfer To its account with From empty. Neither is
 * spending or income. This file adds (1) one action that saves both legs together, so a half-saved exchange cannot exist,
 * and can turn a pending review card (an e-mail that landed as an expense) into one leg in place, and (2) recognition of
 * exchange houses so their e-mails stop landing as plain expenses.
 *
 * Exchange houses are never typed in: the names come from a short built-in list plus every "Currency exchange (<name>)"
 * entry already in the sheet (written here, by hand, or by an earlier import), compared as sets of words.
 */

var EXCHANGE_HOUSE_SEEDS_ = ['Rextie', 'Kambista', 'Tkambio'];
var EXCHANGE_HOUSES_MEMO_ = null;   // word lists; rebuilt for every e-mail run and every exchange saved

function exchangeHouseWordLists_() {
  if (EXCHANGE_HOUSES_MEMO_) return EXCHANGE_HOUSES_MEMO_;
  var names = EXCHANGE_HOUSE_SEEDS_.slice();
  var seen = {};
  getAllRows('Entries').forEach(function (e) {
    if (e.type !== 'transfer') return;
    var m = String(e.description || '').match(/^(?:Currency exchange|Cambio de moneda) \((.+)\)\s*$/i);
    if (m && !seen[m[1].toLowerCase()]) { seen[m[1].toLowerCase()] = true; names.push(m[1]); }
  });
  EXCHANGE_HOUSES_MEMO_ = names.map(ownerNameTokens_).filter(function (t) { return t.length >= 1 && t.join('').length >= 5; });
  return EXCHANGE_HOUSES_MEMO_;
}

// Does this recipient text name a known exchange house? Every word of the house must
// be in the text: "Cambios Zeta Norte S." names "Cambios Zeta Norte"; "Ana Torres" names nothing.
function exchangeHouseIn_(text) {
  var t = ownerNameTokens_(text);
  if (!t.length) return false;
  return exchangeHouseWordLists_().some(function (words) {
    return words.every(function (w) { return t.indexOf(w) !== -1; });
  });
}

function exchangeCurrencyOk_(code) { return /^[A-Z]{3}$/.test(String(code || '')); }

function exchangeLeg_(leg, label) {
  leg = leg || {};
  var amount = Number(leg.amount);
  if (!(amount > 0)) throw new Error(tr_('xch.badAmount', { side: label }));
  if (!exchangeCurrencyOk_(leg.currency)) throw new Error(tr_('xch.badCurrency', { side: label }));
  var pmId = String(leg.payment_method_id || '');
  if (pmId) {
    var pm = getAllRows('Payment Methods').find(function (p) { return p.id === pmId; });
    if (!pm || pm.type === 'investment') throw new Error(tr_('xch.badAccount', { side: label }));
  }
  return { amount: amount, currency: String(leg.currency), pmId: pmId };
}

// The two legs' ids from one client_id: the money-out leg uses it as is, the money-in leg the same id with its last digit
// moved on by one (still a valid id, always different).
function exchangeLegIds_(clientId) {
  var last = parseInt(clientId.charAt(clientId.length - 1), 16);
  return { out: clientId, in: clientId.slice(0, -1) + ((last + 1) % 16).toString(16) };
}

/**
 * payload: { date 'yyyy-MM-dd', out: {payment_method_id, amount, currency}, in: {...}, house?: text,
 *            pending_entry_id?: a pending review entry to turn into one leg, pending_leg?: 'out' | 'in' }
 * An account may be left empty on ONE side (cash, or someone else's account: nothing in the app to move), and that leg is
 * then not saved. Returns { out, in } (the saved entries, null for an untracked side).
 */
function recordCurrencyExchange(payload) {
  payload = payload || {};
  var date = String(payload.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(tr_('xch.badDate'));
  var out = exchangeLeg_(payload.out, tr_('xch.sideOut'));
  var inn = exchangeLeg_(payload.in, tr_('xch.sideIn'));
  if (out.currency === inn.currency) throw new Error(tr_('xch.sameCurrency'));
  if (!out.pmId && !inn.pmId) throw new Error(tr_('xch.needAccount'));

  var transferCat = getAllRows('Categories').find(function (c) { return c.type === 'transfer'; });
  if (!transferCat) throw new Error(tr_('sa.catMissingBetween'));
  var house = String(payload.house || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  var describe = function (leg, side) {
    return house ? tr_('desc.exchangeHouse', { name: house }) : tr_(side === 'out' ? 'desc.exchangeOut' : 'desc.exchangeIn', { cur: leg.currency });
  };

  // The phone's background queue sends its own id (client_id); the two legs get ids made from it, so sending the same
  // exchange again (a lost reply, the app closed mid-save) answers with the legs already made instead of making two more.
  var clientId = payload.pending_entry_id ? '' : clientSaveId_(payload);
  var legIds = clientId ? exchangeLegIds_(clientId) : null;
  if (legIds) {
    var legOut = out.pmId ? getEntryById_(legIds.out) : null, legIn = inn.pmId ? getEntryById_(legIds.in) : null;
    if (legOut || legIn) return { out: legOut, in: legIn };
  }

  var pending = null, pendingLeg = payload.pending_leg === 'in' ? 'in' : 'out';
  if (payload.pending_entry_id) {
    pending = getEntryById_(String(payload.pending_entry_id));
    if (!pending || pending.status !== 'pending') throw new Error(tr_('xch.notPending'));
  }
  // Checked before anything is saved, so a refusal never leaves one leg behind.
  if (pending && !(pendingLeg === 'out' ? out.pmId : inn.pmId)) throw new Error(tr_('xch.pendingSide'));
  ensureEntriesToPaymentMethodColumn_();
  ensureEntriesExchangeColumn_();

  var result = { out: null, in: null };
  [['out', out], ['in', inn]].forEach(function (pair) {
    var side = pair[0], leg = pair[1];
    if (!leg.pmId) return;   // untracked side: nothing to save
    var fields = {
      type: 'transfer', date: date, amount: leg.amount, currency: leg.currency, category_id: transferCat.id,
      description: describe(leg, side), paid_by: 'me',
      payment_method_id: side === 'out' ? leg.pmId : '', to_payment_method_id: side === 'in' ? leg.pmId : ''
    };
    if (pending && side === pendingLeg) {
      // Turned in place so its e-mail reference stays: a later back-check must not make it again.
      fields.status = 'confirmed';
      fields.exchange = '1';
      fields.merchant = '';
      fields.trip_id = '';
      updateRowFields_('Entries', pending.id, fields);
      result[side] = getEntryById_(pending.id);
    } else {
      if (legIds) fields.client_id = legIds[side];
      result[side] = createEntry(fields);
      updateRowFields_('Entries', result[side].id, { exchange: '1' });
      result[side] = getEntryById_(result[side].id);
    }
  });
  EXCHANGE_HOUSES_MEMO_ = null;   // this exchange may have named a new house
  return result;
}

// ---- One e-mail that names BOTH sides of an exchange (Cambio Mundial-style "Confirmación de Operación") ----
//
// Banks e-mail the money that LEFT (and not always the money that ARRIVED), while the exchange house's own confirmation names both
// sides and an operation code, which equals the bank's operation number (leading zeros differ: "01234567" / "1234567"). So the
// two kinds of e-mail describe the same exchange, in any order, and must never count it twice:
//   * the "left" leg is matched to an entry the bank e-mail may already have made (same code, or same currency + amount within a
//     day on an exchange entry); if the bank e-mail comes second it only fills in the account instead of making a second leg;
//   * the "arrived" leg is matched to an exchange entry made by hand or imported from a statement.
// Either direction works (soles -> dollars and dollars -> soles): the currencies are read from the e-mail, never assumed.
// A rare miss errs towards "one leg missing" (shown by emailCoverageReport_), never towards counting twice.

var EXCHANGE_CURRENCY_WORDS_ = { SOLES: 'PEN', SOL: 'PEN', DOLARES: 'USD', DOLAR: 'USD', EUROS: 'EUR', EURO: 'EUR' };
var EXCHANGE_SYMBOLS_ = { 'S/': 'PEN', 'US$': 'USD', '$': 'USD', '€': 'EUR' };
var EXCHANGE_DESCRIPTION_RE_ = /^(Currency exchange|Cambio de moneda)/i;

// "01234567" and "1234567" are the same code; anything with letters is left as is. Also drops the marker this file puts on its own ids.
function exchangeCodeKey_(value) {
  var s = String(value == null ? '' : value).trim().replace(/^cm-(?:out|in)-/, '');
  return /^\d+$/.test(s) ? s.replace(/^0+/, '') : s;
}

function exchangeSideFromEmail_(body, label) {
  var re = new RegExp(label + ':\\**\\s*([A-Za-zÁÉÍÓÚáéíóú]+)\\**\\s*(S\\/|US\\$|\\$|€)?\\s*([\\d,]+(?:\\.\\d+)?)', 'i');
  var m = String(body || '').match(re);
  if (!m) return null;
  var word = m[1].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  var currency = EXCHANGE_CURRENCY_WORDS_[word] || (m[2] ? EXCHANGE_SYMBOLS_[m[2]] : '');
  var amount = parseFloat(m[3].replace(/,/g, ''));
  return currency && amount > 0 ? { currency: currency, amount: amount } : null;
}

// { out: {currency, amount}, in: {...}, code } or null.
function parseExchangeConfirmation_(subject, body) {
  var out = exchangeSideFromEmail_(body, 'Enviaste');
  var inn = exchangeSideFromEmail_(body, 'Recibir[aá]s');
  if (!out || !inn || out.currency === inn.currency) return null;
  var code = String(body || '').match(/c[oó]digo de tu operaci[oó]n es:\s*\**\s*(\d+)/i);
  return { out: out, in: inn, code: code ? code[1] : '' };
}

function exchangeDayDiff_(a, b) {
  var x = overlapDayNumber_(a), y = overlapDayNumber_(b);
  return x === null || y === null ? 99 : Math.abs(x - y);
}

// The account used the last time money of this currency went out of / came into an exchange (confirmed legs only), or ''.
function lastExchangeAccount_(entries, currency, side) {
  var best = null;
  entries.forEach(function (e) {
    if (e.type !== 'transfer' || e.status !== 'confirmed' || e.currency !== currency || !EXCHANGE_DESCRIPTION_RE_.test(String(e.description || ''))) return;
    var id = side === 'out' ? (!e.to_payment_method_id && e.payment_method_id) : (!e.payment_method_id && e.to_payment_method_id);
    if (id && (!best || String(e.date) >= String(best.date))) best = { date: String(e.date), id: id };
  });
  return best ? best.id : '';
}

/**
 * An existing entry that is the same leg as the one being added, or null.
 *   side 'out' / 'in'; codeKey: the exchange house's code ('' if none); source: 'house' (called for the exchange house's e-mail) or
 *   'bank' (called for a bank e-mail that names the house).
 * A leg matches when it is an exchange entry (or a pending expense naming an exchange house) with the same currency and
 * amount within a day, on the right side — or, for 'out', when its reference is the same code. A BANK e-mail may only take
 * an amount match from a leg whose reference is blank or one of ours (a bank leg with its own real code is another transaction).
 */
function findExchangeLegTwin_(entries, side, currency, amount, dateStr, codeKey, source) {
  var found = null;
  entries.forEach(function (e) {
    if (found || e.currency !== currency) return;
    var isExchange = (e.type === 'transfer' && EXCHANGE_DESCRIPTION_RE_.test(String(e.description || '')))
      || (side === 'out' && e.type === 'expense' && e.status === 'pending' && exchangeHouseIn_(e.description));
    if (!isExchange) return;
    var sideOk = side === 'out' ? !e.to_payment_method_id : !e.payment_method_id;
    if (!sideOk) return;
    var ext = String(e.external_id || '');
    var codeHit = side === 'out' && codeKey && exchangeCodeKey_(ext) === codeKey;
    var amountHit = Math.abs(Number(e.amount) - Number(amount)) < 0.005 && exchangeDayDiff_(e.date, dateStr) <= 1;
    if (side === 'in' && /^cm-in-/.test(ext)) return;   // one of our own arrival legs is another exchange
    if (source === 'bank' && !codeHit && ext && !/^(cm-|stmt-)/.test(ext)) return;   // a bank leg with its own code: another transaction
    if (codeHit || amountHit) found = e;
  });
  return found;
}

// Saves what an exchange-house e-mail says: up to two pending one-sided transfers. Returns how many were created, or -1 when unreadable.
function processExchangeEmail_(rule, message, sender, dateStr, createdAt, results, existingExternalIds) {
  var parsed = parseExchangeConfirmation_(message.getSubject(), message.getPlainBody());
  if (!parsed) return -1;
  var codeKey = exchangeCodeKey_(parsed.code);
  var entries = getAllRows('Entries');
  var transferCat = getAllRows('Categories').find(function (c) { return c.type === 'transfer'; });
  var description = tr_('desc.exchangeHouse', { name: rule.house });
  ensureEntriesToPaymentMethodColumn_();
  ensureEntriesExchangeColumn_();
  var made = 0;

  [['out', parsed.out], ['in', parsed.in]].forEach(function (pair) {
    var side = pair[0], leg = pair[1];
    var externalId = 'cm-' + side + '-' + (codeKey || String(message.getId()));
    if (existingExternalIds[externalId]) { results.duplicates++; return; }
    existingExternalIds[externalId] = true;
    var twin = findExchangeLegTwin_(entries, side, leg.currency, leg.amount, dateStr, codeKey, 'house');
    if (twin) {
      results.duplicates++;
      // A bank e-mail that read as a plain pending expense becomes the leg itself, so it is not left behind as spending.
      if (twin.type === 'expense') {
        updateRowFields_('Entries', twin.id, { type: 'transfer', category_id: transferCat ? transferCat.id : '', description: description, merchant: '', to_payment_method_id: '', exchange: '1' });
      }
      return;
    }
    var account = lastExchangeAccount_(entries, leg.currency, side);
    var entry = {
      id: Utilities.getUuid(), type: 'transfer', date: dateStr, amount: leg.amount, currency: leg.currency,
      category_id: transferCat ? transferCat.id : '', description: description,
      payment_method_id: side === 'out' ? account : '', to_payment_method_id: side === 'in' ? account : '',
      paid_by: 'me', status: 'pending', source: 'email', external_id: externalId, import_batch_id: '', created_at: createdAt, merchant: '', exchange: '1'
    };
    appendRowObject('Entries', entry);
    entries.push(entry);
    results.created++;
    made++;
    try { sendTelegramEntryNotification_(entry, null, null); } catch (err) { console.error('Telegram notification failed: ' + err); }
  });
  EXCHANGE_HOUSES_MEMO_ = null;
  return made;
}

// Exchange legs with no partner: a one-sided "left" leg and a one-sided "arrived" leg in DIFFERENT currencies, within 3 days, form a pair.
// What is left over and older than 2 days is returned (newest first, at most 30): the exchange is missing a side.
function unpairedExchangeLegs_() {
  var legs = getAllRows('Entries').filter(function (e) {
    return e.type === 'transfer' && EXCHANGE_DESCRIPTION_RE_.test(String(e.description || '')) && (!!e.payment_method_id !== !!e.to_payment_method_id);
  }).map(function (e) { return { e: e, side: e.payment_method_id ? 'out' : 'in', used: false }; });
  legs.forEach(function (a) {
    if (a.used || a.side !== 'out') return;
    var b = legs.find(function (x) { return !x.used && x.side === 'in' && x.e.currency !== a.e.currency && exchangeDayDiff_(x.e.date, a.e.date) <= 3; });
    if (b) { a.used = true; b.used = true; }
  });
  var cutoff = overlapDayNumber_(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')) - 2;
  return legs.filter(function (l) { return !l.used && overlapDayNumber_(l.e.date) <= cutoff; })
    .sort(function (a, b) { return String(b.e.date).localeCompare(String(a.e.date)); })
    .slice(0, 30)
    .map(function (l) { return { date: String(l.e.date), side: l.side, currency: l.e.currency, amount: Number(l.e.amount), status: l.e.status }; });
}
