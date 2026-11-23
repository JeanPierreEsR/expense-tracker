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
    if (isPracticeExchange_(e)) return;   // the first-use practice's own "house" is never learned
    var m = String(e.description || '').match(/^(?:Currency exchange|Cambio de moneda) \((.+)\)\s*$/i);
    if (m && !seen[m[1].toLowerCase()]) { seen[m[1].toLowerCase()] = true; names.push(m[1]); }
  });
  EXCHANGE_HOUSES_MEMO_ = names.map(ownerNameTokens_).filter(function (t) { return t.length >= 1 && t.join('').length >= 5; });
  return EXCHANGE_HOUSES_MEMO_;
}

// First-use Currency exchange practice (docs/app.js § First-use practice: Currency exchange). Its exchange carries the "house" name
// "Practice exchange" / "Cambio de práctica", so each of its two legs reads "Currency exchange (Practice exchange)" /
// "Cambio de moneda (Cambio de práctica)". Every guard and the cleanup below look for exactly that, nothing looser.
var PRACTICE_EXCHANGE_RE_ = /^(?:Currency exchange|Cambio de moneda) \((?:Practice exchange|Cambio de práctica)\)$/i;
function isPracticeExchange_(e) {
  return !!e && e.type === 'transfer' && PRACTICE_EXCHANGE_RE_.test(String(e.description || '').trim());
}

/**
 * The Currency exchange practice's cleanup in ONE call: deletes the exchange legs carrying the practice's name that were made since
 * the day the practice started (by their date or by the moment they were saved, in case the person changed the date). Nothing else is
 * touched: not a real exchange, not a rate. (Recording an exchange never writes a rate - the rate line in the form is only shown -
 * so there is no rate to remove; Exchange Rates is not read or written here.)
 *   payload: { started_on 'yyyy-MM-dd' }   returns { entries }
 */
function removePracticeExchange(payload) {
  return withScriptLockOnce_(function () {
    var startedOn = String((payload && payload.started_on) || '');
    var out = { entries: 0 };
    getAllRows('Entries').forEach(function (e) {
      if (!isPracticeExchange_(e)) return;
      var since = !startedOn || String(e.date) >= startedOn || String(e.created_at || '').slice(0, 10) >= startedOn;
      if (!since) return;
      try { discardEntryWithRepayments_(e.id, 'cancel'); out.entries++; } catch (err) { /* it stays: the person can delete it by hand */ }
    });
    EXCHANGE_HOUSES_MEMO_ = null;
    return out;
  });
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
  // The money that arrived may carry its own day (owner, 2026-11-23: the second side can come later). Optional; the same day otherwise.
  var inDate = String(payload.in_date || '') || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inDate)) throw new Error(tr_('xch.badDate'));
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
  ensureColumn_('Entries', 'exchange_pair');
  // Both sides carry the same pair id, so the app can show and delete them as ONE exchange (owner, 2026-11-02).
  var pairId = clientId || Utilities.getUuid();

  var result = { out: null, in: null };
  [['out', out], ['in', inn]].forEach(function (pair) {
    var side = pair[0], leg = pair[1];
    if (!leg.pmId) return;   // untracked side: nothing to save
    var fields = {
      type: 'transfer', date: side === 'in' ? inDate : date, amount: leg.amount, currency: leg.currency, category_id: transferCat.id,
      description: describe(leg, side), paid_by: 'me',
      payment_method_id: side === 'out' ? leg.pmId : '', to_payment_method_id: side === 'in' ? leg.pmId : ''
    };
    if (pending && side === pendingLeg) {
      // Turned in place so its e-mail reference stays: a later back-check must not make it again.
      fields.status = 'confirmed';
      fields.exchange = '1';
      fields.exchange_pair = pairId;
      fields.merchant = '';
      fields.trip_id = '';
      updateRowFields_('Entries', pending.id, fields);
      result[side] = getEntryById_(pending.id);
    } else {
      if (legIds) fields.client_id = legIds[side];
      result[side] = createEntry(fields);
      updateRowFields_('Entries', result[side].id, { exchange: '1', exchange_pair: pairId });
      result[side] = getEntryById_(result[side].id);
    }
  });
  EXCHANGE_HOUSES_MEMO_ = null;   // this exchange may have named a new house
  return result;
}

/**
 * Edits a whole exchange at once (owner, 2026-11-23: editing it side by side was the only way): both sides change together.
 * payload: { out_id, in_id, date, in_date?, out: {payment_method_id, amount, currency}, in: {...}, house? }. Both sides keep an
 * account of the person's (they both exist; to drop one, the exchange is deleted and saved again). `house` is sent only when it
 * changed: the two descriptions are then written again from it; otherwise they stay as they were (a bank's own wording included).
 * Returns { out, in }.
 */
function updateCurrencyExchange(payload) {
  payload = payload || {};
  var legOut = getEntryById_(String(payload.out_id || '')), legIn = getEntryById_(String(payload.in_id || ''));
  if (!legOut || !legIn || exchangeLegSide_(legOut) !== 'out' || exchangeLegSide_(legIn) !== 'in') throw new Error(tr_('xch.editGone'));
  var date = String(payload.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(tr_('xch.badDate'));
  var inDate = String(payload.in_date || '') || date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inDate)) throw new Error(tr_('xch.badDate'));
  var out = exchangeLeg_(payload.out, tr_('xch.sideOut'));
  var inn = exchangeLeg_(payload.in, tr_('xch.sideIn'));
  if (out.currency === inn.currency) throw new Error(tr_('xch.sameCurrency'));
  if (!out.pmId || !inn.pmId) throw new Error(tr_('xch.editBothAccounts'));
  ensureEntriesToPaymentMethodColumn_();
  ensureEntriesExchangeColumn_();
  ensureColumn_('Entries', 'exchange_pair');
  // An older exchange paired by its day gets a pair id now, so the two sides stay one exchange whatever the dates become.
  var pairId = String(legOut.exchange_pair || legIn.exchange_pair || '') || Utilities.getUuid();
  var houseGiven = payload.house !== undefined && payload.house !== null;
  var house = houseGiven ? String(payload.house).replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  var result = {};
  [['out', legOut, out], ['in', legIn, inn]].forEach(function (x) {
    var side = x[0], entry = x[1], leg = x[2];
    var fields = {
      date: side === 'in' ? inDate : date, amount: leg.amount, currency: leg.currency,
      payment_method_id: side === 'out' ? leg.pmId : '', to_payment_method_id: side === 'in' ? leg.pmId : '',
      exchange: '1', exchange_pair: pairId
    };
    if (houseGiven) fields.description = house ? tr_('desc.exchangeHouse', { name: house }) : tr_(side === 'out' ? 'desc.exchangeOut' : 'desc.exchangeIn', { cur: leg.currency });
    result[side] = updateEntryFields(entry.id, fields);
  });
  EXCHANGE_HOUSES_MEMO_ = null;   // the edit may have named a new house
  return result;
}

// ---- Linking two sides by hand (owner, 2026-11-23) ----
// A side on its own (or linked to the wrong partner) is joined to the other side the person picks. Candidates: exchange sides in the
// opposite direction, in another currency, in the same state, within EXCHANGE_LINK_DAYS_ days; one already in another exchange is
// listed too (`taken`), since picking it is how a wrong link is fixed (its old partner is left on its own).
var EXCHANGE_LINK_DAYS_ = 10;
function listExchangeLinkCandidates(payload) {
  var entry = getEntryById_(String((payload || {}).id || ''));
  var side = exchangeLegSide_(entry);
  if (!side) throw new Error(tr_('xlink.notSide'));
  var all = getAllRows('Entries');
  var pairCount = {};
  all.forEach(function (e) { var p = String(e.exchange_pair || ''); if (p) pairCount[p] = (pairCount[p] || 0) + 1; });
  var mine = String(entry.exchange_pair || '');
  return all.filter(function (x) {
    return x.id !== entry.id && x.status === entry.status && x.currency !== entry.currency && !isPracticeExchange_(x)
      && exchangeLegSide_(x) && exchangeLegSide_(x) !== side && exchangeDayDiff_(x.date, entry.date) <= EXCHANGE_LINK_DAYS_
      && !(mine && String(x.exchange_pair || '') === mine);
  }).sort(function (a, b) {
    return (exchangeDayDiff_(a.date, entry.date) - exchangeDayDiff_(b.date, entry.date)) || String(b.date).localeCompare(String(a.date));
  }).slice(0, 20).map(function (x) {
    var p = String(x.exchange_pair || '');
    return { id: x.id, date: String(x.date), amount: Number(x.amount), currency: x.currency, side: exchangeLegSide_(x),
      account: x.payment_method_id || x.to_payment_method_id || '', taken: !!(p && pairCount[p] > 1) };
  });
}

// payload: { id, partner_id }. Both get one new link id (and the exchange marker). Returns { out, in }.
function linkExchangeSides(payload) {
  payload = payload || {};
  var a = getEntryById_(String(payload.id || '')), b = getEntryById_(String(payload.partner_id || ''));
  var sa = exchangeLegSide_(a), sb = exchangeLegSide_(b);
  if (!sa || !sb) throw new Error(tr_('xlink.notSide'));
  if (sa === sb || a.currency === b.currency || a.status !== b.status) throw new Error(tr_('xlink.notPair'));
  ensureEntriesExchangeColumn_();
  ensureColumn_('Entries', 'exchange_pair');
  var pairId = Utilities.getUuid();
  [a, b].forEach(function (e) { updateRowFields_('Entries', e.id, { exchange: '1', exchange_pair: pairId }); });
  var out = sa === 'out' ? a : b, inn = sa === 'out' ? b : a;
  return { out: getEntryById_(out.id), 'in': getEntryById_(inn.id) };
}

// ---- "Exchanges to link" (owner, 2026-11-23): sides saved apart, suggested in pairs for the person to confirm ----
// Before 2026-11-23 a statement saved an exchange's two sides with no link id, and exchanges before 2026-11-02 had none either. Home
// pairs unlinked sides of the SAME day by itself; sides on different days showed as two rows. This finds those: a confirmed side with
// no partner, the opposite side in another currency 1 to 3 days away (the window the missing-side report uses), and amounts that
// fit the rate table within 15 % when a rate is known. One-to-one, closest days first. Never linked without the person: a guess can
// be wrong. A pair the person said "Not these" to is remembered (Settings `exchange_link_refused`), and "Don't ask again" turns it off.
var EXCHANGE_SUGGEST_DAYS_ = 3;
function exchangeLinkSuggestions_() {
  var settings = getSettingsMap();
  if (String(settings.exchange_link_off || '') === 'yes') return [];
  var refused = {};
  try { (JSON.parse(String(settings.exchange_link_refused || '[]')) || []).forEach(function (k) { refused[k] = true; }); } catch (e) { /* unreadable: nothing refused */ }
  var all = getAllRows('Entries');
  var pairCount = {};
  all.forEach(function (e) { var p = String(e.exchange_pair || ''); if (p) pairCount[p] = (pairCount[p] || 0) + 1; });
  var lone = all.filter(function (e) {
    return e.status === 'confirmed' && exchangeLegSide_(e) && !isPracticeExchange_(e) && !(e.exchange_pair && pairCount[String(e.exchange_pair)] > 1);
  });
  var used = {};
  // Same-day sides are already shown as one exchange (Home's own pairing): taken out first, as Home does.
  lone.forEach(function (a) {
    if (used[a.id] || exchangeLegSide_(a) !== 'out') return;
    var b = lone.find(function (x) { return !used[x.id] && exchangeLegSide_(x) === 'in' && x.currency !== a.currency && String(x.date) === String(a.date); });
    if (b) { used[a.id] = true; used[b.id] = true; }
  });
  var toMain = function (e) {
    var r = getLatestRateOnOrBefore_(e.currency, String(e.date).substring(0, 7));
    return r === null || r === undefined ? null : Math.abs(Number(e.amount)) * r;
  };
  var options = [];
  lone.forEach(function (o) {
    if (used[o.id] || exchangeLegSide_(o) !== 'out') return;
    lone.forEach(function (i) {
      if (used[i.id] || exchangeLegSide_(i) !== 'in' || i.currency === o.currency) return;
      var gap = exchangeDayDiff_(o.date, i.date);
      if (gap < 1 || gap > EXCHANGE_SUGGEST_DAYS_ || refused[o.id + '|' + i.id]) return;
      var a = toMain(o), b = toMain(i);
      if (a !== null && b !== null && b > 0 && (a / b < 0.85 || a / b > 1.15)) return;
      options.push({ out: o, 'in': i, gap: gap });
    });
  });
  options.sort(function (x, y) { return (x.gap - y.gap) || String(y.out.date).localeCompare(String(x.out.date)); });
  var result = [];
  options.forEach(function (p) {
    if (used[p.out.id] || used[p['in'].id]) return;
    used[p.out.id] = true; used[p['in'].id] = true;
    result.push(p);
  });
  var side = function (e) { return { id: e.id, date: String(e.date), amount: Number(e.amount), currency: e.currency, account: e.payment_method_id || e.to_payment_method_id || '' }; };
  return result.sort(function (x, y) { return String(y.out.date).localeCompare(String(x.out.date)); })
    .map(function (p) { return { out: side(p.out), 'in': side(p['in']) }; });
}
function listExchangeLinkSuggestions() { return exchangeLinkSuggestions_().slice(0, 50); }
// Home's card: how many pairs there are (0 = no card).
function exchangeLinkSuggestionCount_() {
  try { return exchangeLinkSuggestions_().length; } catch (e) { return 0; }
}
// payload: { pairs: [{ id, partner_id }] } — several links in ONE call ("Link all"). Returns how many were linked.
function linkExchangePairs(payload) {
  var n = 0;
  ((payload || {}).pairs || []).forEach(function (p) { linkExchangeSides(p); n++; });
  return { linked: n };
}
// payload: { out_id, in_id } — "Not these": never suggested again.
function refuseExchangeLinkSuggestion(payload) {
  payload = payload || {};
  var list = [];
  try { list = JSON.parse(String(getSettingsMap().exchange_link_refused || '[]')) || []; } catch (e) { list = []; }
  var key = String(payload.out_id || '') + '|' + String(payload.in_id || '');
  if (list.indexOf(key) === -1) list.push(key);
  setSetting_('exchange_link_refused', JSON.stringify(list.slice(-300)));
  return { ok: true };
}
// "Don't ask again": the card and its list are gone for good on this copy.
function stopExchangeLinkSuggestions() { setSetting_('exchange_link_off', 'yes'); return { ok: true }; }

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
    if (e.type !== 'transfer' || e.status !== 'confirmed' || e.currency !== currency || !EXCHANGE_DESCRIPTION_RE_.test(String(e.description || '')) || isPracticeExchange_(e)) return;
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
    if (found || e.currency !== currency || isPracticeExchange_(e)) return;   // the practice's legs are never a real exchange's twin
    // A bank names the house by its legal name ("Inversiones <x> S.", not "Cambio Mundial"), so a pending bank expense with the house's
    // operation code and the same amount is the same leg whatever its name (2026-11-20: every Cambio Mundial exchange counted twice).
    var sameCode = side === 'out' && codeKey && exchangeCodeKey_(e.external_id) === codeKey && Math.abs(Number(e.amount) - Number(amount)) < 0.005;
    var isExchange = (e.type === 'transfer' && EXCHANGE_DESCRIPTION_RE_.test(String(e.description || '')))
      || (side === 'out' && e.type === 'expense' && e.status === 'pending' && (sameCode || exchangeHouseIn_(e.description)));
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

// The exchange house's "left" leg already made from its own e-mail with this bank operation number (its code), same currency and amount,
// or null. Lets a bank e-mail that names the house by another (legal) name be recognised as that leg instead of a second, spending entry.
var EXCHANGE_HOUSE_LEGS_MEMO_ = null;   // the house's "left" legs (cm-out-…), read once per e-mail run; dropped whenever the house adds one
function exchangeHouseLegByCode_(fields) {
  var key = exchangeCodeKey_(fields.externalId);
  if (!key) return null;
  if (!EXCHANGE_HOUSE_LEGS_MEMO_) EXCHANGE_HOUSE_LEGS_MEMO_ = getAllRows('Entries').filter(function (e) { return /^cm-out-/.test(String(e.external_id || '')); });
  return EXCHANGE_HOUSE_LEGS_MEMO_.find(function (e) {
    return e.type === 'transfer' && String(e.external_id || '') === 'cm-out-' + key && e.currency === fields.currency
      && Math.abs(Number(e.amount) - Number(fields.amount)) < 0.005 && !e.to_payment_method_id;
  }) || null;
}

// ---- The two sides of one exchange, as ONE item (owner, 2026-11-20) ----
// Which side a leg is: the side whose account is set, else what the exchange house's id says ('' when neither tells).
function exchangePairSide_(e) {
  if (!e) return '';
  if (e.payment_method_id && !e.to_payment_method_id) return 'out';
  if (e.to_payment_method_id && !e.payment_method_id) return 'in';
  var ext = String(e.external_id || '');
  return /^cm-in-/.test(ext) ? 'in' : (/^cm-out-/.test(ext) ? 'out' : '');
}

// A transfer saved as one side of a currency exchange (its marker). Such a side holds ONE account: where the money left, or where it
// arrived (owner, 2026-11-23: a side with both read as dollars leaving the soles account).
function isExchangeLegMarked_(e) {
  return !!e && e.type === 'transfer' && String(e.exchange || '') === '1';
}

// The other side of an exchange (same exchange_pair), or null.
function exchangePartner_(entry, entries) {
  var pair = String((entry && entry.exchange_pair) || '');
  if (!pair || entry.type !== 'transfer') return null;
  return (entries || getAllRows('Entries')).filter(function (e) {
    return e.id !== entry.id && e.type === 'transfer' && String(e.exchange_pair || '') === pair;
  })[0] || null;
}

// { out, in } when this leg and its partner are both waiting, else null. Either one may be the leg passed in.
function pendingExchangePair_(entry, entries) {
  return entry && entry.status === 'pending' ? exchangePairOf_(entry, entries) : null;
}

// { out, in } for a leg and its partner in the SAME state (both waiting or both confirmed), else null.
function exchangePairOf_(entry, entries) {
  if (!entry || (entry.status !== 'pending' && entry.status !== 'confirmed')) return null;
  var partner = exchangePartner_(entry, entries);
  if (!partner || partner.status !== entry.status || partner.currency === entry.currency) return null;
  var a = exchangePairSide_(entry), b = exchangePairSide_(partner);
  if (a === 'out' || b === 'in') return a === 'in' ? null : { out: entry, 'in': partner };
  if (a === 'in' || b === 'out') return { out: partner, 'in': entry };
  return null;
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
  ensureColumn_('Entries', 'exchange_pair');
  var made = 0, turned = false;
  var legsBySide = { out: null, in: null };   // the two sides of THIS exchange, new or found, paired below (owner, 2026-11-20)

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
        turned = true;
      }
      legsBySide[side] = twin;
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
    EXCHANGE_HOUSE_LEGS_MEMO_ = null;
    results.created++;
    made++;
    legsBySide[side] = entry;
  });
  // Both sides carry one pair id, as the app's own exchange form does, so Needs review, Home and the bot show them as ONE exchange.
  var outLeg = legsBySide.out, inLeg = legsBySide['in'];
  if (outLeg && inLeg) {
    var pairId = String(outLeg.exchange_pair || inLeg.exchange_pair || '') || Utilities.getUuid();
    [outLeg, inLeg].forEach(function (e) { if (String(e.exchange_pair || '') !== pairId) updateRowFields_('Entries', e.id, { exchange_pair: pairId }); });
  }
  // ONE bot message for the exchange (owner, 2026-11-20): it shows both sides, and Confirm / Discard act on both.
  if (made || turned) {
    var card = [outLeg, inLeg].map(function (e) { return e ? getEntryById_(e.id) : null; }).filter(function (e) { return e && e.status === 'pending'; })[0];
    if (card) { try { sendTelegramEntryNotification_(card, null, null); } catch (err) { console.error('Telegram notification failed: ' + err); } }
  }
  EXCHANGE_HOUSES_MEMO_ = null;
  return made;
}

// Exchange legs with no partner: two sides linked by their exchange_pair id are a pair whatever their days (owner, 2026-11-23: the money
// can arrive days later); an unlinked "left" leg and "arrived" leg in DIFFERENT currencies, within 3 days, form a pair too.
// What is left over and older than 2 days is returned (newest first, at most 30): the exchange is missing a side.
function unpairedExchangeLegs_() {
  var legs = getAllRows('Entries').filter(function (e) {
    return e.type === 'transfer' && EXCHANGE_DESCRIPTION_RE_.test(String(e.description || '')) && !isPracticeExchange_(e) && (!!e.payment_method_id !== !!e.to_payment_method_id);
  }).map(function (e) { return { e: e, side: e.payment_method_id ? 'out' : 'in', used: false }; });
  legs.forEach(function (a) {
    var pair = String(a.e.exchange_pair || '');
    if (a.used || a.side !== 'out' || !pair) return;
    var b = legs.find(function (x) { return !x.used && x.side === 'in' && String(x.e.exchange_pair || '') === pair && x.e.currency !== a.e.currency; });
    if (b) { a.used = true; b.used = true; }
  });
  legs.forEach(function (a) {
    if (a.used || a.side !== 'out') return;
    var b = legs.find(function (x) { return !x.used && x.side === 'in' && x.e.currency !== a.e.currency && exchangeDayDiff_(x.e.date, a.e.date) <= 3; });
    if (b) { a.used = true; b.used = true; }
  });
  var cutoff = overlapDayNumber_(Utilities.formatDate(new Date(), personTz_(), 'yyyy-MM-dd')) - 2;
  return legs.filter(function (l) { return !l.used && overlapDayNumber_(l.e.date) <= cutoff; })
    .sort(function (a, b) { return String(b.e.date).localeCompare(String(a.e.date)); })
    .slice(0, 30)
    .map(function (l) { return { date: String(l.e.date), side: l.side, currency: l.e.currency, amount: Number(l.e.amount), status: l.e.status }; });
}
