/**
 * Applying reviewed bank-statement results to the Sheet. The statement is
 * read and matched elsewhere (docs/statement-parsers.js, StatementMatch.gs);
 * this only writes what the owner has approved:
 *   - new entries (transfers between the owner's accounts, bank fees, …),
 *     created CONFIRMED with source 'import' — the owner approved each one
 *     in review — tied to one Import Batch so the whole run can be undone;
 *   - account assignments for existing entries that have none yet (the
 *     Spendee import left the payment method blank).
 * Idempotent: an entry whose external_id already exists is skipped, and an
 * assignment only fills a payment method that is still blank.
 *
 * payload: { dryRun (default TRUE), filename,
 *   entries: [{ type, date, amount, currency, category, description,
 *               from, to, external_id, status, merchant }],  // from/to = payment method nicknames;
 *                                               // status defaults to 'confirmed'; category may be '' (pending only)
 *   merchantUpdates: [{ entryId, merchant }],   // fills a blank `merchant` on an existing entry
 *   assignments: [{ entryId, account }] }      // account = payment method nickname
 */
function adminApplyStatementActions(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, entriesCreated: 0, entriesSkippedExisting: 0, assigned: 0, assignSkipped: [], batchId: null, errors: [] };

  var pmByNick = {};
  getAllRows('Payment Methods').forEach(function (p) { pmByNick[String(p.nickname).trim()] = p.id; });
  var catByName = {};
  getAllRows('Categories').forEach(function (c) { catByName[c.type + ':' + c.name] = c.id; });
  function pmId(nick) {
    if (!nick) return '';
    if (!pmByNick[nick]) throw new Error('Unknown payment method: ' + nick);
    return pmByNick[nick];
  }

  var existingExternal = {};
  getAllRows('Entries').forEach(function (e) { if (e.external_id) existingExternal[e.external_id] = true; });

  var batchId = Utilities.getUuid();
  var toCreate = [];
  (payload.entries || []).forEach(function (e) {
    if (e.external_id && existingExternal[e.external_id]) { report.entriesSkippedExisting++; return; }
    var catType = e.type === 'transfer' ? 'transfer' : 'expense';
    var categoryId = e.category ? catByName[catType + ':' + e.category] : '';
    if (e.category && !categoryId) throw new Error('Unknown ' + catType + ' category: ' + e.category);
    if (!e.category && e.status !== 'pending') throw new Error('A confirmed entry needs a category: ' + e.description);
    toCreate.push({
      id: Utilities.getUuid(), type: e.type, date: e.date, amount: Number(e.amount), currency: e.currency,
      category_id: categoryId, description: e.description || '',
      payment_method_id: pmId(e.from), to_payment_method_id: pmId(e.to),
      paid_by: 'me', status: e.status === 'pending' ? 'pending' : 'confirmed', source: 'import', external_id: e.external_id || '',
      import_batch_id: batchId, created_at: nowTimestamp_(), merchant: e.merchant || ''
    });
  });
  report.entriesCreated = toCreate.length;

  // Assignments: only entries still without an account.
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var idCol = headers.indexOf('id'), pmCol = headers.indexOf('payment_method_id'), toCol = headers.indexOf('to_payment_method_id');
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  var rowById = {};
  values.forEach(function (r, i) { rowById[r[idCol]] = i; });
  var pmColumn = values.map(function (r) { return [r[pmCol]]; });
  var toAssign = 0;
  (payload.assignments || []).forEach(function (a) {
    var i = rowById[a.entryId];
    if (i === undefined) { report.assignSkipped.push(a.entryId + ' (not found)'); return; }
    if (values[i][pmCol] || (toCol !== -1 && values[i][toCol])) { report.assignSkipped.push(a.entryId + ' (already has an account)'); return; }
    pmColumn[i][0] = pmId(a.account);
    toAssign++;
  });
  report.assigned = toAssign;

  // Merchant names for existing entries (blank only) — training data for
  // category guessing, taken from the statement's own merchant text.
  var merchCol = headers.indexOf('merchant');
  var merchColumn = values.map(function (r) { return [merchCol === -1 ? '' : r[merchCol]]; });
  var toMerchant = 0;
  (payload.merchantUpdates || []).forEach(function (m) {
    var i = rowById[m.entryId];
    if (i === undefined || merchCol === -1 || merchColumn[i][0] || !m.merchant) return;
    merchColumn[i][0] = m.merchant;
    toMerchant++;
  });
  report.merchantsSet = toMerchant;

  if (!dryRun) {
    if (toCreate.length) {
      ensureImportBatchRow_(batchId, payload.filename || 'statement-reconciliation', toCreate.length);
      toCreate.forEach(function (e) { appendRowObject('Entries', e); });
      report.batchId = batchId;
    }
    if (toAssign) sheet.getRange(2, pmCol + 1, pmColumn.length, 1).setValues(pmColumn);
    if (toMerchant) sheet.getRange(2, merchCol + 1, merchColumn.length, 1).setValues(merchColumn);
  }
  return report;
}

function ensureImportBatchRow_(batchId, filename, count) {
  appendRowObject('Import Batches', {
    id: batchId, filename: filename,
    date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    row_count: count
  });
}

/** Undoes one import batch: deletes its entries and its batch row. */
function adminUndoImportBatch(payload) {
  var id = payload.batchId;
  if (!id) throw new Error('batchId required');
  var before = getAllRows('Entries').filter(function (e) { return e.import_batch_id === id; }).length;
  deleteRowsWhere_('Entries', function (row) { return row.import_batch_id === id; });
  deleteRowsWhere_('Import Batches', function (row) { return row.id === id; });
  return { deletedEntries: before };
}

// ---- Statement coverage: which statement was processed last, per account ----
//
// Data-driven on purpose (nothing about the owner's accounts is hard-coded —
// this repo is public): an account is any credit/debit Payment Method that
// has a last_4, plus any account_key that already has a Statement Uploads
// row (e.g. a product with no card number, like a savings sub-account keyed
// by currency). A statement finds its account by `account_key`: the last
// four digits of the account/card number printed on it.

var STATEMENT_UPLOADS_COLUMNS_ = ['id', 'account_key', 'account_label', 'payment_method_id', 'kind',
  'period_start', 'period_end', 'closing_json', 'file_name', 'processed_at', 'batch_id',
  'lines_total', 'verified', 'source'];

function ensureStatementUploadsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName('Statement Uploads')) return;
  var sheet = ss.insertSheet('Statement Uploads');
  var headerRange = sheet.getRange(1, 1, 1, STATEMENT_UPLOADS_COLUMNS_.length);
  headerRange.setValues([STATEMENT_UPLOADS_COLUMNS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Dates stay plain text (YYYY-MM-DD) — same reason as every other table.
  ['period_start', 'period_end', 'processed_at'].forEach(function (col) {
    sheet.getRange(1, STATEMENT_UPLOADS_COLUMNS_.indexOf(col) + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
}

// Sheets stores a card's last_4 as a NUMBER and drops leading zeros
// (0123 -> 123), while a statement prints "0123" — so every account key is
// normalised to four digits before comparing.
function covKey_(v) {
  var s = String(v === undefined || v === null ? '' : v).trim();
  return /^\d{1,4}$/.test(s) ? ('0000' + s).slice(-4) : s;
}

function covPad_(n) { return (n < 10 ? '0' : '') + n; }

// Same day next month; a month-END date stays a month-end (Aug 31 -> Sep 30).
function covAddMonth_(iso) {
  var p = String(iso).split('-').map(Number);
  var y = p[0], m = p[1], d = p[2];
  var isEnd = d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  var ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  var lastNext = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return ny + '-' + covPad_(nm) + '-' + covPad_(isEnd ? lastNext : Math.min(d, lastNext));
}

function covAddDays_(iso, n) {
  var p = String(iso).split('-').map(Number);
  var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return t.getUTCFullYear() + '-' + covPad_(t.getUTCMonth() + 1) + '-' + covPad_(t.getUTCDate());
}

// How long after its period ends a statement typically becomes available:
// credit cards bill a few days after close; BCP's monthly statement email
// arrives weeks later; everything else (downloaded from the bank's app) is
// there the next day.
function covLagDays_(pm, bankName) {
  if (bankName === 'BCP') return 23;
  if (pm && pm.type === 'credit') return 8;
  return 1;
}

function listStatementCoverage() {
  ensureStatementUploadsSheet_();
  var uploads = getAllRows('Statement Uploads');
  var banksById = rowsById_(getAllRows('Banks'));
  var accounts = {};
  getAllRows('Payment Methods').forEach(function (pm) {
    var key = covKey_(pm.last_4);
    if (!key || (pm.type !== 'credit' && pm.type !== 'debit')) return;
    var bank = banksById[pm.bank_id] ? banksById[pm.bank_id].name : '';
    accounts[key] = { key: key, label: pm.nickname + ' …' + key, lag: covLagDays_(pm, bank) };
  });
  uploads.forEach(function (u) {
    if (!u.account_key) return;
    var uk = covKey_(u.account_key);
    if (!accounts[uk]) accounts[uk] = { key: uk, label: u.account_label || uk, lag: 1 };
  });

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var rows = Object.keys(accounts).map(function (key) {
    var a = accounts[key];
    var mine = uploads.filter(function (u) { return covKey_(u.account_key) === key; })
      .sort(function (x, y) { return String(x.period_end) < String(y.period_end) ? 1 : -1; });
    var last = mine[0] || null;
    var out = { key: key, label: a.label, last: null, next_expected: null, status: 'never' };
    if (last) {
      out.last = {
        period_start: String(last.period_start), period_end: String(last.period_end),
        processed_at: String(last.processed_at), file_name: last.file_name,
        verified: String(last.verified) !== 'false', source: last.source
      };
      out.next_expected = covAddDays_(covAddMonth_(String(last.period_end)), a.lag);
      out.status = today > out.next_expected ? 'due' : 'ok';
    }
    return out;
  });
  var rank = { due: 0, never: 1, ok: 2 };
  rows.sort(function (x, y) { return (rank[x.status] - rank[y.status]) || (x.label < y.label ? -1 : 1); });
  return { today: today, accounts: rows };
}

/**
 * One-off seed of Statement Uploads from statements already reconciled by
 * hand (payload.rows: [{ account_key, account_label, kind, period_start,
 * period_end, closing_json, file_name, processed_at, lines_total, verified }]).
 * Idempotent on (account_key, period_end).
 */
function adminSeedStatementUploads(payload) {
  ensureStatementUploadsSheet_();
  if (payload.replaceSeed) deleteRowsWhere_('Statement Uploads', function (row) { return row.source === 'seed'; });
  var existing = {};
  getAllRows('Statement Uploads').forEach(function (u) { existing[covKey_(u.account_key) + '|' + u.period_end] = true; });
  var pmByLast4 = {};
  getAllRows('Payment Methods').forEach(function (pm) { if (covKey_(pm.last_4)) pmByLast4[covKey_(pm.last_4)] = pm.id; });
  var created = 0, skipped = 0;
  (payload.rows || []).forEach(function (r) {
    if (existing[covKey_(r.account_key) + '|' + r.period_end]) { skipped++; return; }
    appendRowObject('Statement Uploads', {
      id: Utilities.getUuid(), account_key: covKey_(r.account_key), account_label: r.account_label || '',
      payment_method_id: pmByLast4[covKey_(r.account_key)] || '', kind: r.kind,
      period_start: r.period_start, period_end: r.period_end, closing_json: r.closing_json || '',
      file_name: r.file_name || '', processed_at: r.processed_at, batch_id: r.batch_id || '',
      lines_total: r.lines_total || 0, verified: r.verified === false ? 'false' : 'true', source: r.source || 'seed'
    });
    created++;
  });
  return { created: created, skipped: skipped };
}

// ---- Review: analyse parsed statements against the entries in the Sheet ----
//
// READ-ONLY. The phone reads the PDFs (docs/statement-parsers.js) and sends
// just the extracted lines; this runs the matcher (StatementMatch.gs) and the
// category guess (CategoryGuess.gs) and returns what it found. Nothing here
// writes to the Sheet — applying decisions is a later step.

// A statement's merchant text ("RAPPI PERU LIMA PER") reduced to the same
// normalised form entries store, with the trailing city/country dropped.
function stmtMerchantKey_(description) {
  var t = normalizeMerchant_(description).split(' ');
  while (t.length > 1 && ['per', 'pe', 'lima', 'li'].indexOf(t[t.length - 1]) !== -1) t.pop();
  return t.join(' ');
}

function stmtEntrySummary_(e, catsById, pmsById) {
  return {
    id: e.id, date: e.date, type: e.type, description: e.description,
    amount: Number(e.amount), currency: e.currency, status: e.status,
    category: catsById[e.category_id] ? catsById[e.category_id].name : '',
    account: pmsById[e.payment_method_id] ? pmsById[e.payment_method_id].nickname : '',
    to_account: pmsById[e.to_payment_method_id] ? pmsById[e.to_payment_method_id].nickname : ''
  };
}

/**
 * payload: { statements: [{ key, kind, period:{start,end}, lines:[{date,description,amount,currency,section}] }] }
 * `key` is the account key printed on the statement (last four digits, or
 * AHORRA-<currency>). Returns, per statement, every line with its outcome.
 */
function analyzeStatements(payload) {
  var T0 = Date.now(), timing = {};
  function tick(name) { timing[name] = Date.now() - T0; }
  var stmts = payload.statements || [];
  var pms = getAllRows('Payment Methods');
  var pmsById = rowsById_(pms);
  var catsById = rowsById_(getAllRows('Categories'));
  var savingsReturn = Object.keys(catsById).map(function (k) { return catsById[k]; })
    .find(function (c) { return c.type === 'income' && c.name === 'Savings return'; }) || null;
  var pmByKey = {};
  pms.forEach(function (pm) { var k = covKey_(pm.last_4); if (k) pmByKey[k] = pm; });
  function pmFor(key) {
    if (String(key).indexOf('AHORRA-') === 0) {
      return pms.find(function (pm) { return String(pm.nickname).toLowerCase().replace(/[^a-z]/g, '').indexOf('ahorra') === 0; }) || null;
    }
    return pmByKey[covKey_(key)] || null;
  }

  // Only entries near the statements' dates can match.
  var lo = null, hi = null;
  stmts.forEach(function (s) {
    (s.lines || []).forEach(function (l) {
      if (lo === null || l.date < lo) lo = l.date;
      if (hi === null || l.date > hi) hi = l.date;
    });
  });
  tick('small_tables');
  var allEntries = getAllRows('Entries');
  var entries = lo === null ? [] : allEntries.filter(function (e) {
    return e.date >= covAddDays_(lo, -12) && e.date <= covAddDays_(hi, 12);
  });

  tick('entries_read');
  // Lines whose outcome the owner already decided (recorded / matched by hand /
  // ignored earlier) are remembered by a stable key — they are shown as handled
  // and can't pair with new lines.
  ensureStatementLinesSheet_();
  var handledRows = {};
  getAllRows('Statement Lines').forEach(function (r) { if (STATEMENT_HANDLED_OUTCOMES_[r.outcome]) handledRows[r.line_key] = r; });
  var lineKeys = stmts.map(function (s) { return stmtLineKeys_(s.key, s.lines); });
  var matcherInput = stmts.map(function (s, idx) {
    var pm = pmFor(s.key);
    return { key: s.key + '#' + idx, pmId: pm ? pm.id : ('unknown:' + s.key), kind: s.kind,
      lines: (s.lines || []).map(function (l, i) { return handledRows[lineKeys[idx][i]] ? Object.assign({}, l, { handled: true }) : l; }) };
  });
  // Lines the owner left "waiting" in an EARLIER upload can pair with lines in this one.
  var currentKeys = {};
  lineKeys.forEach(function (arr) { arr.forEach(function (k) { currentKeys[k] = true; }); });
  var storedByAcct = {};
  getAllRows('Statement Lines').forEach(function (r) {
    if (r.outcome !== 'waiting' || currentKeys[r.line_key]) return;
    (storedByAcct[covKey_(r.account_key)] = storedByAcct[covKey_(r.account_key)] || []).push(r);
  });
  var storedInput = {};
  Object.keys(storedByAcct).forEach(function (acctKey) {
    var pmS = pmFor(acctKey);
    if (!pmS) return;
    var pk = 'stored#' + acctKey;
    storedInput[pk] = { key: pk, pmId: pmS.id, kind: 'stored', account: pmS.nickname, rows: storedByAcct[acctKey],
      lines: storedByAcct[acctKey].map(function (r) {
        return { date: r.date, description: r.description, amount: Number(r.amount), currency: r.currency, stored: true, lineKey: r.line_key };
      }) };
    matcherInput.push(storedInput[pk]);
  });
  // Transfers created by loans/repayments are one-sided by nature; the matcher
  // must not offer to "complete" them with another of the owner's accounts.
  var loanTransferIds = {};
  ['Loans', 'Settlements'].forEach(function (t) {
    getAllRows(t).forEach(function (r) { if (r.transfer_entry_id) loanTransferIds[r.transfer_entry_id] = true; });
  });
  var result = matchStatements_(matcherInput, entries, { loanTransferIds: loanTransferIds });
  tick('matcher');
  var entryById = {};
  entries.forEach(function (e) { entryById[e.id] = e; });

  var ctx = buildGuessContext_();
  tick('guess_context');
  // Reversals on a credit card: which charges are already cancelled by an earlier one.
  var reversedIds = {};
  getAllRows('Statement Lines').forEach(function (r) { if (r.outcome === 'reversed' && r.entry_id) reversedIds[r.entry_id] = true; });
  var refundsCat = ensureRefundsCategory_();
  catsById[refundsCat.id] = refundsCat;
  var counts = { lines: 0, matched: 0, unregistered: 0, transferPairs: 0, fees: 0, income: 0, possible: 0, assignAccount: 0, completes: 0, waiting: 0, handled: 0 };

  var out = stmts.map(function (s, idx) {
    var pm = pmFor(s.key);
    var per = result.perLine[matcherInput[idx].key];
    var lines = (s.lines || []).map(function (l, i) {
      var r = per[i];
      var o = { i: i, date: l.date, description: l.description, amount: l.amount, currency: l.currency,
        section: l.section, status: r.status, guess: r.guess };
      counts.lines++;
      var hr = handledRows[lineKeys[idx][i]];
      if (hr) {
        o.handled = { outcome: hr.outcome, entryId: hr.entry_id || '', entry: hr.entry_id && entryById[hr.entry_id] ? stmtEntrySummary_(entryById[hr.entry_id], catsById, pmsById) : null };
        o.status = 'handled';
        counts.handled++;
        return o;
      }
      if (r.status === 'completes') {
        o.completesTransfer = { entry: stmtEntrySummary_(entryById[r.completesTransfer.entryId], catsById, pmsById), side: r.completesTransfer.side, dayDiff: r.completesTransfer.dd };
        counts.completes++;
      } else if (r.status === 'matched') {
        var e = entryById[r.entryId];
        o.entry = stmtEntrySummary_(e, catsById, pmsById);
        o.dayDiff = r.dayDiff;
        o.viaTotal = !!r.viaTotal;
        o.entryHadNoAccount = !!r.entryHadNoAccount;
        counts.matched++;
        if (r.entryHadNoAccount) counts.assignAccount++;
      } else {
        counts.unregistered++;
        if (r.possibleEntry) {
          o.possible = { entry: stmtEntrySummary_(entryById[r.possibleEntry.entryId], catsById, pmsById), dayDiff: r.possibleEntry.dd, shareOf: r.possibleEntry.shareOf || 0 };
          counts.possible++;
        }
        if (r.pairedWith) {
          var pk = r.pairedWith.key, at = pk.lastIndexOf('#');
          if (pk.indexOf('stored#') === 0 && storedInput[pk]) {
            var sl = storedInput[pk].lines[r.pairedWith.i];
            o.pairedWith = { stored: true, lineKey: sl.lineKey, account: storedInput[pk].account, date: sl.date,
              description: sl.description, amount: sl.amount, currency: sl.currency };
          } else {
            o.pairedWith = { statement: Number(pk.substring(at + 1)), line: r.pairedWith.i };
          }
        }
        if (r.guess === 'fee') counts.fees++;
        if (r.guess === 'income') {
          counts.income++;
          // Interest earned is the one kind of income worth registering.
          if (savingsReturn && /INTER[EÉ]S/i.test(l.description)) {
            o.suggestion = { categoryId: savingsReturn.id, categoryName: savingsReturn.name, reason: 'interest earned' };
          } else if (pm && pm.type === 'credit') {
            o.reversal = stmtReversalCandidates_(l, pm, allEntries, reversedIds, refundsCat);
          }
        }
        // Looks like money moving between accounts but no partner line and no open
        // transfer to complete: its other statement simply isn't here (yet).
        if (!r.pairedWith && !o.possible && r.guess !== 'fee' && (r.guess === 'payment' || stmtLooksLikeTransfer_(l.description))) {
          o.waiting = true;
          counts.waiting++;
        }
        // A suggested category for a purchase (history first, then Programmed items).
        if (r.guess === 'expense' && l.amount < 0 && !r.pairedWith) {
          var g = guessFromMerchantHistory_(stmtMerchantKey_(l.description), ctx) ||
            guessFromProgrammed_({ currency: l.currency, amount: Math.abs(l.amount) }, l.date, ctx);
          if (g) o.suggestion = { categoryId: g.categoryId, categoryName: ctx.categoriesById[g.categoryId] ? ctx.categoriesById[g.categoryId].name : '', reason: g.reason };
        }
      }
      return o;
    });
    return {
      key: s.key, kind: s.kind, period: s.period,
      account: pm ? { id: pm.id, nickname: pm.nickname } : null,
      lines: lines
    };
  });
  counts.transferPairs = result.pairs.length;

  // Balance check per statement and currency (see StatementBalance.gs).
  var openingsByPm = buildOpeningsByPm_(pms);
  var confirmedAll = allEntries.filter(function (e) { return e.status === 'confirmed'; });
  var inboundIds = buildInboundTransferIds_();
  var allById = {};
  allEntries.forEach(function (e) { allById[e.id] = e; });
  var balanceChecks = [];
  stmts.forEach(function (s, idx) {
    var pm = pmFor(s.key);
    if (!pm || !s.period || !s.period.end || !s.balances) return;
    Object.keys(s.balances).forEach(function (cur) {
      var b = s.balances[cur];
      if (!b || b.closing === null || b.closing === undefined) return;
      var chk = stmtBalanceCheck_({ pm: pm, currency: cur, closing: b.closing, start: s.period.start, end: s.period.end,
        lines: out[idx].lines, openings: openingsByPm[pm.id] || [], confirmed: confirmedAll, inboundIds: inboundIds, entryById: allById });
      chk.stmt = idx;
      chk.verified = s.verified !== false;
      if (!chk.verified) chk.canSet = false;
      balanceChecks.push(chk);
    });
  });
  tick('done');
  var expenseCats = getAllRows('Categories').filter(function (c) { return c.type === 'expense'; })
    .map(function (c) { return { id: c.id, name: c.name }; });
  var storedConsidered = Object.keys(storedInput).map(function (k) { return { key: k, lines: storedInput[k].lines.length, pmId: storedInput[k].pmId }; });
  var incomeCats = Object.keys(catsById).map(function (k) { return catsById[k]; })
    .filter(function (c) { return c.type === 'income'; }).map(function (c) { return { id: c.id, name: c.name }; });
  return { counts: counts, statements: out, categories: expenseCats, income_categories: incomeCats, balance_checks: balanceChecks, timing_ms: timing, stored_considered: storedConsidered };
}


/**
 * A positive line on a credit card (money back). Finds the charges it could be
 * reversing: same account, currency and exact amount, dated up to 45 days
 * before, not already cancelled. Best first: a shared word in the name, then the
 * closest date. `sameMonth` says whether the reversal falls in the charge's own
 * month (then it cancels the charge; otherwise it is Refunds income).
 */
function stmtReversalCandidates_(l, pm, allEntries, reversedIds, refundsCat) {
  var lo = covAddDays_(l.date, -45);
  var words = significantWords_(String(l.description || '').replace(/^\s*REV\.?\s*/i, ''));
  var cands = allEntries.filter(function (e) {
    return e.type === 'expense' && e.payment_method_id === pm.id && (e.currency || 'PEN') === l.currency &&
      Math.abs(Number(e.amount) - l.amount) < 0.005 && e.date >= lo && e.date <= l.date && !reversedIds[e.id];
  }).map(function (e) {
    var ew = significantWords_(String(e.description || '') + ' ' + String(e.merchant || ''));
    var shared = words.some(function (w) { return ew.indexOf(w) >= 0; });
    return { e: e, shared: shared, gap: Math.round((new Date(l.date) - new Date(e.date)) / 86400000) };
  });
  cands.sort(function (a, b) { return (b.shared - a.shared) || (a.gap - b.gap); });
  var catsById = rowsById_(getAllRows('Categories')), pmsById = rowsById_(getAllRows('Payment Methods'));
  return {
    refundCategoryId: refundsCat.id,
    candidates: cands.slice(0, 6).map(function (c) {
      return { entry: stmtEntrySummary_(c.e, catsById, pmsById), sharedWord: c.shared, daysBefore: c.gap,
        sameMonth: String(c.e.date).substring(0, 7) === String(l.date).substring(0, 7) };
    })
  };
}
