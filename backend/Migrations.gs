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
        color: CATEGORY_COLOR_PALETTE[getAllRows('Categories').length % CATEGORY_COLOR_PALETTE.length], parent_id: ''
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
  appendRowObject('Account Opening Balances', {
    id: Utilities.getUuid(), payment_method_id: pmId, currency: currency, amount: amount, date: ''
  });
  var row = sheet.getLastRow();
  var dateCell = sheet.getRange(row, headers.indexOf('date') + 1);
  dateCell.setNumberFormat('@');
  dateCell.setValue(date);
  var asOfCell = sheet.getRange(row, headers.indexOf('as_of') + 1);
  asOfCell.setNumberFormat('@');
  asOfCell.setValue(asOf);
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
