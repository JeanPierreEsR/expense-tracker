/**
 * One-off data setup: the owner had been registering every Interbank
 * savings account as "Plin". Plin is a payment RAIL, not an account — the
 * money always comes from IBK soles (PEN) or IBK dolares (USD) — and bank
 * statements are per real account, so this creates the three real accounts
 * and moves everything off Plin. Idempotent; dry-run unless
 * payload.dryRun === false.
 *
 *  - Creates payment methods IBK soles (…1040), IBK dolares (…9843) and
 *    IBK sueldo (…4940), debit, under Interbank (last_4 = last four digits
 *    of the account number, which is what the email/statement match on).
 *  - Creates the expense category "Bank fees" (for the ITF tax lines).
 *  - Balances follow "the newest balance the owner registered prevails":
 *    Plin's own balance snapshots (set 2026-09-23) are newer than the Aug 31
 *    statements, so they MOVE, moment (as_of) included, onto IBK soles
 *    (PEN) and IBK dolares (USD). IBK sueldo has none registered, so the
 *    Aug 31 statement closing (5.00) becomes its balance, as of end of day.
 *  - Plin ends with no balance; every Entry/Loan/Settlement that used Plin
 *    is re-pointed by currency (PEN -> IBK soles, USD -> IBK dolares).
 */
function adminSetupIbkAccounts(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, createdPaymentMethods: [], createdCategory: null, balances: [], repointed: {} };

  var bank = getAllRows('Banks').find(function (b) { return b.name === 'Interbank'; });
  if (!bank) throw new Error('Bank "Interbank" not found');
  var pms = getAllRows('Payment Methods');
  var plin = pms.find(function (p) { return p.nickname === 'Plin'; });
  if (!plin) throw new Error('Payment method "Plin" not found');

  var accounts = [
    { nickname: 'IBK soles', last4: '1040', currency: 'PEN' },
    { nickname: 'IBK dolares', last4: '9843', currency: 'USD' },
    { nickname: 'IBK sueldo', last4: '4940', currency: 'PEN' }
  ];
  accounts.forEach(function (a) {
    var pm = pms.find(function (p) { return String(p.nickname).trim() === a.nickname; });
    if (!pm) {
      report.createdPaymentMethods.push(a.nickname);
      pm = dryRun
        ? { id: 'NEW:' + a.nickname }
        : addPaymentMethod({ nickname: a.nickname, type: 'debit', bank_id: bank.id, last_4: a.last4 });
    }
    a.id = pm.id;
  });

  var hasFees = getAllRows('Categories').some(function (c) { return c.type === 'expense' && c.name === 'Bank fees'; });
  if (!hasFees) {
    report.createdCategory = 'Bank fees';
    if (!dryRun) {
      appendRowObject('Categories', {
        id: Utilities.getUuid(), name: 'Bank fees', type: 'expense', icon: '🧾',
        color: CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'bank_fees'
      });
    }
  }

  ensureAccountOpeningBalancesSheet_();
  ensureAccountOpeningBalancesAsOfColumn_();
  var allOpenings = getAllRows('Account Opening Balances');
  function openingsOf(pmId) { return allOpenings.filter(function (r) { return r.payment_method_id === pmId; }); }

  var soles = accounts[0], dolares = accounts[1], sueldo = accounts[2];
  [[soles, 'PEN'], [dolares, 'USD']].forEach(function (pair) {
    var acct = pair[0], cur = pair[1];
    if (openingsOf(acct.id).length) return; // already set up
    var src = openingsOf(plin.id).find(function (r) { return String(r.currency).toUpperCase() === cur; });
    if (!src) return;
    report.balances.push(acct.nickname + ' <- Plin ' + cur + ' ' + src.amount + ' @ ' + src.date + ' ' + (src.as_of || ''));
    if (!dryRun) addOpeningRow_(acct.id, cur, Number(src.amount), src.date, src.as_of || '');
  });
  if (!openingsOf(sueldo.id).length) {
    report.balances.push('IBK sueldo <- statement closing PEN 5.00 @ 2026-08-31 end of day');
    if (!dryRun) addOpeningRow_(sueldo.id, 'PEN', 5, '2026-08-31', '2026-08-31T23:59:59');
  }
  if (!dryRun && openingsOf(plin.id).length) {
    deleteRowsWhere_('Account Opening Balances', function (row) { return row.payment_method_id === plin.id; });
  }

  var byCurrency = { PEN: soles.id, USD: dolares.id };
  report.repointed.entries = repointPlin_('Entries', 'payment_method_id', plin.id, byCurrency, null, dryRun);
  report.repointed.entriesTo = repointPlin_('Entries', 'to_payment_method_id', plin.id, byCurrency, null, dryRun);
  var loanCurrency = {};
  getAllRows('Loans').forEach(function (l) { loanCurrency[l.id] = l.currency; });
  report.repointed.loans = repointPlin_('Loans', 'payment_method_id', plin.id, byCurrency, null, dryRun);
  report.repointed.settlements = repointPlin_('Settlements', 'payment_method_id', plin.id, byCurrency, loanCurrency, dryRun);
  return report;
}

// Same cell handling as setPaymentMethodOpeningBalance: date and as_of are
// plain-text cells so Sheets doesn't turn them into Date values.
function addOpeningRow_(pmId, currency, amount, date, asOf) {
  var sheet = getSheet('Account Opening Balances');
  var headers = getHeaders(sheet);
  var newId = Utilities.getUuid();
  appendRowObject('Account Opening Balances', {
    id: newId, payment_method_id: pmId, currency: currency, amount: amount, date: ''
  });
  var row = sheet.getLastRow();
  var dateCell = sheet.getRange(row, headers.indexOf('date') + 1);
  dateCell.setNumberFormat('@');
  dateCell.setValue(date);
  var asOfCell = sheet.getRange(row, headers.indexOf('as_of') + 1);
  asOfCell.setNumberFormat('@');
  asOfCell.setValue(asOf);
  return newId;
}

// Rewrites one column in place: rows holding Plin's id get the account for
// their currency (a row's own `currency`, or `loan_id`'s currency for
// Settlements). A row whose currency has no target is left alone.
function repointPlin_(sheetName, col, plinId, byCurrency, currencyByLoanId, dryRun) {
  var sheet = getSheet(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var headers = getHeaders(sheet);
  var ci = headers.indexOf(col);
  if (ci === -1) return 0;
  var curIdx = headers.indexOf('currency');
  var loanIdx = headers.indexOf('loan_id');
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var column = [], changed = 0;
  values.forEach(function (row) {
    var v = row[ci];
    if (v === plinId) {
      var cur = currencyByLoanId ? currencyByLoanId[row[loanIdx]] : row[curIdx];
      var target = byCurrency[String(cur || '').toUpperCase()];
      if (target) { v = target; changed++; }
    }
    column.push([v]);
  });
  if (!dryRun && changed) sheet.getRange(2, ci + 1, column.length, 1).setValues(column);
  return changed;
}


/**
 * Same move as adminSetupIbkAccounts, for BCP: every Yape payment leaves one
 * of the owner's BCP accounts (Yape is a rail, like Plin), and BCP
 * statements are per account. Creates BCP soles (…0005) and BCP dolares
 * (…7165) — last_4 = last four digits of the account code, e.g.
 * 000-00000000-0-00 — moves Yape's balance snapshots (newest balance
 * prevails; as_of kept) onto them by currency, and re-points every
 * Entry/Loan/Settlement that used Yape. Idempotent; dry-run unless
 * payload.dryRun === false.
 */
function adminSetupBcpAccounts(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, createdPaymentMethods: [], balances: [], repointed: {} };

  var bank = getAllRows('Banks').find(function (b) { return b.name === 'BCP'; });
  if (!bank) throw new Error('Bank "BCP" not found');
  var pms = getAllRows('Payment Methods');
  var yape = pms.find(function (p) { return p.nickname === 'Yape'; });
  if (!yape) throw new Error('Payment method "Yape" not found');

  var accounts = [
    { nickname: 'BCP soles', last4: '0005', currency: 'PEN' },
    { nickname: 'BCP dolares', last4: '7165', currency: 'USD' }
  ];
  accounts.forEach(function (a) {
    var pm = pms.find(function (p) { return String(p.nickname).trim() === a.nickname; });
    if (!pm) {
      report.createdPaymentMethods.push(a.nickname);
      pm = dryRun
        ? { id: 'NEW:' + a.nickname }
        : addPaymentMethod({ nickname: a.nickname, type: 'debit', bank_id: bank.id, last_4: a.last4 });
    }
    a.id = pm.id;
  });

  ensureAccountOpeningBalancesSheet_();
  ensureAccountOpeningBalancesAsOfColumn_();
  var allOpenings = getAllRows('Account Opening Balances');
  function openingsOf(pmId) { return allOpenings.filter(function (r) { return r.payment_method_id === pmId; }); }
  accounts.forEach(function (a) {
    if (openingsOf(a.id).length) return;
    var src = openingsOf(yape.id).find(function (r) { return String(r.currency).toUpperCase() === a.currency; });
    if (!src) return;
    report.balances.push(a.nickname + ' <- Yape ' + a.currency + ' ' + src.amount + ' @ ' + src.date + ' ' + (src.as_of || ''));
    if (!dryRun) addOpeningRow_(a.id, a.currency, Number(src.amount), src.date, src.as_of || '');
  });
  if (!dryRun && openingsOf(yape.id).length) {
    deleteRowsWhere_('Account Opening Balances', function (row) { return row.payment_method_id === yape.id; });
  }

  var byCurrency = { PEN: accounts[0].id, USD: accounts[1].id };
  var loanCurrency = {};
  getAllRows('Loans').forEach(function (l) { loanCurrency[l.id] = l.currency; });
  report.repointed.entries = repointPlin_('Entries', 'payment_method_id', yape.id, byCurrency, null, dryRun);
  report.repointed.entriesTo = repointPlin_('Entries', 'to_payment_method_id', yape.id, byCurrency, null, dryRun);
  report.repointed.loans = repointPlin_('Loans', 'payment_method_id', yape.id, byCurrency, null, dryRun);
  report.repointed.settlements = repointPlin_('Settlements', 'payment_method_id', yape.id, byCurrency, loanCurrency, dryRun);
  return report;
}


// ======================================================================
// Categories cleanup (2026-10-13) — owner's decisions, see CHANGELOG.md
// § Spanish + English and specs/entries-and-categories.md § Categories:
//  - every built-in category gets a hidden internal `key` (its English name
//    stays stored; Spanish is looked up by key when shown);
//  - "Savings" and "Loan" (expenses AND income) are retired: whatever uses
//    them moves to "Other" of the same type, then they are deleted;
//  - the expense category "Sports" (Deporte) is added.
// "Annual budget" and "AELU" are NOT touched: they stay in the owner's sheet
// (they are only left out of the starter list new users get).
// Idempotent. Dry-run unless payload.dryRun === false, like the other
// admin migrations; run from the sheet menu (items 28 and 29).
// ======================================================================

var RETIRED_CATEGORY_NAMES_ = ['Savings', 'Loan'];

// Same as ensureCategoryPeriodTypeColumn_: an existing sheet can't have its
// headers recreated, so the one missing column is appended in place.
function ensureCategoryKeyColumn_() {
  var sheet = getSheet('Categories');
  var headers = getHeaders(sheet);
  if (headers.indexOf('key') !== -1) return;
  sheet.getRange(1, headers.length + 1).setValue('key');
}

// Rewrites one column of a sheet in place: fn(value, row) returns the new value.
// Returns { changed, ids } (ids of the rows whose value changed).
function rewriteColumn_(sheetName, col, fn, dryRun) {
  var sheet = getSheet(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { changed: 0, ids: [] };
  var headers = getHeaders(sheet);
  var ci = headers.indexOf(col);
  if (ci === -1) return { changed: 0, ids: [] };
  var idCol = headers.indexOf('id');
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = [], ids = [];
  values.forEach(function (row) {
    var row2 = {};
    headers.forEach(function (h, i) { row2[h] = row[i]; });
    var before = row[ci];
    var after = fn(before, row2);
    if (String(after) !== String(before)) { ids.push(idCol === -1 ? '' : row[idCol]); out.push([after]); }
    else out.push([before]);
  });
  if (!dryRun && ids.length) {
    sheet.getRange(2, ci + 1, out.length, 1).setValues(out);
    if (ROWS_MEMO_) delete ROWS_MEMO_[sheetName];
  }
  return { changed: ids.length, ids: ids };
}

function adminMigrateCategories(payload) {
  var dryRun = !payload || payload.dryRun !== false;
  var report = { dryRun: dryRun, tagged: [], notBuiltIn: [], retired: [], added: [], notes: [] };

  if (!dryRun) ensureCategoryKeyColumn_();
  var cats = getAllRows('Categories');

  // 1) Retire first (so Savings/Loan are not tagged and then deleted)
  var retiredIds = {};
  ['expense', 'income'].forEach(function (type) {
    var other = cats.filter(function (c) { return c.type === type && String(c.name).trim() === 'Other'; })[0];
    cats.filter(function (c) { return c.type === type && RETIRED_CATEGORY_NAMES_.indexOf(String(c.name).trim()) !== -1; })
      .forEach(function (gone) {
        var item = { type: type, name: gone.name, entries: 0, budgets: 0, programmed: 0, overrides: 0, children: 0, movedTo: other ? other.name : null };
        if (!other) {
          report.notes.push('No "Other" ' + type + ' category exists, so "' + gone.name + '" (' + type + ') was left alone.');
          report.retired.push(item);
          return;
        }
        retiredIds[gone.id] = other.id;
        // Entries
        var e = rewriteColumn_('Entries', 'category_id', function (v) { return v === gone.id ? other.id : v; }, dryRun);
        item.entries = e.changed;
        if (!dryRun && e.ids.length) touchEntriesById_(e.ids);
        // Budgets: a list of category ids; replace and dedupe
        var b = rewriteColumn_('Budgets', 'category_id', function (v) {
          if (v === 'ALL') return v;
          var ids = parseBudgetCategoryIds_(v);
          if (ids.indexOf(gone.id) === -1) return v;
          var next = [];
          ids.forEach(function (id) { var r = id === gone.id ? other.id : id; if (next.indexOf(r) === -1) next.push(r); });
          return next.join(',');
        }, dryRun);
        item.budgets = b.changed;
        // Programmed (recurring / one-time) items and manual projection overrides
        item.programmed = rewriteColumn_('Recurring Expenses', 'category_id', function (v) { return v === gone.id ? other.id : v; }, dryRun).changed;
        item.overrides = rewriteColumn_('Projection Overrides', 'category_id', function (v) { return v === gone.id ? other.id : v; }, dryRun).changed;
        // Sub-categories that pointed at it as their parent become top-level
        item.children = rewriteColumn_('Categories', 'parent_id', function (v) { return v === gone.id ? '' : v; }, dryRun).changed;
        report.retired.push(item);
      });
  });
  if (!dryRun && Object.keys(retiredIds).length) {
    deleteRowsWhere_('Categories', function (c) { return retiredIds[c.id] !== undefined; });
    cats = getAllRows('Categories');
  } else if (dryRun) {
    cats = cats.filter(function (c) { return retiredIds[c.id] === undefined; });
  }

  // 2) Internal keys for the built-in categories that still carry their original name
  cats.forEach(function (c) {
    if (c.key) return;
    var k = categoryKeyFromName_(c.name);
    var t = CATEGORY_TRANSLATIONS_[k];
    if (t && t.en === String(c.name)) {
      report.tagged.push(c.type + ': ' + c.name + ' -> ' + k);
      if (!dryRun) updateRowFields_('Categories', c.id, { key: k });
    } else {
      report.notBuiltIn.push(c.type + ': ' + c.name);
    }
  });

  // 3) Sports (expense)
  var hasSports = cats.some(function (c) { return c.type === 'expense' && (c.key === 'sports' || String(c.name).trim() === 'Sports'); });
  if (!hasSports) {
    report.added.push('expense: Sports');
    if (!dryRun) {
      appendRowObject('Categories', {
        id: Utilities.getUuid(), name: 'Sports', type: 'expense', icon: '⚽',
        color: CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length], parent_id: '', key: 'sports'
      });
    }
  }

  if (!dryRun) bumpStructureVersion_();
  return report;
}

// What the owner sees when running the sheet menu items.
function categoriesCleanupText_(r) {
  var lines = [r.dryRun ? 'PREVIEW — nothing was changed.' : 'DONE.'];
  r.retired.forEach(function (x) {
    lines.push('Retire ' + x.type + ' "' + x.name + '" -> ' + (x.movedTo ? 'moved to "' + x.movedTo + '": ' : 'NOT moved: ') +
      x.entries + ' entries, ' + x.budgets + ' budgets, ' + x.programmed + ' programmed items, ' + x.overrides + ' projection overrides' +
      (x.children ? ', ' + x.children + ' sub-categories' : ''));
  });
  if (!r.retired.length) lines.push('Nothing to retire (already done).');
  lines.push('Keys ' + (r.dryRun ? 'to add' : 'added') + ': ' + r.tagged.length);
  if (r.notBuiltIn.length) lines.push('Left as typed (no key): ' + r.notBuiltIn.join('; '));
  if (r.added.length) lines.push((r.dryRun ? 'Would add: ' : 'Added: ') + r.added.join(', '));
  r.notes.forEach(function (n) { lines.push('NOTE: ' + n); });
  return lines.join('\n');
}

function menuCategoriesCleanupPreview() {
  SpreadsheetApp.getUi().alert('Categories cleanup', categoriesCleanupText_(adminMigrateCategories({ dryRun: true })), SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuCategoriesCleanupApply() {
  var ui = SpreadsheetApp.getUi();
  var preview = categoriesCleanupText_(adminMigrateCategories({ dryRun: true }));
  var answer = ui.alert('Apply this categories cleanup?',
    preview + '\n\nTip: File > Make a copy of this sheet first. Apply now?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;
  ui.alert('Categories cleanup', categoriesCleanupText_(adminMigrateCategories({ dryRun: false })), ui.ButtonSet.OK);
}
