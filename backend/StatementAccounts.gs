/**
 * New accounts from bank statements (2026-10-25, owner).
 *
 * A statement printed for an account the app does not know yet (no Payment Method with those last four digits) used to be skipped and
 * named. Now the plan PROPOSES the account — name, type, bank — from what the statement itself says, the phone shows it with the
 * statement's lines waiting, and one tap creates it (createStatementAccounts) and reads the statement again. Nothing is created
 * without that tap, and every default can be changed afterwards in More → Accounts, cards & platforms.
 *
 * Defaults, so they look like the accounts the welcome questions make (Accounts.gs): the bank the statement names (an existing bank of the same
 * name is reused), the type from the kind of statement (a card statement = credit, an account statement = debit), and an automatic name
 * "{bank} {soles | dollars | credit}" + the last four digits, in the app's language; the name stays "automatic" (alias_auto) until the person
 * edits it, like any other account. The app never receives a full account number: only the last four digits are used.
 */

var STMT_CREDIT_KINDS_ = ['visa', 'diners', 'sip', 'bcpcard', 'cmr'];   // the statement readers' card kinds (docs/statement-parsers.js)

// The four digits an unknown statement stands for: its key when that is four digits, else the account digits the reader found (AhorraMás keys by currency).
function stmtNewAccountLast4_(st) {
  var key = String(st.key || '');
  if (/^\d{4}$/.test(key)) return key;
  if (key.indexOf('AHORRA-') === 0 && /^\d{4}$/.test(String(st.last4 || ''))) return String(st.last4);
  return '';
}

function stmtNewAccountCurrency_(st) {
  var cur = Object.keys(st.balances || {})[0];
  if (!cur && st.lines && st.lines.length) cur = st.lines[0].currency;
  cur = String(cur || '').toUpperCase();
  return cur === 'USD' ? 'USD' : 'PEN';
}

// One proposal per unknown account found in the statements: { key, last4, bank, bankExists, kind, type, currency, nickname }.
function stmtNewAccountProposals_(sts) {
  var banks = getAllRows('Banks');
  var taken = {};
  getAllRows('Payment Methods').forEach(function (pm) { taken[String(pm.nickname).trim().toLowerCase()] = true; });
  var lang = currentLang_();
  var seen = {}, out = [];
  sts.forEach(function (st) {
    if (st.account) return;
    var last4 = stmtNewAccountLast4_(st);
    var bankName = String(st.bank || '').trim().slice(0, 60);
    if (!last4 || !bankName || seen[last4]) return;
    seen[last4] = true;
    var credit = STMT_CREDIT_KINDS_.indexOf(st.kind) !== -1;
    var currency = stmtNewAccountCurrency_(st);
    var kind = credit ? 'credit' : (currency === 'USD' ? 'debit_usd' : 'debit_pen');
    var existingBank = banks.find(function (b) { return plainNickname_(b.name) === plainNickname_(bankName); });
    var shown = existingBank ? existingBank.name : bankName;
    var nickname = uniqueAccountName_(autoAccountAlias_(bankShortName_(shown), kind, last4, true, lang), last4, taken);
    out.push({ key: String(st.key), last4: last4, bank: shown, bankExists: !!existingBank, kind: kind, type: accountKindType_(kind), currency: currency, nickname: nickname });
  });
  return out;
}

/**
 * Creates the proposed accounts. payload: { accounts: [{ last4, bank, kind }] } — kind is one of ACCOUNT_KINDS_. An account whose last four
 * digits already exist is NOT created again (a second tap or another phone): it comes back under `existing`. Reply:
 * { created: [{ id, nickname, type, bank, last_4 }], existing: [{ id, nickname, last_4 }] }.
 */
function createStatementAccounts(payload) {
  var list = (payload && Array.isArray(payload.accounts)) ? payload.accounts : [];
  if (!list.length) return { created: [], existing: [] };
  if (list.length > 20) throw new Error(tr_('err.tooManyAccounts'));
  ensurePaymentMethodAliasColumns_();
  var lang = currentLang_();
  var sheet = getSheet('Payment Methods');
  var taken = {};
  var pms = getAllRows('Payment Methods');
  pms.forEach(function (pm) { taken[String(pm.nickname).trim().toLowerCase()] = true; });
  var created = [], existing = [];
  list.forEach(function (a) {
    var last4 = cleanLast4_(a.last4);
    if (!last4) throw new Error(tr_('err.pmLast4'));
    var kind = String(a.kind || '');
    if (!isAccountKind_(kind)) throw new Error(tr_('err.pmType'));
    var bankName = String(a.bank || '').trim().slice(0, 60);
    if (!bankName) throw new Error(tr_('err.pmBank'));
    var already = pms.find(function (pm) { return covKey_(pm.last_4) === covKey_(last4) && !isPracticeAccount_(pm); }) || created.filter(function (c) { return c.last_4 === last4; })[0];
    if (already) { existing.push({ id: already.id, nickname: already.nickname, last_4: last4 }); return; }
    var bank = getAllRows('Banks').find(function (b) { return plainNickname_(b.name) === plainNickname_(bankName); }) || addBank({ name: bankName });
    var nickname = uniqueAccountName_(autoAccountAlias_(bankShortName_(bank.name), kind, last4, true, lang), last4, taken);
    var pm = { id: Utilities.getUuid(), nickname: nickname, type: accountKindType_(kind), bank_id: bank.id, last_4: '',
      alias_kind: kind, alias_auto: 'yes', alias_show_last4: 'yes' };
    appendRowObject('Payment Methods', pm);
    var headers = getHeaders(sheet);
    setPaymentMethodLast4_(sheet, headers, findRowIndexById(sheet, headers, pm.id), last4);
    created.push({ id: pm.id, nickname: nickname, type: pm.type, bank: bank.name, last_4: last4 });
  });
  if (created.length) bumpStructureVersion_();
  return { created: created, existing: existing };
}

/**
 * New accounts from a spreadsheet (owner, 2026-11-21: "importing new data should allow the user to add new accounts if they are identified").
 *
 * Import from another app (and a bank's CSV / Excel in Statements) names its account itself: a name in the file's account column
 * ("Wallet": "BBVA Visa", "Savings"…) that is none of the person's accounts starts on "New account: <name>" on the phone, with a guessed
 * type the person can change; a file without that column can pick "New account…" for the whole file. Such a statement arrives with the
 * key NEW-<something> and `newAccount: { name, type, last4, bankId, currencies, unhideId }`.
 *
 * Nothing is created while planning or in the dry run (a stand-in with the made-up id "new:<key>" plays the account: no entry carries
 * it, so nothing matches it). The REAL save creates the accounts first — or reuses one of the same name, or shows again the hidden one
 * the phone named — rewrites each statement's key to the account's real key (the same one the phone computes for a known account, so the
 * same file uploaded later is recognised line by line), and saves. A save that fails takes the accounts it made away again; a saved one
 * records them for Undo, which removes each one nothing else uses by then and hides again the one it showed.
 */
var STMT_NEW_ACCOUNT_PREFIX_ = 'NEW-';
var STMT_NEW_ACCOUNT_TYPES_ = ['debit', 'credit', 'cash', 'wallet'];

function stmtIsNewAccount_(s) {
  return !!(s && s.newAccount && typeof s.newAccount === 'object' && String(s.key || '').indexOf(STMT_NEW_ACCOUNT_PREFIX_) === 0);
}

function stmtNewAccountSpec_(s) {
  var n = s.newAccount || {};
  var type = String(n.type || '').toLowerCase();
  return {
    name: String(n.name || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    type: STMT_NEW_ACCOUNT_TYPES_.indexOf(type) !== -1 ? type : 'debit',
    last4: /^\d{4}$/.test(String(n.last4 || '')) ? String(n.last4) : '',
    bankId: String(n.bankId || ''),
    bankName: String(n.bankName || '').replace(/\s+/g, ' ').trim().slice(0, 60),   // a bank of the catalogue the person picked: found or added
    rail: n.rail === 'yape' || n.rail === 'plin' ? n.rail : '',
    currencies: (Array.isArray(n.currencies) ? n.currencies : []).map(function (c) { return String(c || '').toUpperCase(); }).filter(function (c) { return /^[A-Z]{3}$/.test(c); }),
    unhideId: String(n.unhideId || '')
  };
}

// The account a planned (not yet created) statement stands for, in the plan and the dry run.
function stmtNewAccountStandIn_(s) {
  var n = stmtNewAccountSpec_(s);
  return { id: 'new:' + s.key, nickname: n.name, type: n.type, last_4: '', newAccount: true };
}

// The key a spreadsheet statement of this account carries (the phone's tableAccountKey): its last four digits, else ACCT-<id>.
function stmtTableKeyForPm_(pm) {
  var last = String(pm.last_4 || '').trim();
  return /^\d{1,4}$/.test(last) ? ('0000' + last).slice(-4) : STMT_ACCT_KEY_PREFIX_ + pm.id;
}

// Creates (or finds, or shows again) the account of each NEW- statement. Returns { byKey: { key: pm }, created: [pm], shown: [pm] }.
function stmtMakeFileAccounts_(news) {
  var out = { byKey: {}, created: [], shown: [] };
  var byName = {};   // within one save, one name = one account (two files naming "BBVA" make one)
  news.forEach(function (s) {
    var n = stmtNewAccountSpec_(s);
    var nameKey = n.name.toLowerCase();
    if (byName[nameKey]) { out.byKey[s.key] = byName[nameKey]; return; }
    if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
    var pms = getAllRows('Payment Methods');
    var hidden = n.unhideId && pms.find(function (p) { return String(p.id) === n.unhideId && String(p.hidden || '') === 'yes'; });
    var same = pms.find(function (p) { return String(p.nickname).trim().toLowerCase() === nameKey; });
    var pm;
    if (hidden) {
      setPaymentMethodHidden({ id: hidden.id, hidden: false });
      pm = hidden;
      out.shown.push(pm);
    } else if (same) {
      if (String(same.hidden || '') === 'yes') { setPaymentMethodHidden({ id: same.id, hidden: false }); out.shown.push(same); }
      pm = same;   // the same name saved twice, or another phone made it meanwhile: never a second account
    } else {
      // Digits another account already has would send this file's lines to that account: the new one is made without them.
      var last4 = n.last4 && !pms.some(function (p) { return covKey_(p.last_4) === covKey_(n.last4); }) ? n.last4 : '';
      var bankId = n.bankId && getAllRows('Banks').some(function (b) { return String(b.id) === n.bankId; }) ? n.bankId : '';
      if (!bankId && n.bankName) bankId = (getAllRows('Banks').find(function (b) { return plainNickname_(b.name) === plainNickname_(n.bankName); }) || addBank({ name: n.bankName })).id;
      var payload = { nickname: n.name, type: n.type, bank_id: bankId, last_4: last4 };
      if ((n.type === 'debit' || n.type === 'credit') && n.currencies.length) payload.currencies = n.currencies;
      pm = savePaymentMethod(payload);
      out.created.push(pm);
    }
    byName[nameKey] = pm;
    out.byKey[s.key] = pm;
  });
  if (out.created.length || out.shown.length) { bumpStructureVersion_(); if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods']; }
  return out;
}

// Yape rides on a BCP bank account (yape_pen / yape_usd by currency); Plin on a Scotiabank / BBVA / Interbank one (plin_pen, or one more
// in plin_pen_more when the main one is another account). An account the rail cannot ride on is left alone (report.railSkipped).
// Returns the settings it changed: [{ key, from, to }].
function stmtLinkRail_(rail, pm, currency, report) {
  if (!pm || !pm.id) return [];
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  var fresh = getAllRows('Payment Methods').find(function (p) { return String(p.id) === String(pm.id); });
  if (!fresh || !railAllowsAccount_(rail, fresh)) { report.railSkipped = (report.railSkipped || []).concat([rail]); return []; }
  var settings = getSettingsMap(), id = String(fresh.id), out = [];
  var set = function (key, value) { var from = String(settings[key] || ''); if (from === value) return; setSetting_(key, value); out.push({ key: key, from: from, to: value }); };
  if (rail === 'yape') set(String(currency || '').toUpperCase() === 'USD' ? 'yape_usd' : 'yape_pen', id);
  else if (!settings.plin_pen) set('plin_pen', id);
  else if (String(settings.plin_pen) !== id && plinMoreIds_(settings).indexOf(id) === -1) set(PLIN_MORE_KEY_, plinMoreIds_(settings).concat([id]).join(','));
  if (out.length) report.railsLinked = (report.railsLinked || []).concat([{ rail: rail, account: fresh.nickname }]);
  return out;
}

// A save that failed after the accounts were made: they go again (only while nothing uses them), the shown ones are hidden again.
function stmtUnmakeFileAccounts_(made) {
  made.created.forEach(function (pm) { try { if (paymentMethodUsage_(String(pm.id)) === 0) deletePaymentMethod({ id: pm.id }); } catch (e) { /* leave it */ } });
  made.shown.forEach(function (pm) { try { setPaymentMethodHidden({ id: pm.id, hidden: true }); } catch (e) { /* leave it */ } });
}

// Undo of an upload: the accounts it made go when nothing uses them any more (the upload's own entries and rows are gone by then);
// one in use since (the person filed an entry there) stays. The ones it showed again are hidden again.
function stmtUndoFileAccounts_(changes, res) {
  var made = changes.filter(function (c) { return c.sheet === 'Payment Methods' && c.field === '__created__'; });
  var shown = changes.filter(function (c) { return c.sheet === 'Payment Methods' && c.field === 'hidden'; });
  // Yape / Plin links this upload set: back to what they were, unless changed since. First, so an account it made is free to go.
  changes.filter(function (c) { return c.sheet === 'Settings' && c.field === 'value'; }).forEach(function (c) {
    if (String(getSettingsMap()[c.row_id] || '') === String(c.new_value)) { setSetting_(c.row_id, c.old_value); res.railsUnlinked = (res.railsUnlinked || 0) + 1; }
  });
  if (!made.length && !shown.length) return;
  if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods'];
  var there = {};
  getAllRows('Payment Methods').forEach(function (p) { there[String(p.id)] = p; });
  made.forEach(function (c) {
    if (!there[c.row_id]) return;
    if (paymentMethodUsage_(String(c.row_id)) === 0) {
      try { deletePaymentMethod({ id: c.row_id }); res.accountsRemoved = (res.accountsRemoved || 0) + 1; } catch (e) { res.accountsKept = (res.accountsKept || 0) + 1; }
    } else res.accountsKept = (res.accountsKept || 0) + 1;
  });
  shown.forEach(function (c) {
    var p = there[c.row_id];
    if (p && String(p.hidden || '') !== 'yes') { setPaymentMethodHidden({ id: c.row_id, hidden: true }); res.accountsHiddenAgain = (res.accountsHiddenAgain || 0) + 1; }
  });
}

/**
 * The action the phone calls. Statements without a new account go straight to the save (applyStatementDecisionsCore_, StatementApply.gs).
 */
function applyStatementDecisions(payload) {
  var stmts = (payload && payload.statements) || [];
  var news = stmts.filter(stmtIsNewAccount_);
  var railsOnly = !news.length && stmts.some(function (s) { return s && (s.rail === 'yape' || s.rail === 'plin'); });
  if (!news.length && !railsOnly) return applyStatementDecisionsCore_(payload);
  if (news.length > 20) throw new Error(tr_('err.tooManyAccounts'));
  if (news.some(function (s) { var l4 = String((s.newAccount || {}).last4 || ''); return l4 && !/^\d{4}$/.test(l4); })) throw new Error(tr_('err.pmLast4'));
  news.forEach(function (s) { if (!stmtNewAccountSpec_(s).name) throw new Error(tr_('err.enterName')); });
  if (payload.dryRun !== false) return applyStatementDecisionsCore_(payload);
  var made = stmtMakeFileAccounts_(news);
  // A "move" to one of these accounts names its stand-in (new:<key>): it now goes to the real account.
  var realIds = {};
  news.forEach(function (s) { realIds['new:' + s.key] = made.byKey[s.key].id; });
  var actions = (payload.actions || []).map(function (a) {
    if (!a || (!realIds[a.otherPmId] && !realIds[a.herePmId])) return a;
    var c = Object.assign({}, a);
    if (realIds[a.otherPmId]) c.otherPmId = realIds[a.otherPmId];
    if (realIds[a.herePmId]) c.herePmId = realIds[a.herePmId];
    return c;
  });
  var real = Object.assign({}, payload, { actions: actions, statements: stmts.map(function (s) {
    if (!stmtIsNewAccount_(s)) return s;
    var c = Object.assign({}, s, { key: stmtTableKeyForPm_(made.byKey[s.key]) });
    delete c.newAccount;
    return c;
  }) });
  var report;
  try { report = applyStatementDecisionsCore_(real); } catch (err) { stmtUnmakeFileAccounts_(made); throw err; }
  var now = nowTimestamp_(), rows = [];
  // Yape / Plin in the file: the account behind it now carries it (owner, 2026-11-21), recorded so Undo puts the old link back.
  real.statements.forEach(function (s, i) {
    var rail = stmtIsNewAccount_(stmts[i]) ? stmtNewAccountSpec_(stmts[i]).rail : (stmts[i].rail === 'yape' || stmts[i].rail === 'plin' ? stmts[i].rail : '');
    if (!rail) return;
    var pm = stmtIsNewAccount_(stmts[i]) ? made.byKey[stmts[i].key] : stmtPmForKey_(getAllRows('Payment Methods'), s.key);
    var cur = ((s.lines || [])[0] || {}).currency;
    stmtLinkRail_(rail, pm, cur, report).forEach(function (c) { rows.push({ id: Utilities.getUuid(), batch_id: report.batchId, sheet: 'Settings', row_id: c.key, field: 'value', old_value: c.from, new_value: c.to, created_at: now }); });
  });
  made.created.forEach(function (pm) { rows.push({ id: Utilities.getUuid(), batch_id: report.batchId, sheet: 'Payment Methods', row_id: pm.id, field: '__created__', old_value: '', new_value: '', created_at: now }); });
  made.shown.forEach(function (pm) { rows.push({ id: Utilities.getUuid(), batch_id: report.batchId, sheet: 'Payment Methods', row_id: pm.id, field: 'hidden', old_value: 'yes', new_value: '', created_at: now }); });
  if (rows.length) { ensureStatementChangesSheet_(); appendRowsBulk_('Statement Changes', rows); }
  // `incomplete`: a bank account or card with no bank or no last 4 digits yet — the saved message offers to complete it (owner, 2026-11-21).
  report.accountsCreated = made.created.concat(made.shown).map(function (pm) {
    return { id: pm.id, nickname: pm.nickname, incomplete: (pm.type === 'debit' || pm.type === 'credit') && (!pm.bank_id || !String(pm.last_4 || '').trim()) };
  });
  return report;
}
