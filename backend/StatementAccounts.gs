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
    if (ACCOUNT_KINDS_.indexOf(kind) === -1) throw new Error(tr_('err.pmType'));
    var bankName = String(a.bank || '').trim().slice(0, 60);
    if (!bankName) throw new Error(tr_('err.pmBank'));
    var already = pms.find(function (pm) { return covKey_(pm.last_4) === covKey_(last4); }) || created.filter(function (c) { return c.last_4 === last4; })[0];
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
