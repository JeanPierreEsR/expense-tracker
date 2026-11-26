/**
 * One account, several account numbers (owner, 2026-11-26: "users should be able to call their BCP accounts Yape … this account will have
 * two account numbers, one in soles and one in dollars"). Any bank account in two currencies can hold the last 4 digits of each one.
 *
 * Storage: `last_4` keeps the digits of the account's MAIN currency (the person's main currency when the account has it, else its first
 * one: pmMainDigitsCurrency_, the same rule as the phone's); Payment Methods `last_4_more` keeps the others as "USD:5678" (comma
 * separated, text). Unlike the old digits of a replaced card (AccountMove.gs, `old_last_4`: one bank, 6 months), these are the account's
 * own numbers: they always count, wherever the current digits count (bank e-mails, Apple Pay, statements, Import, coverage).
 *
 * Joining two accounts ("BCP soles" + "BCP dólares" → one account) is a move of history (moveAccountHistory with `merge`): the old
 * account's currency and digits become the new account's, for good.
 */

var PM_MORE_LAST4_COLUMN_ = 'last_4_more';

function ensurePaymentMethodMoreLast4Column_() {
  ensureColumn_('Payment Methods', PM_MORE_LAST4_COLUMN_);
}

// [{ currency: 'USD', digits: '5678' }] — the account's other numbers (never its main one).
function pmMoreLast4Items_(pm) {
  var seen = {};
  return String((pm && pm[PM_MORE_LAST4_COLUMN_]) || '').split(',').map(function (part) {
    var bits = part.trim().split(':');
    return { currency: String(bits[0] || '').trim().toUpperCase(), digits: covKey_(String(bits[1] || '').trim()) };
  }).filter(function (it) {
    if (!/^[A-Z]{3}$/.test(it.currency) || !/^\d{4}$/.test(it.digits) || seen[it.currency]) return false;
    seen[it.currency] = true;
    return true;
  });
}
function pmMoreLast4Value_(items) {
  return (items || []).filter(function (it) { return /^[A-Z]{3}$/.test(it.currency) && /^\d{4}$/.test(covKey_(it.digits)); })
    .map(function (it) { return it.currency + ':' + covKey_(it.digits); }).join(',');
}

// Every number of the account, its main one first: ["1234", "5678"] (four digits each, leading zeros kept).
function pmLast4List_(pm) {
  var out = [];
  var main = covKey_(pm && pm.last_4);
  if (/^\d{4}$/.test(main)) out.push(main);
  pmMoreLast4Items_(pm).forEach(function (it) { if (out.indexOf(it.digits) === -1) out.push(it.digits); });
  return out;
}
function pmHasLast4_(pm, digits) {
  var k = covKey_(digits);
  return /^\d{4}$/.test(k) && pmLast4List_(pm).indexOf(k) !== -1;
}
// No digits at all (neither the main ones nor another currency's).
function pmHasNoDigits_(pm) { return !pmLast4List_(pm).length; }

// The currency the main digits belong to: the person's main currency when the account has it, else its first currency ('' = none known).
function pmMainDigitsCurrency_(currencies) {
  var list = currencies || [];
  var home = homeCurrency_();
  return list.indexOf(home) !== -1 ? home : (list[0] || '');
}

// The account's numbers by currency: { PEN: '1234', USD: '5678' } ('' key = main digits with no currency known).
function pmDigitsByCurrency_(pm) {
  var out = {};
  var main = covKey_(pm && pm.last_4);
  if (/^\d{4}$/.test(main)) out[pmMainDigitsCurrency_(applePayAccountCurrencies_(pm))] = main;
  pmMoreLast4Items_(pm).forEach(function (it) { if (!out[it.currency]) out[it.currency] = it.digits; });
  return out;
}

// The value savePaymentMethod stores from the phone's `last_4_more` ([{ currency, digits }] or "USD:5678"): only currencies of the account
// other than its main one, four digits each, never the main digits again. '' = none.
function pmMoreLast4FromPayload_(raw, currencies, mainDigits) {
  var items = Array.isArray(raw) ? raw : pmMoreLast4Items_({ last_4_more: String(raw || '') });
  var main = pmMainDigitsCurrency_(currencies), seen = {}, out = [];
  items.forEach(function (it) {
    var cur = String((it && it.currency) || '').trim().toUpperCase(), d = String((it && it.digits) || '').trim();
    if (!d) return;
    if (!/^\d{4}$/.test(d)) throw new Error(tr_('err.pmLast4'));
    if (!/^[A-Z]{3}$/.test(cur) || cur === main || currencies.indexOf(cur) === -1 || seen[cur] || covKey_(d) === covKey_(mainDigits)) return;
    seen[cur] = true;
    out.push({ currency: cur, digits: d });
  });
  return pmMoreLast4Value_(out);
}

function setPmMoreLast4_(pmId, value) {
  ensurePaymentMethodMoreLast4Column_();
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var row = findRowIndexById(sheet, headers, pmId);
  if (row === -1) return;
  sheet.getRange(row, headers.indexOf(PM_MORE_LAST4_COLUMN_) + 1).setNumberFormat('@');   // "USD:0123" stays text
  setCellByRow_(sheet, headers, row, PM_MORE_LAST4_COLUMN_, value);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
}

// ---- AhorraMás (SIP): its statements carry no card digits we key by, only the currency (key AHORRA-PEN / AHORRA-USD) ----
// The account whose name starts with "Ahorra": the one that holds the statement's currency, else the one whose name says it ("soles",
// "dólares"), else the only one. Before 2026-11-26 the FIRST such account was taken whatever its currency, so a dollars statement went to
// "Ahorramas Soles" when the person had both (found while planning the two-number accounts).
function stmtAhorraAccount_(pms, key) {
  var cur = String(key).substring('AHORRA-'.length).toUpperCase();
  var plain = function (pm) { return String(pm.nickname || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  var cands = pms.filter(function (pm) { return !isPracticeAccount_(pm) && plain(pm).replace(/[^a-z]/g, '').indexOf('ahorra') === 0; });
  if (cands.length <= 1) return cands[0] || null;
  var byCur = cands.filter(function (pm) { return applePayAccountCurrencies_(pm).indexOf(cur) !== -1; });
  if (byCur.length === 1) return byCur[0];
  var word = cur === 'PEN' ? /\bsol(es)?\b|\bpen\b/ : cur === 'USD' ? /\bdolar(es)?\b|\bdollars?\b|\busd\b/ : new RegExp('\\b' + cur.toLowerCase() + '\\b');
  var byName = (byCur.length ? byCur : cands).filter(function (pm) { return word.test(plain(pm)); });
  if (byName.length === 1) return byName[0];
  return (byCur.length ? byCur : cands)[0];
}

// savePaymentMethod's part: the phone sends `last_4_more` ([{ currency, digits }]) for a bank account in several currencies. A card has one
// number whatever its currencies, so a card (or any other type) keeps none. Answers the value stored, or null when nothing was asked and
// nothing had to change (an older phone keeps what is there).
function pmSaveMoreLast4_(id, payload, row, mainDigits) {
  var had = String(row[PM_MORE_LAST4_COLUMN_] || '');
  var value;
  if (String(row.type) !== 'debit') value = '';
  else if (payload.last_4_more === undefined || payload.last_4_more === null) return null;
  else value = pmMoreLast4FromPayload_(payload.last_4_more, applePayAccountCurrencies_(row), mainDigits);
  if (value === had) return value;
  if (!value && !had) return '';
  setPmMoreLast4_(id, value);
  return value;
}

// ---- Joining two accounts (moveAccountHistory with `merge`) ----
// Offered when both are bank accounts of the same bank and the old one's currencies are all ones the new one does not have
// ("BCP soles" + "BCP dólares"): the new account then holds both currencies and both numbers, for good. null = not offered.
function accountMergePlan_(from, to) {
  if (String(from.type) !== 'debit' || String(to.type) !== 'debit') return null;
  if (!String(from.bank_id || '') || String(from.bank_id) !== String(to.bank_id || '')) return null;
  var fromCur = applePayAccountCurrencies_(from), toCur = applePayAccountCurrencies_(to);
  if (!fromCur.length || !toCur.length || fromCur.some(function (c) { return toCur.indexOf(c) !== -1; })) return null;
  var currencies = toCur.concat(fromCur);
  var digits = Object.assign({}, pmDigitsByCurrency_(from), pmDigitsByCurrency_(to));
  delete digits[''];
  var main = pmMainDigitsCurrency_(currencies);
  var more = currencies.filter(function (c) { return c !== main && digits[c]; }).map(function (c) { return { currency: c, digits: digits[c] }; });
  return { currencies: currencies, last_4: digits[main] || '', last_4_more: pmMoreLast4Value_(more), digits: digits };
}

// The new account becomes the joined one (after the old one was deleted, so it may take the old one's name). Answers what Undo needs.
function accountMergeApply_(toId, plan, name, fromId) {
  ensurePaymentMethodCurrenciesColumn_();
  ensurePaymentMethodMoreLast4Column_();
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var row = findRowIndexById(sheet, headers, toId);
  var to = getAllRows('Payment Methods').find(function (pm) { return String(pm.id) === String(toId); });
  if (row === -1 || !to) return null;
  var before = { currencies: String(to.currencies || ''), last_4: covKey_(to.last_4), last_4_more: String(to[PM_MORE_LAST4_COLUMN_] || ''),
    nickname: String(to.nickname), alias_auto: String(to.alias_auto || '') };
  var after = { currencies: accountCurrenciesValue_(plan.currencies), last_4: plan.last_4, last_4_more: plan.last_4_more, nickname: before.nickname, alias_auto: before.alias_auto };
  var wanted = String(name || '').trim().slice(0, 60);
  if (wanted && wanted !== before.nickname) {
    var taken = getAllRows('Payment Methods').some(function (pm) {
      return String(pm.id) !== String(toId) && String(pm.id) !== String(fromId) && String(pm.nickname).trim().toLowerCase() === wanted.toLowerCase();
    });
    if (!taken && plainNickname_(wanted) !== 'plin') { after.nickname = wanted; if (headers.indexOf('alias_auto') !== -1) after.alias_auto = 'no'; }
  }
  pmWriteMergeFields_(toId, after);
  return { before: before, after: after };
}

function pmWriteMergeFields_(id, f) {
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var row = findRowIndexById(sheet, headers, id);
  if (row === -1) return;
  if (headers.indexOf('currencies') !== -1) setCellByRow_(sheet, headers, row, 'currencies', f.currencies);
  if (headers.indexOf('alias_auto') !== -1 && f.alias_auto) setCellByRow_(sheet, headers, row, 'alias_auto', f.alias_auto);
  setCellByRow_(sheet, headers, row, 'nickname', f.nickname);
  setPaymentMethodLast4_(sheet, headers, row, f.last_4);
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  setPmMoreLast4_(id, f.last_4_more);
}

// Undo of a join: the new account goes back to what it was, but only while it is still as the join left it.
function accountMergeUndo_(toId, m) {
  if (!m || !m.before || !m.after) return;
  var to = getAllRows('Payment Methods').find(function (pm) { return String(pm.id) === String(toId); });
  if (!to) return;
  var same = covKey_(to.last_4) === covKey_(m.after.last_4) && String(to[PM_MORE_LAST4_COLUMN_] || '') === m.after.last_4_more;
  if (!same) return;
  var back = Object.assign({}, m.before);
  if (String(to.nickname) !== m.after.nickname) back.nickname = String(to.nickname);   // renamed since: the person's newer name stays
  if (String(to.currencies || '') !== m.after.currencies) back.currencies = String(to.currencies || '');
  pmWriteMergeFields_(toId, back);
}

// What the move window says about a join: { currencies: ['PEN', 'USD'], numbers: [{ currency, digits }] }, or null when not offered.
function accountMergePreview_(p) {
  var plan = accountMergePlan_(p.from, p.to);
  if (!plan) return null;
  return {
    currencies: plan.currencies,
    numbers: plan.currencies.filter(function (c) { return plan.digits[c]; }).map(function (c) { return { currency: c, digits: plan.digits[c] }; })
  };
}

function pmCheckMoreLast4_(raw) {
  if (!Array.isArray(raw)) return;
  raw.forEach(function (it) { var d = String((it && it.digits) || '').trim(); if (d && !/^\d{4}$/.test(d)) throw new Error(tr_('err.pmLast4')); });
}
