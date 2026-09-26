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
 *   match            { stmt, line, entryId, overwriteAccount? } line IS that entry
 *   complete_transfer{ stmt, line, entryId, side } fills the blank end of a transfer
 *   assign_account   { stmt, line, entryId }  entry has no account yet
 *   link             { stmt, line, entryId }  remember a matched line (no change)
 *   ignore / wait    { stmt, line }
 *   set_balance      { stmt, currency }      the statement's closing balance becomes the
 *                                            account's registered balance — only when the
 *                                            statement is NEWER than the current one
 */

var STATEMENT_LINES_COLUMNS_ = ['id', 'line_key', 'account_key', 'period_end', 'date', 'description',
  'amount', 'currency', 'outcome', 'entry_id', 'batch_id', 'created_at'];
var STATEMENT_CHANGES_COLUMNS_ = ['id', 'batch_id', 'sheet', 'row_id', 'field', 'old_value', 'new_value', 'created_at'];
var STATEMENT_HANDLED_OUTCOMES_ = { matched: true, added: true, recorded: true, completed: true, ignored: true };

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

function stmtPmForKey_(pms, key) {
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
  var sheet = getSheet(sheetName);
  var headers = getHeaders(sheet);
  var rows = objs.map(function (o) { return headers.map(function (h) { return o[h] !== undefined ? o[h] : ''; }); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/**
 * payload: { dryRun, filename, statements: [{ key, kind, period, file_name, verified, balances, lines }],
 *            actions: [...] }
 */
function applyStatementDecisions(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var stmts = payload.statements || [];
  var actions = payload.actions || [];
  var report = { dryRun: dryRun, batchId: null, created: { transfers: 0, fees: 0, purchases: 0 }, changed: 0,
    linesRemembered: 0, statementsRecorded: 0, skippedExisting: 0, warnings: [] };

  var pms = getAllRows('Payment Methods');
  var pmsById = rowsById_(pms);
  var openingsByPm = buildOpeningsByPm_(pms);
  var balanceOps = [];
  var catByName = {};
  var cats = getAllRows('Categories');
  var catsById = rowsById_(cats);
  cats.forEach(function (c) { catByName[c.type + ':' + c.name] = c.id; });

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
      if (!row || row.outcome !== 'waiting') throw new Error('That earlier statement line is no longer waiting');
      return { s: { key: row.account_key, period: { end: row.period_end } },
        l: { date: row.date, description: row.description, amount: Number(row.amount), currency: row.currency },
        key: ref.stored, pm: stmtPmForKey_(pms, row.account_key), stmt: -1, idx: ref.stored };
    }
    var s = stmts[ref.stmt];
    if (!s || !s.lines[ref.line]) throw new Error('Unknown statement line');
    return { s: s, l: s.lines[ref.line], key: keys[ref.stmt][ref.line], pm: accounts[ref.stmt], stmt: ref.stmt, idx: ref.line };
  }

  // Entries, read once (values + row lookup) so changes are written column-wise.
  var sheet = getSheet('Entries');
  var headers = getHeaders(sheet);
  var lastRow = sheet.getLastRow();
  var values = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues() : [];
  var col = {};
  ['id', 'type', 'payment_method_id', 'to_payment_method_id', 'merchant', 'external_id', 'description', 'amount', 'currency', 'date'].forEach(function (h) { col[h] = headers.indexOf(h); });
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
    if (usedLines[k]) throw new Error('A statement line was given two actions');
    usedLines[k] = true;
  }
  function remember(L, outcome, entryId) {
    outcomes.push({ id: Utilities.getUuid(), line_key: L.key, account_key: covKey_(L.s.key), period_end: (L.s.period || {}).end || '',
      date: L.l.date, description: L.l.description, amount: Number(L.l.amount), currency: L.l.currency,
      outcome: outcome, entry_id: entryId || '', batch_id: batchId, created_at: now });
  }
  function setCell(entryId, field, newValue) {
    var i = rowById[String(entryId)];
    if (i === undefined) throw new Error('Entry not found: ' + entryId);
    var old = values[i][col[field]];
    if (String(old) === String(newValue)) return;
    changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Entries', row_id: String(entryId), field: field,
      old_value: String(old === undefined || old === null ? '' : old), new_value: String(newValue), created_at: now });
    values[i][col[field]] = newValue;
    colChanged[field] = true;
    report.changed++;
  }
  function requirePm(L) { if (!L.pm) throw new Error('No account is set up for statement ' + L.s.key); return L.pm; }
  function newEntry(o) {
    if (existingExternal[o.external_id]) { report.skippedExisting++; return false; }
    existingExternal[o.external_id] = true;
    o.id = Utilities.getUuid();
    o.paid_by = 'me'; o.source = 'import'; o.import_batch_id = batchId; o.created_at = now;
    o.merchant = o.merchant || ''; o.to_payment_method_id = o.to_payment_method_id || '';
    creations.push(o);
    return true;
  }

  actions.forEach(function (a) {
    if (a.type === 'record_transfer') {
      var out = line(a.out), inn = line(a.in);
      useLine(out); useLine(inn);
      if (out.l.amount >= 0 || inn.l.amount <= 0 || out.l.currency !== inn.l.currency || Math.abs(Math.abs(out.l.amount) - inn.l.amount) >= 0.005) {
        throw new Error('The two lines are not the same transfer (opposite signs, same amount and currency)');
      }
      var from = requirePm(out), to = requirePm(inn);
      var catId = catByName['transfer:Between Accounts'];
      if (!catId) throw new Error('Category "Between Accounts" is missing');
      var made = newEntry({ type: 'transfer', date: out.l.date, amount: inn.l.amount, currency: out.l.currency, category_id: catId,
        description: 'Transfer ' + from.nickname + ' → ' + to.nickname, payment_method_id: from.id, to_payment_method_id: to.id,
        status: 'confirmed', external_id: 'stmt-' + out.key });
      if (made) report.created.transfers++;
      var eid = made ? creations[creations.length - 1].id : '';
      remember(out, 'recorded', eid); remember(inn, 'recorded', eid);
    } else if (a.type === 'record_fee') {
      var f = line(a); useLine(f);
      if (f.l.amount >= 0) throw new Error('A fee must be money going out');
      var feeCat = catByName['expense:Bank fees'];
      if (!feeCat) throw new Error('Category "Bank fees" is missing');
      var madeFee = newEntry({ type: 'expense', date: f.l.date, amount: Math.abs(f.l.amount), currency: f.l.currency, category_id: feeCat,
        description: stmtFeeDescription_(f.l.description), payment_method_id: requirePm(f).id, status: 'confirmed', external_id: 'stmt-' + f.key });
      if (madeFee) report.created.fees++;
      remember(f, 'recorded', madeFee ? creations[creations.length - 1].id : '');
    } else if (a.type === 'add_purchase') {
      var p = line(a); useLine(p);
      if (p.l.amount >= 0) throw new Error('A purchase must be money going out');
      var catP = '';
      if (a.category) {
        if (!catsById[a.category] || catsById[a.category].type !== 'expense') throw new Error('Unknown expense category');
        catP = a.category;
      }
      var madeP = newEntry({ type: 'expense', date: p.l.date, amount: Math.abs(p.l.amount), currency: p.l.currency, category_id: catP,
        description: a.description ? String(a.description) : stmtCleanDescription_(p.l.description), payment_method_id: requirePm(p).id,
        status: 'pending', external_id: 'stmt-' + p.key, merchant: stmtMerchantKey_(p.l.description) });
      if (madeP) report.created.purchases++;
      remember(p, 'added', madeP ? creations[creations.length - 1].id : '');
    } else if (a.type === 'match' || a.type === 'assign_account' || a.type === 'link') {
      var m = line(a); useLine(m);
      var i = rowById[String(a.entryId)];
      if (i === undefined) throw new Error('Entry not found: ' + a.entryId);
      if (a.type !== 'link') {
        var pm = requirePm(m);
        var curFrom = values[i][col.payment_method_id], curTo = values[i][col.to_payment_method_id];
        if (!curFrom && !curTo) setCell(a.entryId, 'payment_method_id', pm.id);
        else if (a.type === 'match' && a.overwriteAccount && !curTo && curFrom !== pm.id) setCell(a.entryId, 'payment_method_id', pm.id);
        if (a.type === 'match' && !values[i][col.merchant] && stmtMerchantKey_(m.l.description)) setCell(a.entryId, 'merchant', stmtMerchantKey_(m.l.description));
        if (a.type === 'match' && !values[i][col.external_id]) setCell(a.entryId, 'external_id', 'stmt-' + m.key);
      }
      remember(m, 'matched', a.entryId);
    } else if (a.type === 'complete_transfer') {
      var c = line(a); useLine(c);
      var j = rowById[String(a.entryId)];
      if (j === undefined) throw new Error('Entry not found: ' + a.entryId);
      if (values[j][col.type] !== 'transfer') throw new Error('Not a transfer');
      var field = a.side === 'to' ? 'to_payment_method_id' : 'payment_method_id';
      if (values[j][col[field]]) throw new Error('That end of the transfer is already filled in');
      setCell(a.entryId, field, requirePm(c).id);
      remember(c, 'completed', a.entryId);
    } else if (a.type === 'set_balance') {
      var sb = stmts[a.stmt];
      var pmB = accounts[a.stmt];
      if (!sb || !pmB) throw new Error('Unknown statement or account for the balance');
      if (sb.verified === false) throw new Error('A statement that could not be verified cannot set a balance');
      var bal = (sb.balances || {})[a.currency];
      if (!bal || bal.closing === null || bal.closing === undefined) throw new Error('This statement has no closing balance in ' + a.currency);
      if (!sb.period || !sb.period.end) throw new Error('This statement has no end date');
      var ownRow = (openingsByPm[pmB.id] || []).find(function (o) { return o.currency === a.currency; });
      if (ownRow && !(sb.period.end > ownRow.date)) throw new Error('The balance registered on ' + ownRow.date + ' is not older than this statement, so it stays');
      balanceOps.push({ pm: pmB, currency: a.currency, amount: Math.round(Number(bal.closing) * 100) / 100, date: sb.period.end });
    } else if (a.type === 'ignore' || a.type === 'wait') {
      var g = line(a); useLine(g);
      remember(g, a.type === 'ignore' ? 'ignored' : 'waiting', '');
    } else {
      throw new Error('Unknown action: ' + a.type);
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
  report.linesRemembered = outcomes.length;
  report.batchEntries = creations.map(function (e) { return { type: e.type, date: e.date, amount: e.amount, currency: e.currency, description: e.description, status: e.status }; });

  if (dryRun) return report;

  // ---- writes ----
  ensureStatementLinesSheet_();
  ensureStatementChangesSheet_();
  report.batchId = batchId;
  ensureImportBatchRow_(batchId, payload.filename || 'Statement upload', creations.length);
  appendRowsBulk_('Entries', creations);
  Object.keys(colChanged).forEach(function (f) {
    var colValues = values.map(function (r) { return [r[col[f]]]; });
    if (values.length) sheet.getRange(2, col[f] + 1, values.length, 1).setValues(colValues);
  });

  var usheet = getSheet('Statement Uploads');
  var uheaders = getHeaders(usheet);
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
      appendRowObject('Statement Uploads', Object.assign({ id: newId, account_key: op.acctKey,
        account_label: (accounts[op.si] ? accounts[op.si].nickname + ' …' + op.acctKey : op.acctKey),
        payment_method_id: accounts[op.si] ? accounts[op.si].id : '', kind: op.s.kind,
        period_start: (op.s.period || {}).start || '', period_end: op.s.period.end }, fields));
      changes.push({ id: Utilities.getUuid(), batch_id: batchId, sheet: 'Statement Uploads', row_id: newId, field: '__created__',
        old_value: '', new_value: '', created_at: now });
    }
  });

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

  // Statement Uploads: delete rows this batch created, restore rows it updated.
  var usheet = getSheet('Statement Uploads');
  var uheaders = getHeaders(usheet);
  changes.filter(function (c) { return c.sheet === 'Statement Uploads'; }).forEach(function (c) {
    if (c.field === '__created__') {
      deleteRowsWhere_('Statement Uploads', function (row) { return row.id === c.row_id; });
      res.uploadsRestored++;
    } else {
      var ri = findRowIndexById(usheet, uheaders, c.row_id);
      if (ri !== -1) setCellByRow_(usheet, uheaders, ri, c.field, c.old_value);
    }
  });

  // Account Opening Balances: remove the rows this batch created, bring back the ones it replaced.
  changes.filter(function (c) { return c.sheet === 'Account Opening Balances'; }).forEach(function (c) {
    if (c.field === '__created__') deleteRowsWhere_('Account Opening Balances', function (row) { return row.id === c.row_id; });
  });
  changes.filter(function (c) { return c.sheet === 'Account Opening Balances' && c.field === '__deleted__'; }).forEach(function (c) {
    try {
      var r = JSON.parse(c.old_value);
      addOpeningRow_(r.payment_method_id, String(r.currency).toUpperCase(), Number(r.amount), String(r.date), String(r.as_of || ''));
      res.balancesRestored = (res.balancesRestored || 0) + 1;
    } catch (e) { /* unreadable — leave */ }
  });

  // Statement Lines: forget this batch's, restore what it replaced.
  var forgotten = getAllRows('Statement Lines').filter(function (r) { return r.batch_id === batchId; }).length;
  deleteRowsWhere_('Statement Lines', function (row) { return row.batch_id === batchId; });
  res.forgottenLines = forgotten;
  var restore = [];
  changes.filter(function (c) { return c.sheet === 'Statement Lines' && c.field === '__deleted__'; }).forEach(function (c) {
    try { restore.push(JSON.parse(c.old_value)); } catch (e) { /* skip unreadable */ }
  });
  appendRowsBulk_('Statement Lines', restore);

  res.deletedEntries = getAllRows('Entries').filter(function (e) { return e.import_batch_id === batchId; }).length;
  deleteRowsWhere_('Entries', function (row) { return row.import_batch_id === batchId; });
  deleteRowsWhere_('Import Batches', function (row) { return row.id === batchId; });
  deleteRowsWhere_('Statement Changes', function (row) { return row.batch_id === batchId; });
  return res;
}

/** The most recent uploads that can still be undone. */
function listStatementBatches() {
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
  }).sort(function (x, y) { return x.processed_at < y.processed_at ? 1 : -1; }).slice(0, 5);
}

/** Existing entries near a date — for the "match this line to an entry" picker. */
function getEntriesNear(payload) {
  var days = Number(payload.days) || 10;
  var lo = covAddDays_(payload.date, -days), hi = covAddDays_(payload.date, days);
  var catsById = rowsById_(getAllRows('Categories'));
  var pmsById = rowsById_(getAllRows('Payment Methods'));
  return getAllRows('Entries').filter(function (e) {
    return e.date >= lo && e.date <= hi && (!payload.currency || e.currency === payload.currency);
  }).map(function (e) { return stmtEntrySummary_(e, catsById, pmsById); })
    .sort(function (a, b) { return Math.abs(stmtDayNumber_(a.date) - stmtDayNumber_(payload.date)) - Math.abs(stmtDayNumber_(b.date) - stmtDayNumber_(payload.date)); })
    .slice(0, 60);
}
