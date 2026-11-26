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

// ---- Separating one account into two (owner, 2026-11-26: "build also separating two accounts, if I have only one with two account
// numbers") — the reverse of a join. One currency of a bank account in several currencies leaves for a NEW account of the same bank,
// with that currency's number and everything recorded in it: entries in that currency (either end of a transfer), loans in it and their
// repayments, its starting balance, its statements (the ones with its number, an AhorraMás one of that currency, or a spreadsheet whose
// closing balance is only in it) and their differences, and the wallet link of that currency (Yape in dollars…). The account keeps the
// rest. Kept 30 days in Recently deleted like a move (Account Moves, kind 'split'); Restore sends everything on the new account back.

function accountSplitPair_(payload) {
  var id = String((payload && payload.id) || ''), cur = String((payload && payload.currency) || '').trim().toUpperCase();
  var pm = getAllRows('Payment Methods').find(function (p) { return String(p.id) === id; });
  if (!pm || isPracticeAccount_(pm)) throw new Error(tr_('err.pmNotFound'));
  var list = applePayAccountCurrencies_(pm);
  if (String(pm.type) !== 'debit' || list.length < 2 || list.indexOf(cur) === -1) throw new Error(tr_('err.splitNot'));
  return { pm: pm, id: id, currency: cur, rest: list.filter(function (c) { return c !== cur; }), digits: pmDigitsByCurrency_(pm)[cur] || '' };
}

// What leaves with the currency: { Entries: { payment_method_id: [ids], to_payment_method_id: [ids] }, Loans, Settlements,
// 'Account Opening Balances', 'Statement Uploads', 'Statement Gaps': [ids] } plus the rows (for the closed-month check).
function accountSplitRows_(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), home = homeCurrency_(), cur = p.currency;
  var curOf = function (r) { return String(r.currency || home).toUpperCase(); };
  var out = { entries: { payment_method_id: [], to_payment_method_id: [] }, sheets: {}, touched: { Entries: [], Loans: [], Settlements: [] } };
  getAllRows('Entries').forEach(function (e) {
    if (curOf(e) !== cur) return;
    var hit = false;
    if (String(e.payment_method_id || '') === p.id) { out.entries.payment_method_id.push(String(e.id)); hit = true; }
    if (String(e.to_payment_method_id || '') === p.id) { out.entries.to_payment_method_id.push(String(e.id)); hit = true; }
    if (hit) out.touched.Entries.push(e);
  });
  var loanCur = {};
  if (ss.getSheetByName('Loans')) {
    var loans = getAllRows('Loans');
    loans.forEach(function (l) { loanCur[String(l.id)] = curOf(l); });
    out.touched.Loans = loans.filter(function (l) { return String(l.payment_method_id || '') === p.id && curOf(l) === cur; });
  }
  out.sheets.Loans = out.touched.Loans.map(function (r) { return String(r.id); });
  if (ss.getSheetByName('Settlements')) {
    out.touched.Settlements = getAllRows('Settlements').filter(function (s) { return String(s.payment_method_id || '') === p.id && loanCur[String(s.loan_id)] === cur; });
  }
  out.sheets.Settlements = out.touched.Settlements.map(function (r) { return String(r.id); });
  ensureAccountOpeningBalancesSheet_();
  out.sheets['Account Opening Balances'] = getAllRows('Account Opening Balances').filter(function (b) {
    return String(b.payment_method_id) === p.id && String(b.currency).toUpperCase() === cur;
  }).map(function (r) { return String(r.id); });
  var keys = {};
  if (p.digits) keys[covKey_(p.digits)] = true;
  keys['AHORRA-' + cur] = true;
  var uploadIn = function (u) {
    if (keys[covKey_(u.account_key)] || keys[String(u.account_key)]) return true;
    var bal = {};
    try { bal = JSON.parse(String(u.closing_json || '{}')) || {}; } catch (e) { bal = {}; }
    var curs = Object.keys(bal);
    return String(u.account_key).indexOf(STMT_ACCT_KEY_PREFIX_) === 0 && curs.length === 1 && curs[0] === cur;
  };
  out.sheets['Statement Uploads'] = ss.getSheetByName('Statement Uploads') ? getAllRows('Statement Uploads').filter(function (u) {
    return String(u.payment_method_id || '') === p.id && uploadIn(u);
  }).map(function (r) { return String(r.id); }) : [];
  out.sheets['Statement Gaps'] = ss.getSheetByName('Statement Gaps') ? getAllRows('Statement Gaps').filter(function (g) {
    return String(g.payment_method_id || '') === p.id && String(g.currency || '').toUpperCase() === cur;
  }).map(function (r) { return String(r.id); }) : [];
  return out;
}

// The wallet links of that currency on the account (yape_usd for dollars, yape_pen / plin_pen for soles).
function accountSplitLinks_(p, settings) {
  var suffix = '_' + p.currency.toLowerCase();
  var keys = RAIL_LINK_KEYS_.filter(function (k) { return k.slice(-suffix.length) === suffix && String(settings[k] || '') === p.id; });
  if (p.currency === 'PEN' && plinMoreIds_(settings).indexOf(p.id) !== -1) keys.push(PLIN_MORE_KEY_);
  return keys;
}

function previewAccountSplit(payload) {
  var p = accountSplitPair_(payload);
  var r = accountSplitRows_(p);
  var links = accountSplitLinks_(p, getSettingsMap());
  var ids = {};
  r.entries.payment_method_id.concat(r.entries.to_payment_method_id).forEach(function (id) { ids[id] = true; });
  return {
    id: p.id, nickname: String(p.pm.nickname), currency: p.currency, rest: p.rest, digits: p.digits,
    counts: { entries: Object.keys(ids).length, loans: r.sheets.Loans.length, repayments: r.sheets.Settlements.length,
      statements: r.sheets['Statement Uploads'].length, balances: r.sheets['Account Opening Balances'].length },
    links: links.map(railLinkName_).filter(function (n, i, a) { return a.indexOf(n) === i; }),
    closedMonths: accountMoveClosedHit_(r.touched)
  };
}

function splitAccount(payload) {
  return withScriptLockOnce_(function () {
    var p = accountSplitPair_(payload);
    var name = String((payload && payload.name) || '').trim().slice(0, 60);
    if (!name) throw new Error(tr_('err.enterName'));
    var r = accountSplitRows_(p);
    var closed = accountMoveClosedHit_(r.touched);
    if (closed.length) throw new Error(tr_('err.moveClosed', { months: closed.join(', ') }));
    // 1. The new account: same bank, the one currency, its number (savePaymentMethod checks the name).
    var made = savePaymentMethod({ nickname: name, type: 'debit', bank_id: String(p.pm.bank_id || ''), last_4: p.digits, currencies: [p.currency] });
    var newId = String(made.id);
    // 2. The account keeps the other currencies and numbers (its main number may change with them).
    var digits = pmDigitsByCurrency_(p.pm);
    delete digits[''];
    var main = pmMainDigitsCurrency_(p.rest);
    var before = { currencies: String(p.pm.currencies || ''), last_4: covKey_(p.pm.last_4), last_4_more: String(p.pm[PM_MORE_LAST4_COLUMN_] || ''),
      nickname: String(p.pm.nickname), alias_auto: String(p.pm.alias_auto || '') };
    var after = { currencies: accountCurrenciesValue_(p.rest), last_4: digits[main] || '', nickname: before.nickname, alias_auto: before.alias_auto,
      last_4_more: pmMoreLast4Value_(p.rest.filter(function (c) { return c !== main && digits[c]; }).map(function (c) { return { currency: c, digits: digits[c] }; })) };
    ensurePaymentMethodCurrenciesColumn_();
    pmWriteMergeFields_(p.id, after);
    // 3. What was recorded in that currency.
    var undo = { kind: 'split', from: Object.assign({}, p.pm), toId: newId, before: before, after: after, entries: {}, sheets: {}, settingsBefore: {}, settingsAfter: {} };
    ['payment_method_id', 'to_payment_method_id'].forEach(function (f) {
      var only = {};
      r.entries[f].forEach(function (id) { only[id] = true; });
      undo.entries[f] = r.entries[f].length ? accountMoveEntriesField_(f, p.id, newId, only) : [];
    });
    [['Loans', 'payment_method_id'], ['Settlements', 'payment_method_id'], ['Account Opening Balances', 'payment_method_id'],
      ['Statement Uploads', 'payment_method_id'], ['Statement Gaps', 'payment_method_id']].forEach(function (s) {
      var only = {};
      (r.sheets[s[0]] || []).forEach(function (id) { only[id] = true; });
      undo.sheets[s[0]] = Object.keys(only).length ? accountMoveColumn_(s[0], s[1], p.id, newId, only) : [];
    });
    // 4. The wallet links of that currency follow it.
    var settings = getSettingsMap();
    var links = accountSplitLinks_(p, settings);
    RAIL_LINK_KEYS_.concat([PLIN_MORE_KEY_]).forEach(function (k) { undo.settingsBefore[k] = String(settings[k] || ''); });
    links.forEach(function (k) {
      if (k === PLIN_MORE_KEY_) setSetting_(k, plinMoreIds_(settings).map(function (id) { return id === p.id ? newId : id; }).join(','));
      else setSetting_(k, newId);
    });
    var now = getSettingsMap();
    RAIL_LINK_KEYS_.concat([PLIN_MORE_KEY_]).forEach(function (k) { undo.settingsAfter[k] = String(now[k] || ''); });
    var ids = {};
    undo.entries.payment_method_id.concat(undo.entries.to_payment_method_id).forEach(function (id) { ids[id] = true; });
    var counts = { split: true, currency: p.currency, entries: Object.keys(ids).length, loans: undo.sheets.Loans.length, repayments: undo.sheets.Settlements.length,
      statements: undo.sheets['Statement Uploads'].length, balances: undo.sheets['Account Opening Balances'].length, links: links.length };
    var moveId = Utilities.getUuid();
    saveAccountMove_(moveId, String(p.pm.nickname), name, counts, undo);
    bumpStructureVersion_();
    return { move_id: moveId, from: { id: p.id, nickname: String(p.pm.nickname) }, to: { id: newId, nickname: String(made.nickname) }, counts: counts };
  });
}

// Restore of a separation: everything on the new account goes back (what was added to it since too: nothing is left on an account
// about to go), the account gets its currencies and numbers back, and the new account is deleted; later saves that still carry its id
// land on the original (pm_forward).
function restoreAccountSplit_(rec) {
  var u = rec.undo, oldId = String(u.from.id), newId = String(u.toId);
  var pms = getAllRows('Payment Methods');
  if (!pms.some(function (pm) { return String(pm.id) === oldId; })) throw new Error(tr_('err.moveUndoGone'));
  var touched = { Entries: getAllRows('Entries').filter(function (e) { return String(e.payment_method_id || '') === newId || String(e.to_payment_method_id || '') === newId; }), Loans: [], Settlements: [] };
  ['Loans', 'Settlements'].forEach(function (t) { if (SpreadsheetApp.getActiveSpreadsheet().getSheetByName(t)) touched[t] = getAllRows(t).filter(function (row) { return String(row.payment_method_id || '') === newId; }); });
  var closed = accountMoveClosedHit_(touched);
  if (closed.length) throw new Error(tr_('err.moveClosed', { months: closed.join(', ') }));
  var backIds = {};
  ['payment_method_id', 'to_payment_method_id'].forEach(function (f) { accountMoveEntriesField_(f, newId, oldId).forEach(function (id) { backIds[id] = true; }); });
  ['Loans', 'Settlements', 'Account Opening Balances', 'Statement Uploads', 'Statement Gaps'].forEach(function (t) { accountMoveColumn_(t, 'payment_method_id', newId, oldId); });
  var now = getSettingsMap();
  RAIL_LINK_KEYS_.forEach(function (k) { if (String(now[k] || '') === newId) setSetting_(k, oldId); });
  var more = plinMoreIds_(now);
  if (more.indexOf(newId) !== -1) setSetting_(PLIN_MORE_KEY_, more.map(function (id) { return id === newId ? oldId : id; }).filter(function (id, i, a) { return a.indexOf(id) === i; }).join(','));
  // The account's currencies and numbers: those it had, plus any added since (a later rename stays).
  var cur = pms.find(function (pm) { return String(pm.id) === oldId; });
  var back = Object.assign({}, u.before, { nickname: String(cur.nickname), alias_auto: String(cur.alias_auto || u.before.alias_auto || '') });
  var nowList = applePayAccountCurrencies_(cur), beforeList = String(u.before.currencies || '').split(',').filter(Boolean);
  nowList.forEach(function (c) { if (beforeList.indexOf(c) === -1) beforeList.push(c); });
  back.currencies = accountCurrenciesValue_(beforeList);
  pmWriteMergeFields_(oldId, back);
  if (getAllRows('Payment Methods').some(function (pm) { return String(pm.id) === newId; })) deletePaymentMethod({ id: newId });
  setPmForward_(newId, oldId);
  deleteRowsWhere_('Account Moves', function (r) { return String(r.id) === rec.id; });
  bumpStructureVersion_();
  return { restored: true, entriesBack: Object.keys(backIds).length, from_name: rec.from_name, to_name: rec.to_name, split: true };
}
