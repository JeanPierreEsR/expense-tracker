/**
 * Bank accounts in the welcome questions (friends & family rollout, stage 4b+): the bank catalogue, automatic
 * account names ("aliases"), saving the accounts a new person typed in, and the Yape / Plin links.
 *
 * Bank catalogue: "Main" banks first, then "Other banks", each list alphabetical. The app reads it from getMeta
 * (`bankCatalog`) so the welcome screen and the server never disagree about names.
 *
 * Account names: a person may type an alias (optional); with none, the app builds one:
 *   {bank short name} {soles | dollars | credit | salary}  +  " (1234)" only when they asked to show the last 4 digits.
 * `alias_kind` / `alias_auto` / `alias_show_last4` (columns of the Payment Methods sheet) remember how a name was made,
 * so that when EVERY bank account still has an automatic name, changing the app's language renames them all in the new
 * language. As soon as one name was typed or edited by hand, nothing is renamed automatically.
 *
 * Yape and Plin are not accounts: they ride on a bank account. Yape works ONLY with BCP accounts; Plin works with other banks and NOT
 * with BCP. (Wallets of other banks behave the same way: no money of their own, so linking them is never needed.) Settings `yape_pen`, `yape_usd`, `plin_pen`, `plin_usd`
 * hold the id of the account each one is linked to, per currency (changeable any time). An account that is not linked
 * falls back to the owner's original names (BCP_ACCOUNTS / PLIN_ACCOUNTS), which `ensureRailDefaults_` also writes into
 * the settings once, for the owner's own copy.
 *
 * Credit cards are treated as two-currency (soles and dollars) by default; nothing about that is stored.
 */

var BANKS_MAIN_ = [
  { name: 'BBVA', short: 'BBVA' },
  { name: 'BCP', short: 'BCP' },
  { name: 'Interbank', short: 'Interbank' },
  { name: 'Scotiabank', short: 'Scotiabank' }
];
var BANKS_OTHER_ = [
  { name: 'Alfin Banco', short: 'Alfin' },
  { name: 'BanBif', short: 'BanBif' },
  { name: 'Banco de la Nación', short: 'Nación' },
  { name: 'Banco Falabella', short: 'Falabella' },
  { name: 'Banco GNB', short: 'GNB' },
  { name: 'Banco Pichincha', short: 'Pichincha' },
  { name: 'Banco Ripley', short: 'Ripley' },
  { name: 'Caja Arequipa', short: 'Caja Arequipa' },
  { name: 'Caja Cusco', short: 'Caja Cusco' },
  { name: 'Caja Huancayo', short: 'Caja Huancayo' },
  { name: 'Caja Piura', short: 'Caja Piura' },
  { name: 'Caja Trujillo', short: 'Caja Trujillo' },
  { name: 'Citibank', short: 'Citibank' },
  { name: 'Mibanco', short: 'Mibanco' }
];

// Sueldo = the account a salary is paid into (very common in Peru; freelancers may have none).
var ACCOUNT_KINDS_ = ['debit_pen', 'debit_usd', 'credit', 'sueldo'];
var ACCOUNT_ALIAS_WORDS_ = {
  en: { debit_pen: 'soles', debit_usd: 'dollars', credit: 'credit', sueldo: 'salary' },
  es: { debit_pen: 'soles', debit_usd: 'dólares', credit: 'crédito', sueldo: 'sueldo' }
};
// Plin exists only in soles (owner, 2026-10-23); an old `plin_usd` setting is still read by railAccount_ but never written.
var RAIL_LINK_KEYS_ = ['yape_pen', 'yape_usd', 'plin_pen'];

function sortedBankList_(list) {
  return list.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
}

// What the welcome screen shows: two alphabetical groups, plus the alias words in both languages.
function getBankCatalog_() {
  return { main: sortedBankList_(BANKS_MAIN_), other: sortedBankList_(BANKS_OTHER_), words: ACCOUNT_ALIAS_WORDS_ };
}

function bankCatalogNames_() {
  return sortedBankList_(BANKS_MAIN_).concat(sortedBankList_(BANKS_OTHER_)).map(function (b) { return b.name; });
}

function bankShortName_(bankName) {
  var all = BANKS_MAIN_.concat(BANKS_OTHER_);
  var lower = String(bankName || '').trim().toLowerCase();
  for (var i = 0; i < all.length; i++) if (all[i].name.toLowerCase() === lower) return all[i].short;
  return String(bankName || '').trim();
}

function accountKindType_(kind) { return kind === 'credit' ? 'credit' : 'debit'; }

// {bank} {word} (1234) — the digits only when asked for.
function autoAccountAlias_(bankShort, kind, last4, showLast4, lang) {
  var words = ACCOUNT_ALIAS_WORDS_[lang] || ACCOUNT_ALIAS_WORDS_.en;
  var name = String(bankShort) + ' ' + words[kind];
  if (showLast4 && /^\d{4}$/.test(String(last4 || ''))) name += ' (' + last4 + ')';
  return name;
}

// Names are unique (case-insensitive). A clash gets the last 4 digits, then a number.
function uniqueAccountName_(name, last4, takenLower) {
  var candidate = name;
  var tryName = function (n) { return !takenLower[n.toLowerCase()]; };
  if (!tryName(candidate) && /^\d{4}$/.test(String(last4 || '')) && candidate.indexOf('(' + last4 + ')') === -1) candidate = name + ' (' + last4 + ')';
  var n = 2;
  while (!tryName(candidate)) { candidate = name + ' ' + n; n++; }
  takenLower[candidate.toLowerCase()] = true;
  return candidate;
}

// Accent- and case-insensitive name comparison ("BCP dólares" = "BCP dolares").
function plainNickname_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// The three columns that remember how an account's name was made (older sheets get them on first use).
function ensurePaymentMethodAliasColumns_() {
  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var added = false;
  ['alias_kind', 'alias_auto', 'alias_show_last4'].forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sheet.getRange(1, headers.length + 1).setValue(col);
      headers.push(col);
      added = true;
    }
  });
  if (added) { if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods']; bumpStructureVersion_(); }
}

function cleanLast4_(v) {
  var s = String(v == null ? '' : v).trim();
  if (s && !/^\d{4}$/.test(s)) throw new Error(tr_('err.pmLast4'));
  return s;
}

/**
 * The accounts typed in the welcome questions, saved in one go (after the person pressed the final button).
 * payload: { batch, lang, accounts: [{ cid, bank, kind, alias, last4, showLast4 }],
 *            links: { yape_pen, yape_usd, plin_pen }  // each = a cid or ''
 * `batch` makes a retry harmless: a batch already saved is not saved twice.
 */
function saveOnboardingAccounts(payload) {
  payload = payload || {};
  var batch = String(payload.batch || '').slice(0, 80);
  if (batch && String(getSettingsMap().accounts_batch || '') === batch) return { already: true, accounts: [] };
  var list = Array.isArray(payload.accounts) ? payload.accounts : [];
  if (list.length > 40) throw new Error(tr_('err.tooManyAccounts'));
  var lang = normalizeLang_(payload.lang) || currentLang_();

  ensurePaymentMethodAliasColumns_();
  var sheet = getSheet('Payment Methods');
  var taken = {};
  getAllRows('Payment Methods').forEach(function (pm) { taken[String(pm.nickname).trim().toLowerCase()] = true; });

  var created = [], idByCid = {};
  list.forEach(function (a) {
    var kind = String(a.kind || '');
    if (ACCOUNT_KINDS_.indexOf(kind) === -1) throw new Error(tr_('err.pmType'));
    var bankName = String(a.bank || '').trim().slice(0, 60);
    if (!bankName) throw new Error(tr_('err.pmBank'));
    var bank = addBank({ name: bankName });
    var last4 = cleanLast4_(a.last4);
    var show = !!a.showLast4 && !!last4;
    var alias = String(a.alias || '').trim().slice(0, 40);
    var nickname, auto;
    if (alias) { nickname = alias + (show ? ' (' + last4 + ')' : ''); auto = false; }
    else { nickname = autoAccountAlias_(bankShortName_(bank.name), kind, last4, show, lang); auto = true; }
    nickname = uniqueAccountName_(nickname, last4, taken);
    var pm = { id: Utilities.getUuid(), nickname: nickname, type: accountKindType_(kind), bank_id: bank.id, last_4: '',
      alias_kind: kind, alias_auto: auto ? 'yes' : 'no', alias_show_last4: show ? 'yes' : 'no' };
    appendRowObject('Payment Methods', pm);
    if (last4) setPaymentMethodLast4_(sheet, getHeaders(sheet), findRowIndexById(sheet, getHeaders(sheet), pm.id), last4);
    pm.last_4 = last4;
    idByCid[String(a.cid)] = pm.id;
    created.push({ cid: String(a.cid), id: pm.id, nickname: nickname, type: pm.type, bank_id: bank.id, last_4: last4 });
  });

  var links = payload.links || {};
  var createdRows = getAllRows('Payment Methods');
  RAIL_LINK_KEYS_.forEach(function (key) {
    var id = idByCid[String(links[key])];
    var pm = id && createdRows.find(function (p) { return String(p.id) === id; });
    // A link the rail cannot work with (Yape only on BCP, Plin never on BCP) is simply not saved.
    if (pm && railAllowsAccount_(key.split('_')[0], pm)) setSetting_(key, id);
  });
  if (batch) setSetting_('accounts_batch', batch);
  bumpStructureVersion_();
  return { already: false, accounts: created };
}

// Welcome step 3 (optional): the investment platforms the person names (type 'investment', no balance). Safe to send twice (batch id),
// and a name that already exists is reused, never duplicated (addPaymentMethod).
function saveOnboardingPlatforms(payload) {
  payload = payload || {};
  var batch = String(payload.batch || '').slice(0, 80);
  if (batch && String(getSettingsMap().platforms_batch || '') === batch) return { already: true, platforms: [] };
  var names = Array.isArray(payload.names) ? payload.names : [];
  if (names.length > 20) throw new Error(tr_('err.tooManyPlatforms'));
  var created = [];
  names.forEach(function (n) {
    var name = String(n || '').trim().slice(0, 40);
    if (!name) return;
    var pm = addPaymentMethod({ nickname: name, type: 'investment' });
    created.push({ id: pm.id, nickname: pm.nickname });
  });
  if (batch) setSetting_('platforms_batch', batch);
  bumpStructureVersion_();
  return { already: false, platforms: created };
}

// Yape works ONLY with BCP debit accounts. Plin works with other banks' accounts and NOT with BCP debit accounts — but a CREDIT CARD
// can pay through Plin whatever its bank (owner, 2026-10-19: Interbank lets him Plin with his card; he asked to offer every bank's cards).
function railAllowsAccount_(rail, pm) {
  var banks = getAllRows('Banks');
  var bank = banks.find(function (b) { return String(b.id) === String(pm.bank_id); });
  var isBcp = !!bank && String(bank.name).trim().toLowerCase() === 'bcp';
  if (rail === 'yape') return isBcp && pm.type !== 'credit';
  return pm.type === 'credit' || !isBcp;
}

// Yape and Plin ride on an account (a different one per currency); more → Accounts & cards changes it any time.
function saveRailLinks(payload) {
  payload = payload || {};
  var pms = getAllRows('Payment Methods');
  RAIL_LINK_KEYS_.forEach(function (key) {
    if (payload[key] === undefined) return;
    var id = String(payload[key] || '').trim();
    if (id) {
      var pm = pms.find(function (p) { return String(p.id) === id && p.type !== 'investment'; });
      if (!pm) throw new Error(tr_('err.pmNotFound'));
      var rail = key.split('_')[0];
      if (!railAllowsAccount_(rail, pm)) throw new Error(tr_(rail === 'yape' ? 'err.railYape' : 'err.railPlin'));
    }
    setSetting_(key, id);
  });
  var out = {};
  var s = getSettingsMap();
  RAIL_LINK_KEYS_.forEach(function (k) { out[k] = String(s[k] || ''); });
  return out;
}

// The account a Yape / Plin payment in `currency` goes through: the linked one, else the owner's original name.
function railAccount_(rail, currency, paymentMethods) {
  var id = String(getSettingsMap()[rail + '_' + String(currency).toLowerCase()] || '');
  if (id) {
    var linked = paymentMethods.find(function (pm) { return String(pm.id) === id; });
    if (linked) return linked;
  }
  // The owner's original names only apply to the owner's own copy and old installs. An installer copy has links or nothing.
  if (isFriendCopy_()) return null;
  var legacy = (rail === 'plin' ? PLIN_ACCOUNTS : BCP_ACCOUNTS)[currency];
  if (!legacy) return null;
  return paymentMethods.find(function (pm) { return plainNickname_(pm.nickname) === plainNickname_(legacy); }) || null;
}

// Owner's own copy (and any old install): Yape -> BCP soles / BCP dolares, Plin -> IBK soles / IBK dolares, written
// into the settings once so the Yape & Plin links show up (and can be changed) like anyone else's.
function ensureRailDefaults_() {
  if (isFriendCopy_()) return;
  var s = getSettingsMap();
  if (s.rail_defaults) return;
  var pms = getAllRows('Payment Methods');
  var wanted = { yape_pen: BCP_ACCOUNTS.PEN, yape_usd: BCP_ACCOUNTS.USD, plin_pen: PLIN_ACCOUNTS.PEN };
  Object.keys(wanted).forEach(function (key) {
    if (s[key]) return;
    var pm = pms.find(function (p) { return plainNickname_(p.nickname) === plainNickname_(wanted[key]); });
    if (pm) setSetting_(key, pm.id);
  });
  setSetting_('rail_defaults', 'yes');
}

/**
 * Language changed: rename the accounts whose names were all made automatically. If even one bank account has a name
 * that was typed or edited by hand (or predates this feature), nothing is renamed — the person has seen those names
 * and may have changed some on purpose. Wallets, cash and investment platforms are not bank accounts and are ignored.
 */
function relocalizeAutoAliases_(lang) {
  lang = normalizeLang_(lang);
  if (!lang) return 0;
  var rows = getAllRows('Payment Methods');
  var bankAccounts = rows.filter(function (pm) { return pm.type === 'debit' || pm.type === 'credit'; });
  if (!bankAccounts.length) return 0;
  var allAuto = bankAccounts.every(function (pm) { return String(pm.alias_auto) === 'yes' && ACCOUNT_KINDS_.indexOf(String(pm.alias_kind)) !== -1; });
  if (!allAuto) return 0;

  var banks = getAllRows('Banks');
  var isBank = {};
  bankAccounts.forEach(function (pm) { isBank[String(pm.id)] = true; });
  var taken = {};
  rows.forEach(function (pm) { if (!isBank[String(pm.id)]) taken[String(pm.nickname).trim().toLowerCase()] = true; });

  var sheet = getSheet('Payment Methods');
  var headers = getHeaders(sheet);
  var changed = 0;
  bankAccounts.forEach(function (pm) {
    var bank = banks.find(function (b) { return String(b.id) === String(pm.bank_id); });
    var name = autoAccountAlias_(bankShortName_(bank ? bank.name : ''), String(pm.alias_kind), String(pm.last_4 || ''), String(pm.alias_show_last4) === 'yes', lang);
    name = uniqueAccountName_(name, String(pm.last_4 || ''), taken);
    if (name !== pm.nickname) {
      setCellByRow_(sheet, headers, findRowIndexById(sheet, headers, pm.id), 'nickname', name);
      changed++;
    }
  });
  if (changed) { if (ROWS_MEMO_) delete ROWS_MEMO_['Payment Methods']; bumpStructureVersion_(); }
  return changed;
}
