/**
 * Milestone 3 — applying a REVIEWED statement upload, and undoing it.
 *
 * The phone sends the statements' lines plus the owner's decisions; nothing
 * here trusts amounts, dates or accounts from the client — everything an
 * entry needs is recomputed from the lines. One upload = one batch:
 *   - new entries carry `import_batch_id = batch` (transfers/fees confirmed,
 *     purchases pending) and a stable external_id ('stmt-' + line key);
 *   - changes to EXISTING entries (assigning an account, completing a
 *     transfer, filling a merchant) are written to `Statement Changes`
 *     (old + new value) so they can be reversed;
 *   - every decided line is remembered in `Statement Lines` (by line key), so
 *     re-uploading an overlapping statement never lists it again;
 *   - each statement is recorded in `Statement Uploads` (drives the
 *     coverage list).
 * Dry-run by default (payload.dryRun !== false writes). Idempotent: an entry
 * whose external_id already exists is skipped.
 *
 * Actions (each references a line as { stmt: index, line: index }):
 *   record_transfer  { out, in }            new transfer entry (confirmed)
 *   record_fee       { stmt, line }         new expense, category Bank fees (confirmed)
 *   add_purchase     { stmt, line, category?, description? }   new expense (pending)
 *   cancel_charge    { stmt, line, entryId }   a reversal on a card: adds a pending NEGATIVE expense (same category) that cancels the charge
 *   add_income       { stmt, line, category?, description? }   new income (pending) — e.g. interest earned
 *   add_history_pending { stmt, line }     "Send to Needs review": a PENDING expense (money out) or income (money in), no category
 *   add_history_investment { stmt, line, platformId? }   money into an investment platform (positive) or out of one (a withdrawal:
 *                    NEGATIVE amount), confirmed, filed under "Investments"; the platform is optional
 *   record_transfer_leg { stmt, line }      ONE side of a transfer whose other end is not in the app: money out has From = this
 *                    account and To empty, money in the reverse; the other statement completes it later
 *   record_exchange  { out, in }            a currency exchange: the line that left and the line that arrived in ANOTHER currency
 *                    become two one-sided transfers (confirmed) — never spending or income
 *   add_history_refund { stmt, line }     a refund that does NOT cancel a charge of its own month: confirmed income in "Refunds"
 *   add_history_expense / add_history_reversal / add_history_income   { stmt, line }   "Fill my history": a new expense
 *                    (a reversal is a NEGATIVE expense) or income, CONFIRMED, no category — the owner approved the whole
 *                    batch once and can undo it in one step (StatementHistory.gs builds these)
 *   match            { stmt, line, entryId, overwriteAccount? } line IS that entry
 *   complete_transfer{ stmt, line, entryId, side } fills the blank end of a transfer
 *   assign_account   { stmt, line, entryId }  entry has no account yet
 *   link             { stmt, line, entryId }  remember a matched line (no change)
 *   ignore / wait    { stmt, line }
 *   set_balance      { stmt, currency }      the statement's closing balance becomes the
 *                                            account's registered balance — only when the
 *                                            statement is NEWER than the current one
 *                                            Optional { gap, app_balance }: the leftover difference the review screen
 *                                            showed ("unexplained"). Any non-zero gap is saved
 *                                            as a note in `Statement Gaps` — never an entry
 *                                            (see below).
 */

var STATEMENT_LINES_COLUMNS_ = ['id', 'line_key', 'account_key', 'period_end', 'date', 'description',
  'amount', 'currency', 'outcome', 'entry_id', 'batch_id', 'created_at'];
var STATEMENT_CHANGES_COLUMNS_ = ['id', 'batch_id', 'sheet', 'row_id', 'field', 'old_value', 'new_value', 'created_at'];
// Statement Gaps: when a balance is set from a statement, whatever difference the
// review could not explain would otherwise vanish into the reset. Each non-zero
// one is saved here as a NOTE (open until the owner marks it resolved). It is its
// own sheet on purpose — never an Entry — so it can't touch totals, budgets,
// balances or loans. Informational only: `gap` and `app_balance` are the figures
// the phone showed, stored as-is. Undo removes the notes its upload created.
var STATEMENT_GAPS_COLUMNS_ = ['id', 'payment_method_id', 'account_key', 'account_label', 'currency', 'period_end',
  'closing', 'app_balance', 'gap', 'status', 'note', 'batch_id', 'created_at', 'resolved_at'];
function ensureStatementGapsSheet_() {
  ensureStatementSheet_('Statement Gaps', STATEMENT_GAPS_COLUMNS_, ['account_key', 'period_end', 'created_at', 'resolved_at']);
}

var STATEMENT_HANDLED_OUTCOMES_ = { matched: true, added: true, recorded: true, completed: true, ignored: true, reversed: true };

function ensureStatementSheet_(name, columns, textColumns) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(name)) return;
  var sheet = ss.insertSheet(name);
  var headerRange = sheet.getRange(1, 1, 1, columns.length);
  headerRange.setValues([columns]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  (textColumns || []).forEach(function (col) {
    sheet.getRange(1, columns.indexOf(col) + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}
function ensureStatementLinesSheet_() {
  ensureStatementSheet_('Statement Lines', STATEMENT_LINES_COLUMNS_, ['line_key', 'period_end', 'date', 'created_at']);
}
function ensureStatementChangesSheet_() {
  ensureStatementSheet_('Statement Changes', STATEMENT_CHANGES_COLUMNS_, ['old_value', 'new_value', 'created_at']);
}

function stmtHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
}

/**
 * A stable identity per statement line: account + date + amount + currency +
 * text + which repeat it is (two identical lines on one day are two lines).
 */
function stmtLineKeys_(accountKey, lines) {
  var seen = {};
  return (lines || []).map(function (l) {
    var base = [covKey_(accountKey), l.date, Number(l.amount).toFixed(2), l.currency,
      String(l.description || '').replace(/\s+/g, ' ').trim().toUpperCase()].join('|');
    seen[base] = (seen[base] || 0) + 1;
    return stmtHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, base + '|' + seen[base])).substring(0, 20);
  });
}

// A spreadsheet statement (CSV/Excel) names its account directly: the key is the account's last four digits when it has them,
// otherwise ACCT-<payment method id> (docs/statement-table.js, statements.js). Same key everywhere a statement is looked up.
var STMT_ACCT_KEY_PREFIX_ = 'ACCT-';

// An import (another app's export) can be saved with NO account: the person has none set up yet, or did not want to pick one. Its
// statement carries this key; every entry it makes has an empty payment_method_id (like the Spendee import's), and the account can be
// set later from the entry. Resolves to a stand-in whose id is '' so the entries come out account-less.
var STMT_NO_ACCOUNT_KEY_ = 'NOACCOUNT';

function stmtPmForKey_(pms, key) {
  if (String(key) === STMT_NO_ACCOUNT_KEY_) return { id: '', nickname: tr_('stmt.noAccountName'), type: 'debit', last_4: '', noAccount: true };
  if (String(key).indexOf(STMT_ACCT_KEY_PREFIX_) === 0) {
    var id = String(key).substring(STMT_ACCT_KEY_PREFIX_.length);
    return pms.find(function (pm) { return String(pm.id) === id; }) || null;
  }
  if (String(key).indexOf('AHORRA-') === 0) {
    return pms.find(function (pm) { return String(pm.nickname).toLowerCase().replace(/[^a-z]/g, '').indexOf('ahorra') === 0; }) || null;
  }
  var k = covKey_(key);
  return pms.find(function (pm) { return covKey_(pm.last_4) === k && k; }) || null;
}

function stmtTitleCase_(text) {
  return String(text || '').toLowerCase().replace(/\b[a-zñáéíóú]/g, function (c) { return c.toUpperCase(); });
}

function stmtCleanDescription_(text) {
  return stmtTitleCase_(String(text || '').replace(/\*/g, ' ').replace(/\s+(LIMA\s+)?PER$/i, '').replace(/\s+/g, ' ').trim());
}

function stmtFeeDescription_(text) {
  var d = String(text || '');
  if (/ITF/i.test(d)) return 'ITF (bank transaction tax)';
  if (/SEGURO/i.test(d)) return 'Seguro de desgravamen';
  if (/INTER[EÉ]S/i.test(d)) return 'Interés compensatorio';
  return stmtCleanDescription_(d);
}

// Appends many rows in one write (appendRow per row is far too slow for a
// whole statement).
function appendRowsBulk_(sheetName, objs) {
  if (!objs.length) return;
  if (sheetName === 'Statement Lines') STMT_COVERAGE_MEMO_ = null;
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var rows = objs.map(function (o) { return headers.map(function (h) { return o[h] !== undefined ? o[h] : ''; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/**
 * Foreign-currency months among the entries a save creates that have no exchange rate of their own yet, so the phone can
 * say so. Totals still work (they use the closest earlier rate); `noRate` lists currencies with no rate at all, whose
 * entries cannot be converted until one is set under More → Exchange rates.
 */
function stmtRateNeeds_(creations) {
  var main = homeCurrency_(), seen = {}, months = [], noRate = {};
  creations.forEach(function (e) {
    var cur = String(e.currency || main).toUpperCase();
    if (cur === main) return;
    var month = String(e.date).substring(0, 7), k = cur + '|' + month;
    if (seen[k]) return;
    seen[k] = true;
    if (getExchangeRate(cur, month)) return;
    if (getLatestRateOnOrBefore_(cur, month) === null) noRate[cur] = true;
    months.push({ currency: cur, month: month });
  });
  months.sort(function (x, y) { return x.month < y.month ? -1 : (x.month > y.month ? 1 : (x.currency < y.currency ? -1 : 1)); });
  return { months: months, noRate: Object.keys(noRate).sort() };
}

/**
 * payload: { dryRun, filename, statements: [{ key, kind, period, file_name, verified, balances, lines }],
 *            actions: [...] }
 */
function applyStatementDecisions(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var stmts = payload.statements || [];
  var actions = payload.actions || [];
  var report = { dryRun: dryRun, batchId: null, created: { transfers: 0, fees: 0, purchases: 0, income: 0, reversals: 0 }, changed: 0,
    linesRemembered: 0, statementsRecorded: 0, skippedExisting: 0, warnings: [] };

  var pms = getAllRows('Payment Methods');
  var pmsById = rowsById_(pms);
  var openingsByPm = buildOpeningsByPm_(pms);
  var balanceOps = [];
  var gapOps = [];
  var catByName = {};
  var cats = getAllRows('Categories');
  var catsById = rowsById_(cats);
  cats.forEach(function (c) { catByName[c.type + ':' + c.name] = c.id; });
  // A spreadsheet line may carry the category its source app gave it (Spendee's "Category name"). The person's mapping
  // (payload.categoryMap, key "type:normalized name" -> an existing category id, "create", or "" = leave it) decides what the line
  // becomes; a name with no mapping falls back to a category of the same name, else the entry stays uncategorized (it waits in
  // Tidy my history). New categories are only created in the write phase below, after everything has been validated, and each one
  // is recorded so Undo can remove it again (backend/StatementCategories.gs).
  var categoryMap = (payload && payload.categoryMap) || {};
  var categoryNames = (payload && payload.categoryNames) || {};   // key -> the name the person wants the category to have (a new one, or a rename)
  var renameCandidates = {};                                      // key -> id of an existing category the person mapped a name to
  var nameIndex = categoryNameIndex_(cats, false);
  var nameIndexAll = categoryNameIndex_(cats, true);
  var newCategories = {};   // placeholder id -> { name, type }
  var categoryMissedNames = {};
  function lineCategory(type, text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return { id: '', text: '' };
    var k = type + ':' + catNameNorm_(t);
    var choice = categoryMap[k];
    if (choice === '') return { id: '', text: t };                                   // the person chose to leave it
    if (choice && choice !== 'create' && catsById[choice] && catsById[choice].type === type) { renameCandidates[k] = choice; return { id: choice, text: t }; }
    if (nameIndex[k]) return { id: nameIndex[k], text: t };
    if (choice === undefined) return { id: '', text: t };                            // no mapping given: the old behaviour
    if (nameIndexAll[k]) return { id: nameIndexAll[k], text: t };                    // a hidden category of that name: use it, do not clash
    var ph = 'new-category:' + k;
    if (!newCategories[ph]) newCategories[ph] = { name: String(categoryNames[k] || t).replace(/\s+/g, ' ').trim().slice(0, 40) || t.slice(0, 40), type: type };   // the name the person chose, else the spelling of the first line that names it
    return { id: ph, text: t };
  }
  // A bank's line carries no category: take the one the person already chose for the same place, or for similar places
  // (CategoryFollow.gs). One read of the entries, made only when a line needs it, before this batch writes anything.
  var guessScan = null;
  function guessLineCategory(description) {
    if (!guessScan) guessScan = scanFollow_();
    var s = categorySuggestion_(guessScan, stmtMerchantKey_(description));
    return s ? s.categoryId : '';
  }
  function countLineCategory(lc) {
    if (!lc.text) return;
    if (lc.id) report.categoriesFiled = (report.categoriesFiled || 0) + 1;
    else { report.categoriesMissed = (report.categoriesMissed || 0) + 1; categoryMissedNames[lc.text] = true; }
  }

  // Lines, keys, accounts.
  var keys = [], accounts = [];
  stmts.forEach(function (s) {
    keys.push(stmtLineKeys_(s.key, s.lines));
    accounts.push(stmtPmForKey_(pms, s.key));
  });
  var storedRows = null;
  function line(ref) {
    if (ref.stored) {
      // A line remembered from an earlier upload (left "waiting").
      if (!storedRows) { ensureStatementLinesSheet_(); storedRows = {}; getAllRows('Statement Lines').forEach(function (r) { storedRows[r.line_key] = r; }); }
      var row = storedRows[ref.stored];
      if (!row || row.outcome !== 'waiting') throw new Error(tr_('sa.laterNotWaiting'));
      return { s: { key: row.account_key, period: { end: row.period_end } },
        l: { date: row.date, description: row.description, amount: Number(row.amount), currency: row.currency },
        key: ref.stored, pm: stmtPmForKey_(pms, row.account_key), stmt: -1, idx: ref.stored };
    }
    var s = stmts[ref.stmt];
    if (!s || !s.lines[ref.line]) throw new Error(tr_('sa.unknownLine'));
    return { s: s, l: s.lines[ref.line], key: keys[ref.stmt][ref.line], pm: accounts[ref.stmt], stmt: ref.stmt, idx: ref.line };
  }

  // Entries, read once (values + row lookup) so changes are written column-wise.
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  var col = {};
  ['id', 'type', 'category_id', 'status', 'payment_method_id', 'to_payment_method_id', 'merchant', 'external_id', 'description', 'amount', 'currency', 'date'].forEach(function (h) { col[h] = headers.indexOf(h); });
  var rowById = {};
  values.forEach(function (r, i) { rowById[String(r[col.id])] = i; });
  var existingExternal = {};
  values.forEach(function (r) { if (r[col.external_id]) existingExternal[String(r[col.external_id])] = true; });

  var batchId = Utilities.getUuid();
  var now = nowTimestamp_();
  var today = now.substring(0, 10);
  var creations = [], changes = [], outcomes = [], usedLines = {};
  var colChanged = {};   // field -> true, so only touched columns are rewritten

  function useLine(L) {
    var k = L.stmt + ':' + L.idx;
    if (usedLines[k]) throw new Error(tr_('sa.twoActions'));
    usedLines[k] = true;
  }
  function remember(L, outcome, entryId) {
    outcomes.push({ id: Utilities.getUuid(), line_key: L.key, account_key: covKey_(L.s.key), period_end: (L.s.period || {}).end || '',
      date: L.l.date, description: L.l.description, amount: Number(L.l.amount), currency: L.l.currency,
      outcome: outcome, entry_id: entryId || '', batch_id: batchId, created_at: now });
  }
  function setCell(entryId, field, newValue) {
    var i = rowById[String(entryId)];
    if (i === undefined) throw new Error(tr_('sa.entryNotFound', { id: entryId }));
    var old = values[i][col[field]];
    if (String(old) === String(newValue)) return;
    changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Entries', row_id: String(entryId), field: field,
      old_value: String(old === undefined || old === null ? '' : old), new_value: String(newValue), created_at: now });
    values[i][col[field]] = newValue;
    colChanged[field] = true;
    report.changed++;
  }
  function requirePm(L) { if (!L.pm) throw new Error(tr_('sa.noAccount', { key: L.s.key })); return L.pm; }
  function newEntry(o) {
    if (existingExternal[o.external_id]) { report.skippedExisting++; return false; }
    existingExternal[o.external_id] = true;
    o.id = Utilities.getUuid();
    o.paid_by = o.type === 'income' ? '' : 'me'; // income's paid_by is a payor id — none here
    o.source = 'import'; o.import_batch_id = batchId; o.created_at = now;
    o.merchant = o.merchant || ''; o.to_payment_method_id = o.to_payment_method_id || '';
    creations.push(o);
    return true;
  }

  actions.forEach(function (a) {
    if (a.type === 'record_transfer') {
      var out = line(a.out), inn = line(a.in);
      useLine(out); useLine(inn);
      if (out.l.amount >= 0 || inn.l.amount <= 0 || out.l.currency !== inn.l.currency || Math.abs(Math.abs(out.l.amount) - inn.l.amount) >= 0.005) {
        throw new Error(tr_('sa.notSameTransfer'));
      }
      var from = requirePm(out), to = requirePm(inn);
      var catId = catByName['transfer:Between Accounts'];
      if (!catId) throw new Error(tr_('sa.catMissingBetween'));
      var made = newEntry({ type: 'transfer', date: out.l.date, amount: inn.l.amount, currency: out.l.currency, category_id: catId,
        description: tr_('desc.transfer', { from: from.nickname, to: to.nickname }), payment_method_id: from.id, to_payment_method_id: to.id,
        status: 'confirmed', external_id: 'stmt-' + out.key });
      if (made) report.created.transfers++;
      var eid = made ? creations[creations.length - 1].id : '';
      remember(out, 'recorded', eid); remember(inn, 'recorded', eid);
    } else if (a.type === 'record_exchange') {
      // A currency exchange: the money that left in one currency and the money that arrived in another are TWO one-sided
      // transfers (the way the Transfer tab records it by hand: the PEN with To empty, the USD with From "None"). Neither
      // is spending or income.
      var xo = line(a.out), xi = line(a.in);
      useLine(xo); useLine(xi);
      if (xo.l.amount >= 0 || xi.l.amount <= 0 || xo.l.currency === xi.l.currency) throw new Error(tr_('sa.notExchange'));
      var xCat = catByName['transfer:Between Accounts'];
      if (!xCat) throw new Error(tr_('sa.catMissingBetween'));
      var madeOut = newEntry({ type: 'transfer', date: xo.l.date, amount: Math.abs(xo.l.amount), currency: xo.l.currency, category_id: xCat,
        description: tr_('desc.exchangeOut', { cur: xo.l.currency }), payment_method_id: requirePm(xo).id, to_payment_method_id: '',
        status: 'confirmed', external_id: 'stmt-' + xo.key });
      var outId = madeOut ? creations[creations.length - 1].id : '';
      var madeIn = newEntry({ type: 'transfer', date: xi.l.date, amount: xi.l.amount, currency: xi.l.currency, category_id: xCat,
        description: tr_('desc.exchangeIn', { cur: xi.l.currency }), payment_method_id: '', to_payment_method_id: requirePm(xi).id,
        status: 'confirmed', external_id: 'stmt-' + xi.key });
      var inId = madeIn ? creations[creations.length - 1].id : '';
      report.created.exchanges = (report.created.exchanges || 0) + 1;
      if (madeOut) report.created.transfers++;
      if (madeIn) report.created.transfers++;
      remember(xo, 'recorded', outId); remember(xi, 'recorded', inId);
    } else if (a.type === 'record_transfer_leg') {
      // One side of a transfer whose other end is not in the app (yet). Money out: From = this account, To empty; money in:
      // From empty, To = this account — the shape the Transfer tab makes by hand. When the other account's statement is
      // uploaded later, its line COMPLETES this transfer (the matcher's open-transfer rule), so nothing is counted twice.
      var tl = line(a); useLine(tl);
      if (!(Math.abs(tl.l.amount) > 0)) throw new Error(tr_('sa.notTransferLeg'));
      var tCat = catByName['transfer:Between Accounts'];
      if (!tCat) throw new Error(tr_('sa.catMissingBetween'));
      var tOut = tl.l.amount < 0;
      var madeTL = newEntry({ type: 'transfer', date: tl.l.date, amount: Math.abs(tl.l.amount), currency: tl.l.currency, category_id: tCat,
        description: tr_('desc.transferLeg', { text: stmtCleanDescription_(tl.l.description) }),
        payment_method_id: tOut ? requirePm(tl).id : '', to_payment_method_id: tOut ? '' : requirePm(tl).id,
        status: 'pending', external_id: 'stmt-' + tl.key });   // pending: something is missing (the other end); confirmed when its statement completes it
      if (madeTL) report.created.transfers++;
      remember(tl, 'recorded', madeTL ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_history_pending') {
      // "Send to Needs review": a PENDING expense (money you paid out) or income (money that came in) with no category. In Needs review it
      // has Confirm / Discard and, for a payment with a person, Split, Mark as repayment and Convert to loan.
      var pd = line(a); useLine(pd);
      if (!(Math.abs(pd.l.amount) > 0)) throw new Error(tr_('sa.notPending'));
      var pdOut = pd.l.amount < 0;
      var madePd = newEntry({ type: pdOut ? 'expense' : 'income', date: pd.l.date, amount: Math.abs(pd.l.amount), currency: pd.l.currency, category_id: '',
        description: stmtCleanDescription_(pd.l.description), payment_method_id: requirePm(pd).id, status: 'pending', external_id: 'stmt-' + pd.key,
        merchant: pdOut ? stmtMerchantKey_(pd.l.description) : '' });
      if (madePd) report.created.pending = (report.created.pending || 0) + 1;
      remember(pd, 'added', madePd ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_history_investment') {
      // Money put into an investment platform (From = this account, amount positive) or taken out of one (a "withdrawal": the
      // same kind of entry with a NEGATIVE amount — see Investments.gs). Investments carry no category in the app; they are
      // quietly filed under "Investments". The platform is optional.
      var iv = line(a); useLine(iv);
      if (!(Math.abs(iv.l.amount) > 0)) throw new Error(tr_('sa.notInvestment'));
      var platformId = '';
      if (a.platformId) {
        var plat = pmsById[a.platformId];
        if (!plat || plat.type !== 'investment') throw new Error(tr_('sa.unknownPlatform'));
        platformId = plat.id;
      }
      var invCat = catByName['investment:Investments'] || (dryRun ? 'investments-to-be-created' : defaultInvestmentCategoryId_());
      catByName['investment:Investments'] = invCat;
      var madeIv = newEntry({ type: 'investment', date: iv.l.date, amount: iv.l.amount < 0 ? Math.abs(iv.l.amount) : -iv.l.amount, currency: iv.l.currency,
        category_id: invCat, description: stmtCleanDescription_(iv.l.description), payment_method_id: requirePm(iv).id, to_payment_method_id: platformId,
        status: platformId ? 'confirmed' : 'pending', external_id: 'stmt-' + iv.key });   // no platform yet: pending, the review row asks for one
      if (madeIv) report.created.investments = (report.created.investments || 0) + 1;
      remember(iv, 'added', madeIv ? creations[creations.length - 1].id : '');
    } else if (a.type === 'record_fee') {
      var f = line(a); useLine(f);
      if (f.l.amount >= 0) throw new Error(tr_('sa.feeOut'));
      var feeCat = catByName['expense:Bank fees'];
      if (!feeCat) {
        // A new account has no "Bank fees" category (only the owner's copy got it, from a one-off migration): make it the first
        // time a fee needs it, like "Refunds". A dry run writes nothing, so it only borrows a placeholder id.
        feeCat = dryRun ? 'bank-fees-to-be-created' : ensureBankFeesCategory_().id;
        catByName['expense:Bank fees'] = feeCat;
      }
      var madeFee = newEntry({ type: 'expense', date: f.l.date, amount: Math.abs(f.l.amount), currency: f.l.currency, category_id: feeCat,
        description: stmtFeeDescription_(f.l.description), payment_method_id: requirePm(f).id, status: 'confirmed', external_id: 'stmt-' + f.key });
      if (madeFee) report.created.fees++;
      remember(f, 'recorded', madeFee ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_purchase') {
      var p = line(a); useLine(p);
      if (p.l.amount >= 0) throw new Error(tr_('sa.purchaseOut'));
      var catP = '';
      if (a.category) {
        if (!catsById[a.category] || catsById[a.category].type !== 'expense') throw new Error(tr_('sa.unknownExpenseCat'));
        catP = a.category;
      }
      var madeP = newEntry({ type: 'expense', date: p.l.date, amount: Math.abs(p.l.amount), currency: p.l.currency, category_id: catP,
        description: a.description ? String(a.description) : stmtCleanDescription_(p.l.description), payment_method_id: requirePm(p).id,
        status: 'pending', external_id: 'stmt-' + p.key, merchant: stmtMerchantKey_(p.l.description) });
      if (madeP) report.created.purchases++;
      remember(p, 'added', madeP ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_history_expense' || a.type === 'add_history_reversal') {
      // "Fill my history" (see StatementHistory.gs): confirmed at once, no category, the bank's own wording as the description.
      var hx = line(a); useLine(hx);
      var isRev = a.type === 'add_history_reversal';
      if (isRev ? hx.l.amount <= 0 : hx.l.amount >= 0) throw new Error(tr_(isRev ? 'sa.reversalIn' : 'sa.purchaseOut'));
      // A refund that cancels a charge already in the app takes that charge's category, so the month nets to zero in its category.
      var revFor = isRev && a.entryId ? values[rowById[String(a.entryId)]] : null;
      if (isRev && a.entryId && revFor === undefined) throw new Error(tr_('sa.chargeNotFound'));
      var hxCat = isRev ? { id: '', text: '' } : lineCategory('expense', hx.l.category);
      if (!isRev && !hxCat.text && !hxCat.id) {
        var guessed = guessLineCategory(hx.l.description);
        if (guessed) { hxCat = { id: guessed, text: '' }; report.categoriesGuessed = (report.categoriesGuessed || 0) + 1; }
      }
      var madeH = newEntry({ type: 'expense', date: hx.l.date, currency: hx.l.currency, category_id: revFor ? (revFor[col.category_id] || '') : hxCat.id, payment_method_id: requirePm(hx).id,
        amount: isRev ? -hx.l.amount : Math.abs(hx.l.amount),
        description: isRev ? tr_('desc.reversal', { text: stmtCleanDescription_(String(hx.l.description).replace(/^\s*REV\.?\s*/i, '')) }) : stmtCleanDescription_(hx.l.description),
        status: 'confirmed', external_id: 'stmt-' + hx.key, merchant: stmtMerchantKey_(String(hx.l.description).replace(/^\s*REV\.?\s*/i, '')) });
      if (madeH) { if (isRev) report.created.reversals++; else { report.created.purchases++; countLineCategory(hxCat); } }
      remember(hx, 'added', madeH ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_history_refund') {
      // A refund that does not cancel a charge of its own month: income in the category "Refunds" (the line-by-line comparison's rule).
      var rfd = line(a); useLine(rfd);
      if (rfd.l.amount <= 0) throw new Error(tr_('sa.reversalIn'));
      var rfCat = catByName['income:Refunds'] || (dryRun ? 'refunds-to-be-created' : ensureRefundsCategory_().id);
      catByName['income:Refunds'] = rfCat;
      var madeRf = newEntry({ type: 'income', date: rfd.l.date, amount: rfd.l.amount, currency: rfd.l.currency, category_id: rfCat,
        description: tr_('desc.reversal', { text: stmtCleanDescription_(String(rfd.l.description).replace(/^\s*REV\.?\s*/i, '')) }),
        payment_method_id: requirePm(rfd).id, status: 'confirmed', external_id: 'stmt-' + rfd.key,
        merchant: stmtMerchantKey_(String(rfd.l.description).replace(/^\s*REV\.?\s*/i, '')) });
      if (madeRf) report.created.income++;
      remember(rfd, 'added', madeRf ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_history_income') {
      var hi = line(a); useLine(hi);
      if (hi.l.amount <= 0) throw new Error(tr_('sa.incomeIn'));
      // Interest earned has a known home (the line-by-line comparison files it there too); every other income stays uncategorized.
      var interestCat = /INTER[EÉ]S/i.test(hi.l.description) ? (catByName['income:Savings return'] || '') : '';
      var hiCat = lineCategory('income', hi.l.category);
      var madeHI = newEntry({ type: 'income', date: hi.l.date, amount: hi.l.amount, currency: hi.l.currency, category_id: hiCat.id || interestCat,
        description: stmtCleanDescription_(hi.l.description), payment_method_id: requirePm(hi).id, status: 'confirmed', external_id: 'stmt-' + hi.key });
      if (madeHI) { report.created.income++; countLineCategory(hiCat); }
      remember(hi, 'added', madeHI ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_income') {
      var inc = line(a); useLine(inc);
      if (inc.l.amount <= 0) throw new Error(tr_('sa.incomeIn'));
      var catI = '';
      if (a.category) {
        if (!catsById[a.category] || catsById[a.category].type !== 'income') throw new Error(tr_('sa.unknownIncomeCat'));
        catI = a.category;
      }
      var madeI = newEntry({ type: 'income', date: inc.l.date, amount: inc.l.amount, currency: inc.l.currency, category_id: catI,
        description: a.description ? String(a.description) : stmtCleanDescription_(inc.l.description), payment_method_id: requirePm(inc).id,
        status: 'pending', external_id: 'stmt-' + inc.key });
      if (madeI) report.created.income++;
      remember(inc, 'added', madeI ? creations[creations.length - 1].id : '');
    } else if (a.type === 'cancel_charge') {
      var rv = line(a); useLine(rv);
      if (rv.l.amount <= 0) throw new Error(tr_('sa.reversalIn'));
      var oi = rowById[String(a.entryId)];
      if (oi === undefined) throw new Error(tr_('sa.chargeNotFound'));
      if (values[oi][col.type] !== 'expense') throw new Error(tr_('sa.onlyExpenseCancel'));
      if (String(values[oi][col.currency] || homeCurrency_()) !== rv.l.currency || Math.abs(Number(values[oi][col.amount]) - rv.l.amount) >= 0.005) {
        throw new Error(tr_('sa.reversalMismatch'));
      }
      var madeRv = newEntry({ type: 'expense', date: rv.l.date, amount: -rv.l.amount, currency: rv.l.currency,
        category_id: values[oi][col.category_id] || '', description: tr_('desc.reversal', { text: values[oi][col.description] || '' }),
        payment_method_id: requirePm(rv).id, status: 'pending', external_id: 'stmt-' + rv.key });
      if (madeRv) report.created.reversals++;
      remember(rv, 'reversed', a.entryId);
    } else if (a.type === 'match' || a.type === 'assign_account' || a.type === 'link') {
      var m = line(a); useLine(m);
      var i = rowById[String(a.entryId)];
      if (i === undefined) throw new Error(tr_('sa.entryNotFound', { id: a.entryId }));
      if (a.type !== 'link') {
        var pm = requirePm(m);
        var curFrom = values[i][col.payment_method_id], curTo = values[i][col.to_payment_method_id];
        if (pm.noAccount) { /* an import with no account assigns nothing to an entry */ }
        else if (!curFrom && !curTo) setCell(a.entryId, 'payment_method_id', pm.id);
        else if (a.type === 'match' && a.overwriteAccount && !curTo && curFrom !== pm.id) setCell(a.entryId, 'payment_method_id', pm.id);
        if (a.type === 'match' && !values[i][col.merchant] && stmtMerchantKey_(m.l.description)) setCell(a.entryId, 'merchant', stmtMerchantKey_(m.l.description));
        if (a.type === 'match' && !values[i][col.external_id]) setCell(a.entryId, 'external_id', 'stmt-' + m.key);
      }
      remember(m, 'matched', a.entryId);
    } else if (a.type === 'complete_transfer') {
      var c = line(a); useLine(c);
      var j = rowById[String(a.entryId)];
      if (j === undefined) throw new Error(tr_('sa.entryNotFound', { id: a.entryId }));
      if (values[j][col.type] !== 'transfer') throw new Error(tr_('sa.notTransfer'));
      var field = a.side === 'to' ? 'to_payment_method_id' : 'payment_method_id';
      if (values[j][col[field]]) throw new Error(tr_('sa.endFilled'));
      setCell(a.entryId, field, requirePm(c).id);
      // Both ends are known now, and the line is on the second statement: nothing is missing any more, so it is confirmed.
      if (String(values[j][col.status]) === 'pending') setCell(a.entryId, 'status', 'confirmed');
      remember(c, 'completed', a.entryId);
    } else if (a.type === 'set_balance') {
      var sb = stmts[a.stmt];
      var pmB = accounts[a.stmt];
      if (!sb || !pmB) throw new Error(tr_('sa.unknownBalance'));
      if (sb.verified === false) throw new Error(tr_('sa.unverifiedBalance'));
      var bal = (sb.balances || {})[a.currency];
      if (!bal || bal.closing === null || bal.closing === undefined) throw new Error(tr_('sa.noClosing', { cur: a.currency }));
      if (!sb.period || !sb.period.end) throw new Error(tr_('sa.noEnd'));
      var ownRow = (openingsByPm[pmB.id] || []).find(function (o) { return o.currency === a.currency; });
      if (ownRow && !(sb.period.end > ownRow.date)) throw new Error(tr_('sa.balanceNotOlder', { date: ownRow.date }));
      balanceOps.push({ pm: pmB, currency: a.currency, amount: Math.round(Number(bal.closing) * 100) / 100, date: sb.period.end });
      var gapAmt = Math.round(Number(a.gap) * 100) / 100;
      if (a.gap !== undefined && a.gap !== null && a.gap !== '' && isFinite(gapAmt) && gapAmt !== 0) {
        var appBal = Number(a.app_balance);
        gapOps.push({ pm: pmB, accountKey: covKey_(sb.key), currency: a.currency, period_end: sb.period.end,
          closing: Math.round(Number(bal.closing) * 100) / 100, app_balance: isFinite(appBal) ? Math.round(appBal * 100) / 100 : '', gap: gapAmt });
      }
    } else if (a.type === 'ignore' || a.type === 'wait') {
      var g = line(a); useLine(g);
      remember(g, a.type === 'ignore' ? 'ignored' : 'waiting', '');
    } else {
      throw new Error(tr_('sa.unknownAction', { type: a.type }));
    }
  });

  // Statement Uploads: one row per statement (upsert by account + period end).
  ensureStatementUploadsSheet_();
  var uploadOps = [];
  var uploadRows = getAllRows('Statement Uploads');
  stmts.forEach(function (s, si) {
    if (!s.period || !s.period.end) return;
    var acctKey = covKey_(s.key);
    var existing = uploadRows.find(function (u) { return covKey_(u.account_key) === acctKey && String(u.period_end) === s.period.end; });
    uploadOps.push({ s: s, si: si, existing: existing || null, acctKey: acctKey });
  });
  report.statementsRecorded = uploadOps.length;
  report.balancesSet = balanceOps.map(function (b) { return { account: b.pm.nickname, currency: b.currency, amount: b.amount, date: b.date }; });
  report.gapsRecorded = gapOps.map(function (g) { return { account: g.pm.nickname, currency: g.currency, gap: g.gap, date: g.period_end }; });
  report.linesRemembered = outcomes.length;
  report.batchEntries = creations.slice(0, 20).map(function (e) { return { type: e.type, date: e.date, amount: e.amount, currency: e.currency, description: e.description, status: e.status }; });
  report.batchEntriesTotal = creations.length;
  report.pendingCount = creations.filter(function (e) { return e.status === 'pending'; }).length;   // how many wait in Needs review
  report.rateNeeds = stmtRateNeeds_(creations);

  report.categoryMissedNames = Object.keys(categoryMissedNames).slice(0, 10);
  report.categoriesCreatedNames = Object.keys(newCategories).map(function (ph) { return newCategories[ph].name; });
  // Existing categories the person asked to rename to the file's (or their own) name. A category is renamed once per save, a protected
  // one never, and a name another category already has is skipped — see plannedCategoryRename_.
  var renames = [], renamedIds = {}, renamesSkipped = 0;
  Object.keys(renameCandidates).forEach(function (k) {
    if (!categoryNames[k]) return;
    var id = renameCandidates[k], cat = catsById[id];
    if (renamedIds[id]) { renamesSkipped++; return; }
    var plan = plannedCategoryRename_(cat, categoryNames[k], cats.map(function (o) { return renamedIds[o.id] ? Object.assign({}, o, { name: renamedIds[o.id] }) : o; }));
    if (!plan) { if (catNameNorm_(categoryNames[k]) && categoryAllNames_(cat).indexOf(catNameNorm_(categoryNames[k])) === -1) renamesSkipped++; return; }
    renamedIds[id] = plan.to;
    renames.push(plan);
  });
  report.categoriesRenamed = renames.map(function (r) { return { from: r.from, to: r.to }; });
  report.categoriesRenameSkipped = renamesSkipped;
  if (dryRun) return report;

  // ---- writes ----
  ensureStatementLinesSheet_();
  ensureStatementChangesSheet_();
  report.batchId = batchId;
  ensureImportBatchRow_(batchId, payload.filename || 'Statement upload', creations.length);
  // The categories the person asked to create, now that nothing else can fail. Each is recorded for Undo.
  var createdCategoryIds = {};
  var placeholders = Object.keys(newCategories);
  createCategoriesBulk_(placeholders.map(function (ph) { return newCategories[ph]; })).forEach(function (made, i) {
    createdCategoryIds[placeholders[i]] = made.id;
    if (made.created) changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Categories', row_id: made.id, field: '__created__', old_value: '', new_value: '', created_at: now });
  });
  creations.forEach(function (e) { if (String(e.category_id).indexOf('new-category:') === 0) e.category_id = createdCategoryIds[e.category_id] || ''; });
  renames.forEach(function (r) {
    var cur = catsById[r.id];
    try { saveCategory({ id: r.id, name: r.to, icon: cur.icon, color: cur.color }); } catch (err) { report.categoriesRenameSkipped++; return; }   // keep icon and colour: saveCategory resets what it is not given
    changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Categories', row_id: r.id, field: 'name', old_value: r.storedFrom, new_value: r.to, created_at: now });
  });
  report.categoriesRenamed = report.categoriesRenamed.filter(function (r) { return changes.some(function (c) { return c.sheet === 'Categories' && c.field === 'name' && c.new_value === r.to; }); });
  report.categoriesCreatedNames = Object.keys(createdCategoryIds).filter(function (ph) { return changes.some(function (c) { return c.sheet === 'Categories' && c.row_id === createdCategoryIds[ph]; }); }).map(function (ph) { return newCategories[ph].name; });
  appendRowsBulk_('Entries', creations);
  if (payload.inboxIds && payload.inboxIds.length) markStatementInboxProcessed_(payload.inboxIds);
  Object.keys(colChanged).forEach(function (f) {
    var colValues = values.map(function (r) { return [r[col[f]]]; });
    if (values.length) sheet.getRange(2, col[f] + 1, values.length, 1).setValues(colValues);
  });

  var usheet = getSheet('Statement Uploads');
  var uheaders = getHeaders(usheet);
  var newUploadRows = [];   // written in ONE call after the loop: a year of statements is dozens of rows
  uploadOps.forEach(function (op) {
    var closing = JSON.stringify(op.s.balances || {});
    var fields = { closing_json: closing, file_name: op.s.file_name || '', processed_at: today, batch_id: batchId,
      lines_total: (op.s.lines || []).length, verified: op.s.verified === false ? 'false' : 'true', source: 'upload' };
    if (op.existing) {
      var ri = findRowIndexById(usheet, uheaders, op.existing.id);
      Object.keys(fields).forEach(function (f) {
        var old = op.existing[f];
        changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Statement Uploads', row_id: op.existing.id, field: f,
          old_value: String(old === undefined || old === null ? '' : old), new_value: String(fields[f]), created_at: now });
        setCellByRow_(usheet, uheaders, ri, f, fields[f]);
      });
    } else {
      var newId = Utilities.getUuid();
      newUploadRows.push(Object.assign({ id: newId, account_key: op.acctKey,
        account_label: (accounts[op.si] ? accounts[op.si].nickname + (accounts[op.si].noAccount || String(op.acctKey).indexOf(STMT_ACCT_KEY_PREFIX_) === 0 ? '' : ' …' + op.acctKey) : op.acctKey),
        payment_method_id: accounts[op.si] ? accounts[op.si].id : '', kind: op.s.kind,
        period_start: (op.s.period || {}).start || '', period_end: op.s.period.end }, fields));
      changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Statement Uploads', row_id: newId, field: '__created__',
        old_value: '', new_value: '', created_at: now });
    }
  });
  appendRowsBulk_('Statement Uploads', newUploadRows);

  // Balances: the newest balance prevails, so a statement only ever replaces an OLDER
  // snapshot (checked above). The replaced row is logged so undo can bring it back.
  balanceOps.forEach(function (b) {
    var oldRows = getAllRows('Account Opening Balances').filter(function (r) {
      return r.payment_method_id === b.pm.id && String(r.currency).toUpperCase() === b.currency;
    });
    oldRows.forEach(function (r) {
      changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Account Opening Balances', row_id: r.id, field: '__deleted__',
        old_value: JSON.stringify(r), new_value: '', created_at: now });
    });
    if (oldRows.length) deleteRowsWhere_('Account Opening Balances', function (row) {
      return row.payment_method_id === b.pm.id && String(row.currency).toUpperCase() === b.currency;
    });
    var newRowId = addOpeningRow_(b.pm.id, b.currency, b.amount, b.date, b.date + 'T23:59:59');
    changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Account Opening Balances', row_id: newRowId, field: '__created__',
      old_value: '', new_value: '', created_at: now });
  });

  // Gap notes (see Statement Gaps, above).
  if (gapOps.length) {
    ensureStatementGapsSheet_();
    gapOps.forEach(function (g) {
      var gid = Utilities.getUuid();
      appendRowObject('Statement Gaps', { id: gid, payment_method_id: g.pm.id, account_key: g.accountKey, account_label: g.pm.nickname,
        currency: g.currency, period_end: g.period_end, closing: g.closing, app_balance: g.app_balance, gap: g.gap,
        status: 'open', note: '', batch_id: batchId, created_at: now, resolved_at: '' });
      changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Statement Gaps', row_id: gid, field: '__created__',
        old_value: '', new_value: '', created_at: now });
    });
  }

  // Remember the lines. A line decided before is replaced, not duplicated.
  var newKeys = {};
  outcomes.forEach(function (o) { newKeys[o.line_key] = true; });
  var oldLines = getAllRows('Statement Lines').filter(function (r) { return newKeys[r.line_key]; });
  oldLines.forEach(function (r) {
    changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Statement Lines', row_id: r.id, field: '__deleted__',
      old_value: JSON.stringify(r), new_value: '', created_at: now });
  });
  if (oldLines.length) deleteRowsWhere_('Statement Lines', function (row) { return newKeys[row.line_key]; });
  appendRowsBulk_('Statement Lines', outcomes);
  appendRowsBulk_('Statement Changes', changes);
  return report;
}

/**
 * Undo one upload: reverts the changes it made to existing entries (only where
 * the cell still holds what the upload wrote), deletes the entries it created,
 * forgets its line outcomes (restoring any it replaced) and un-records its
 * statements.
 */
function undoStatementBatch(payload) {
  var batchId = payload.batchId;
  if (!batchId) throw new Error('batchId required');
  ensureStatementLinesSheet_();
  ensureStatementChangesSheet_();
  var res = { reverted: 0, skipped: 0, deletedEntries: 0, forgottenLines: 0, uploadsRestored: 0 };
  var changes = getAllRows('Statement Changes').filter(function (c) { return c.batch_id === batchId; });

  // Entries: revert changed cells.
  var esheet = getSheet('Entries');
  var eheaders = getHeaders(esheet);
  var elast = esheet.getLastRow();
  var evalues = elast > 1 ? esheet.getRange(2, 1, elast - 1, eheaders.length).getValues() : [];
  var eid = eheaders.indexOf('id');
  var rowById = {};
  evalues.forEach(function (r, i) { rowById[String(r[eid])] = i; });
  var touched = {};
  changes.filter(function (c) { return c.sheet === 'Entries'; }).forEach(function (c) {
    var i = rowById[c.row_id], ci = eheaders.indexOf(c.field);
    if (i === undefined || ci === -1) { res.skipped++; return; }
    if (String(evalues[i][ci]) !== String(c.new_value)) { res.skipped++; return; } // changed since — leave it
    evalues[i][ci] = c.old_value;
    touched[c.field] = true;
    res.reverted++;
  });
  Object.keys(touched).forEach(function (f) {
    var ci = eheaders.indexOf(f);
    esheet.getRange(2, ci + 1, evalues.length, 1).setValues(evalues.map(function (r) { return [r[ci]]; }));
  });
  if (Object.keys(touched).length) bumpStructureVersion_();   // bulk column write — phones reload fully

  // The entries this upload created go FIRST: it is the slow part, and the upload stays in "Recent uploads" (its Statement
  // Uploads row) until everything is done, so an Undo that is cut short can simply be tapped again. It used to remove the
  // bookkeeping first, and a cut-short Undo left the entries behind with no way back (found 2026-10-22).
  res.deletedEntries = getAllRows('Entries').filter(function (e) { return e.import_batch_id === batchId; }).length;
  deleteRowsWhere_('Entries', function (row) { return row.import_batch_id === batchId; });

  // Categories this upload renamed: back to their old names, unless the person has changed them since.
  var csheet = getSheet('Categories'), cheaders = getHeaders(csheet), restored = 0;
  changes.filter(function (c) { return c.sheet === 'Categories' && c.field === 'name'; }).forEach(function (c) {
    var ri = findRowIndexById(csheet, cheaders, c.row_id);
    if (ri === -1) return;
    var cur = csheet.getRange(ri, cheaders.indexOf('name') + 1).getValue();
    if (String(cur) !== String(c.new_value)) return;
    setCellByRow_(csheet, cheaders, ri, 'name', c.old_value);
    restored++;
  });
  if (restored) { res.categoriesRenamedBack = restored; bumpStructureVersion_(); if (ROWS_MEMO_) delete ROWS_MEMO_['Categories']; }

  // Categories this upload created: removed again unless something else (an entry the person filed there since, a budget…) uses them.
  var createdCategoryIds = changes.filter(function (c) { return c.sheet === 'Categories' && c.field === '__created__'; }).map(function (c) { return c.row_id; });
  if (createdCategoryIds.length) {
    var usage = categoryUsageMany_(createdCategoryIds), unused = {};
    createdCategoryIds.forEach(function (id) {
      if (usage[String(id)] !== 0) res.categoriesKept = (res.categoriesKept || 0) + 1;
      else { unused[String(id)] = true; res.categoriesRemoved = (res.categoriesRemoved || 0) + 1; }
    });
    if (Object.keys(unused).length) deleteRowsWhere_('Categories', function (row) { return unused[String(row.id)]; });   // one call for all of them
    bumpStructureVersion_();
  }

  // Account Opening Balances: remove the rows this batch created, bring back the ones it replaced.
  var createdBalanceIds = {};
  changes.filter(function (c) { return c.sheet === 'Account Opening Balances' && c.field === '__created__'; }).forEach(function (c) { createdBalanceIds[c.row_id] = true; });
  if (Object.keys(createdBalanceIds).length) deleteRowsWhere_('Account Opening Balances', function (row) { return createdBalanceIds[row.id]; });
  changes.filter(function (c) { return c.sheet === 'Account Opening Balances' && c.field === '__deleted__'; }).forEach(function (c) {
    try {
      var r = JSON.parse(c.old_value);
      // An Undo that is tapped again after being cut short must not bring the same balance back twice.
      var there = getAllRows('Account Opening Balances').some(function (o) {
        return o.payment_method_id === r.payment_method_id && String(o.currency).toUpperCase() === String(r.currency).toUpperCase() && String(o.date).substring(0, 10) === String(r.date).substring(0, 10);
      });
      if (there) return;
      addOpeningRow_(r.payment_method_id, String(r.currency).toUpperCase(), Number(r.amount), String(r.date), String(r.as_of || ''));
      res.balancesRestored = (res.balancesRestored || 0) + 1;
    } catch (e) { /* unreadable — leave */ }
  });

  // Statement Gaps: remove the notes this batch created.
  var createdGapIds = {};
  changes.filter(function (c) { return c.sheet === 'Statement Gaps' && c.field === '__created__'; }).forEach(function (c) { createdGapIds[c.row_id] = true; res.gapsRemoved = (res.gapsRemoved || 0) + 1; });
  if (Object.keys(createdGapIds).length) deleteRowsWhere_('Statement Gaps', function (row) { return createdGapIds[row.id]; });

  // Statement Lines: forget this batch's, restore what it replaced.
  var forgotten = getAllRows('Statement Lines').filter(function (r) { return r.batch_id === batchId; }).length;
  deleteRowsWhere_('Statement Lines', function (row) { return row.batch_id === batchId; });
  res.forgottenLines = forgotten;
  var restore = [];
  changes.filter(function (c) { return c.sheet === 'Statement Lines' && c.field === '__deleted__'; }).forEach(function (c) {
    try { restore.push(JSON.parse(c.old_value)); } catch (e) { /* skip unreadable */ }
  });
  // (a retried Undo must not bring the same remembered line back twice)
  var present = {};
  getAllRows('Statement Lines').forEach(function (r) { present[r.line_key] = true; });
  appendRowsBulk_('Statement Lines', restore.filter(function (r) { return !present[r.line_key]; }));

  // Statement Uploads LAST: while its row is there the upload is still listed in Recent uploads, so an Undo cut short
  // before this point can be tapped again. (Delete rows this batch created, restore rows it updated.)
  var usheet = getSheet('Statement Uploads');
  var uheaders = getHeaders(usheet);
  var createdUploadIds = {};
  changes.filter(function (c) { return c.sheet === 'Statement Uploads'; }).forEach(function (c) {
    if (c.field === '__created__') {
      createdUploadIds[c.row_id] = true;
      res.uploadsRestored++;
    } else {
      var ri = findRowIndexById(usheet, uheaders, c.row_id);
      if (ri !== -1) setCellByRow_(usheet, uheaders, ri, c.field, c.old_value);
    }
  });
  // One call for all of them (one per statement took ~1 s each on a real Sheet: 60 statements outlast the app's patience).
  if (Object.keys(createdUploadIds).length) deleteRowsWhere_('Statement Uploads', function (row) { return createdUploadIds[row.id]; });


  deleteRowsWhere_('Import Batches', function (row) { return row.id === batchId; });
  deleteRowsWhere_('Statement Changes', function (row) { return row.batch_id === batchId; });
  return res;
}

/**
 * The gap notes, open ones first, then newest statement first. Amounts are numbers.
 * `gap` > 0: the statement shows MORE money than the app; < 0: LESS.
 */
function listStatementGaps() {
  ensureStatementGapsSheet_();
  var rows = getAllRows('Statement Gaps').map(function (r) {
    return { id: r.id, payment_method_id: r.payment_method_id, account_key: r.account_key, account_label: r.account_label,
      currency: r.currency, period_end: String(r.period_end), closing: Number(r.closing),
      app_balance: r.app_balance === '' ? null : Number(r.app_balance), gap: Number(r.gap),
      status: r.status === 'resolved' ? 'resolved' : 'open', note: String(r.note || ''),
      created_at: String(r.created_at), resolved_at: String(r.resolved_at || '') };
  });
  rows.sort(function (x, y) {
    if (x.status !== y.status) return x.status === 'open' ? -1 : 1;
    return x.period_end < y.period_end ? 1 : (x.period_end > y.period_end ? -1 : 0);
  });
  return { gaps: rows, open: rows.filter(function (r) { return r.status === 'open'; }).length };
}

/** payload: { id, resolved (default true), note? } — marks a gap note resolved, or reopens it. */
function resolveStatementGap(payload) {
  ensureStatementGapsSheet_();
  var sheet = getSheet('Statement Gaps');
  var headers = getHeaders(sheet);
  var rowIndex = findRowIndexById(sheet, headers, payload.id);
  if (rowIndex === -1) throw new Error(tr_('err.gapNotFound'));
  var resolved = payload.resolved !== false;
  setCellByRow_(sheet, headers, rowIndex, 'status', resolved ? 'resolved' : 'open');
  setCellByRow_(sheet, headers, rowIndex, 'resolved_at', resolved ? nowTimestamp_().substring(0, 10) : '');
  if (payload.note !== undefined) setCellByRow_(sheet, headers, rowIndex, 'note', String(payload.note || '').trim().slice(0, 300));
  return { done: true };
}

/**
 * What one upload did besides the entries it created (those come from listEntries with `importBatchId`): the statements it read,
 * how its lines were decided, the lines it set aside and remembered (waiting for their other statement), and how many existing
 * entries it changed. Read-only. payload: { batchId }.
 */
function getStatementBatchDetails(payload) {
  var batchId = payload && payload.batchId;
  if (!batchId) throw new Error('batchId required');
  ensureStatementLinesSheet_();
  ensureStatementChangesSheet_();
  ensureStatementUploadsSheet_();
  var pms = getAllRows('Payment Methods');
  var statements = getAllRows('Statement Uploads').filter(function (u) { return u.batch_id === batchId; }).map(function (u) {
    return { label: u.account_label || u.account_key, period_start: String(u.period_start), period_end: String(u.period_end), file_name: u.file_name || '', lines_total: Number(u.lines_total) || 0, processed_at: String(u.processed_at) };
  });
  var outcomes = {}, waiting = [];
  getAllRows('Statement Lines').forEach(function (r) {
    if (r.batch_id !== batchId) return;
    outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
    if (r.outcome === 'waiting') {
      var pm = stmtPmForKey_(pms, r.account_key);
      waiting.push({ date: String(r.date), description: r.description, amount: Number(r.amount), currency: r.currency, account: pm ? pm.nickname : r.account_key });
    }
  });
  waiting.sort(function (x, y) { return x.date < y.date ? -1 : 1; });
  var changed = getAllRows('Statement Changes').filter(function (c) { return c.batch_id === batchId && c.sheet === 'Entries'; }).length;
  return { statements: statements, outcomes: outcomes, waiting: waiting, changedEntries: changed };
}

/** The most recent uploads that can still be undone (5 by default; the screen asks for more with payload.limit). */
function listStatementBatches(payload) {
  var limit = Math.max(1, Math.min(200, Math.floor(Number((payload || {}).limit) || 5)));
  ensureStatementChangesSheet_();
  ensureStatementUploadsSheet_();
  var byBatch = {};
  getAllRows('Statement Uploads').forEach(function (u) {
    if (u.source !== 'upload' || !u.batch_id) return;
    var b = byBatch[u.batch_id] || (byBatch[u.batch_id] = { batchId: u.batch_id, processed_at: String(u.processed_at), statements: [] });
    b.statements.push(u.account_label || u.account_key);
  });
  var created = {};
  getAllRows('Entries').forEach(function (e) { if (byBatch[e.import_batch_id]) created[e.import_batch_id] = (created[e.import_batch_id] || 0) + 1; });
  var changed = {};
  getAllRows('Statement Changes').forEach(function (c) { if (c.sheet === 'Entries' && byBatch[c.batch_id]) changed[c.batch_id] = (changed[c.batch_id] || 0) + 1; });
  return Object.keys(byBatch).map(function (k) {
    var b = byBatch[k]; b.entriesCreated = created[k] || 0; b.entriesChanged = changed[k] || 0; return b;
  }).sort(function (x, y) { return x.processed_at < y.processed_at ? 1 : -1; }).slice(0, limit);
}

/**
 * Existing entries for the "match this line to an entry" picker: the whole
 * calendar month of the line's date (plus the last two days of the previous
 * month when the line falls on the 1st/2nd), in ANY currency. The 10 most
 * similar come first (is_top), then everything else by date.
 * payload: { date, amount, currency, description, kind ('income' or other) }
 */
function getEntriesNear(payload) {
  var win = matchPickerWindow_(payload.date);
  var wantIncome = payload.kind === 'income';
  var catsById = rowsById_(getAllRows('Categories'));
  var pmsById = rowsById_(getAllRows('Payment Methods'));
  var candidates = getAllRows('Entries').filter(function (e) {
    return e.date >= win.lo && e.date <= win.hi && ((e.type === 'income') === wantIncome);
  }).map(function (e) { return stmtEntrySummary_(e, catsById, pmsById); });
  return orderMatchCandidates_(candidates, {
    amount: payload.amount, currency: payload.currency, date: payload.date, description: payload.description
  });
}


/** The expense category "Bank fees" (ITF tax, card insurance…); created on first use when the account does not have it. */
function ensureBankFeesCategory_() {
  var found = getAllRows('Categories').filter(function (c) { return c.type === 'expense' && (c.name === 'Bank fees' || c.key === 'bank_fees'); })[0];
  if (found) return found;
  var row = { id: Utilities.getUuid(), name: 'Bank fees', type: 'expense', icon: '🧾',
    color: CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'bank_fees' };
  appendRowObject('Categories', row);
  return row;
}

/** The income category "Refunds" (money coming back for a purchase); created on first use. */
function ensureRefundsCategory_() {
  var found = getAllRows('Categories').filter(function (c) { return c.type === 'income' && c.name === 'Refunds'; })[0];
  if (found) return found;
  var row = { id: Utilities.getUuid(), name: 'Refunds', type: 'income', icon: '↩️',
    color: CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'refunds' };
  appendRowObject('Categories', row);
  return row;
}

/**
 * One-off: forget that some statement lines were "ignored" so the next Review
 * shows them again. payload: { contains (text in the line description), outcome
 * (default 'ignored'), dryRun (default true) }. Only touches the remembered
 * outcome, never an entry.
 */
function adminReopenStatementLines(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var needle = String((payload && payload.contains) || '').toLowerCase();
  var outcome = (payload && payload.outcome) || 'ignored';
  if (!needle) throw new Error('contains is required');
  ensureStatementLinesSheet_();
  var hits = getAllRows('Statement Lines').filter(function (r) {
    return r.outcome === outcome && String(r.description).toLowerCase().indexOf(needle) >= 0;
  });
  var report = { dryRun: dryRun, lines: hits.map(function (r) { return { date: r.date, description: r.description, amount: r.amount, currency: r.currency }; }) };
  if (!dryRun) {
    var ids = {};
    hits.forEach(function (r) { ids[r.id] = true; });
    deleteRowsWhere_('Statement Lines', function (r) { return ids[r.id]; });
  }
  return report;
}
