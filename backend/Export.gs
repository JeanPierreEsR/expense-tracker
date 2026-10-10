/**
 * Export data (More tab → Export data).
 *
 * The app asks for either or both of two files and the SERVER emails them
 * to the owner — nothing large travels through the phone, and there is no
 * download to fight with in the installed iPhone app.
 *
 *   entries — a spreadsheet (CSV) of entries with readable names, for a date
 *             range, optionally including pending ones.
 *   backup  — one JSON file with the raw rows of every data tab.
 *
 * The destination is NEVER taken from the request: it is the script
 * property EXPORT_EMAIL (set once with admin_setExportEmail). The web app's
 * URL is public, so a typed-in address would let anyone holding the access
 * code mail the data elsewhere. Keeping the address in a property also
 * keeps it out of the public repo.
 *
 * Read-only: nothing here writes to a sheet.
 */

// Raw tabs in the backup. Left out on purpose: Sessions (sign-in key
// hashes), Settings, Telegram Messages, Processed Emails and the alert logs
// (internal bookkeeping), Category Keywords (no longer used), and the
// statement / photo working tabs (temporary scratch data, rebuilt from the
// bank files). A tab that doesn't exist yet (several self-create on first
// use) is simply skipped.
var EXPORT_BACKUP_TABS_ = [
  'Entries', 'Entry Splits', 'Entry Tags', 'Entry Bills',
  'Categories', 'Tags', 'Payment Methods', 'Banks', 'Account Opening Balances',
  'Exchange Rates', 'Friends', 'Payors', 'Loans', 'Settlements', 'Budgets',
  'Recurring Expenses', 'Recurring Skips', 'Recurring Expense Splits',
  'Projection Overrides', 'Period Templates', 'Import Batches'
];

var EXPORT_MAX_BYTES_ = 20 * 1024 * 1024;   // Gmail's limit is 25 MB per message

var EXPORT_CSV_HEADERS_ = [
  'ID', 'Date', 'Type', 'Description', 'Merchant', 'Category',
  'Amount', 'Currency', 'Amount (PEN)', 'Your share', 'Your share (PEN)', 'Split with',
  'Payment method', 'To account', 'Paid by', 'Linked friend', 'Linked as',
  'Tags', 'Status', 'Source', 'Created at'
];

function exportData(payload) {
  payload = payload || {};
  var cards = payload.cards || [];
  var wantEntries = cards.indexOf('entries') !== -1;
  var wantBackup = cards.indexOf('backup') !== -1;
  if (!wantEntries && !wantBackup) throw new Error('Choose at least one file to send.');

  var to = getExportEmail_();
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var stamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  var blobs = [];
  var files = [];
  var bytes = 0;
  function addFile(name, mime, text, kind, rows) {
    var blob = Utilities.newBlob(text, mime, name);
    bytes += text.length;
    blobs.push(blob);
    files.push({ kind: kind, name: name, rows: rows });
  }

  if (wantEntries) {
    var range = exportDateRange_(payload);
    var csv = buildEntriesCsv_({
      startDate: range.startDate, endDate: range.endDate, includePending: !!payload.includePending
    });
    var label = range.startDate || range.endDate ? (range.startDate || 'start') + '_to_' + (range.endDate || 'today') : 'all-time';
    // The leading BOM makes Excel / Numbers read the accents as UTF-8.
    addFile('entries_' + label + '.csv', 'text/csv', '﻿' + csv.text, 'entries', csv.rows);
  }
  if (wantBackup) {
    var backup = buildBackupJson_(now);
    addFile('backup_' + stamp + '.json', 'application/json', backup.text, 'backup', backup.rows);
  }

  if (bytes > EXPORT_MAX_BYTES_) {
    throw new Error('The export is too large to email (' + Math.round(bytes / 1048576) + ' MB). Try a shorter date range, or send only one file.');
  }
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error("Google's daily email limit has been reached. Try again tomorrow.");

  var lines = files.map(function (f) { return '- ' + f.name + ' (' + f.rows + ' ' + (f.kind === 'entries' ? 'entries' : 'rows across all tabs') + ')'; });
  MailApp.sendEmail({
    to: to,
    subject: 'Expense tracker export — ' + stamp,
    body: 'Your export is attached.\n\n' + lines.join('\n'),
    attachments: blobs,
    name: 'Expense tracker'
  });
  return { sent: true, files: files };
}

// ---- Destination ----

function getExportEmail_() {
  var email = String(PropertiesService.getScriptProperties().getProperty('EXPORT_EMAIL') || '').trim();
  if (!email) throw new Error('No export email address is set up yet.');
  return email;
}

function adminSetExportEmail(payload) {
  var email = String((payload && payload.email) || '').trim();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email)) throw new Error('That does not look like an email address.');
  PropertiesService.getScriptProperties().setProperty('EXPORT_EMAIL', email);
  return { done: true };
}

/**
 * Run ONCE from the Apps Script editor after this feature is pushed (and
 * BEFORE `clasp deploy`): it makes Google ask you to approve the new
 * "send email" permission. Until it is approved, deploying would break every
 * endpoint of the web app, because the live version asks for a permission
 * nobody has granted. It sends nothing.
 */
function authorizeExportMail() {
  Logger.log('Email sending is authorized. Daily quota left: ' + MailApp.getRemainingDailyQuota());
}

// ---- Entries CSV ----

function exportDateRange_(payload) {
  var re = /^\d{4}-\d{2}-\d{2}$/;
  var start = payload.startDate ? String(payload.startDate) : '';
  var end = payload.endDate ? String(payload.endDate) : '';
  if ((start && !re.test(start)) || (end && !re.test(end))) throw new Error('Dates must look like 2026-01-31.');
  if (start && end && start > end) throw new Error('The start date is after the end date.');
  return { startDate: start, endDate: end };
}

function buildEntriesCsv_(opts) {
  var entries = getAllRows('Entries').filter(function (e) {
    if (e.status !== 'confirmed' && !(opts.includePending && e.status === 'pending')) return false;
    if (opts.startDate && e.date < opts.startDate) return false;
    if (opts.endDate && e.date > opts.endDate) return false;
    return true;
  });
  // Oldest first: the natural order for a spreadsheet (the app lists newest first).
  entries.sort(function (a, b) { return compareEntriesRecency_(b, a); });

  var lk = buildSearchLookups_();
  var splitsByEntry = {};
  getAllRows('Entry Splits').forEach(function (s) {
    (splitsByEntry[s.entry_id] = splitsByEntry[s.entry_id] || []).push(s);
  });

  var lines = [EXPORT_CSV_HEADERS_.map(function (h) { return csvCell_(h); }).join(',')];
  entries.forEach(function (e) {
    var amount = Number(e.amount);
    var splits = splitsByEntry[e.id] || [];
    var splitSum = splits.reduce(function (sum, s) { return sum + Number(s.amount); }, 0);
    // Same definition as listEntries: only an expense is reduced by what was split off.
    var share = e.type === 'expense' ? amount - splitSum : amount;
    var amountPen = computeAmountPen(amount, e.currency, e.date);
    var sharePen = computeAmountPen(share, e.currency, e.date);

    var cat = lk.categoriesById[e.category_id];
    var parent = cat && cat.parent_id ? lk.categoriesById[cat.parent_id] : null;
    var category = cat ? (parent ? parent.name + ' › ' + cat.name : cat.name) : '';
    var method = lk.methodsById[e.payment_method_id];
    var toMethod = lk.methodsById[e.to_payment_method_id];
    var link = lk.transferLinks[e.id];

    var paidBy = '';
    if (e.paid_by === 'me') paidBy = 'Me';
    else if (e.paid_by) {
      var payer = e.type === 'income' ? lk.payorsById[e.paid_by] : lk.friendsById[e.paid_by];
      paidBy = payer ? payer.name : String(e.paid_by);
    }

    var splitWith = splits.map(function (s) {
      var f = lk.friendsById[s.friend_id];
      return (f ? f.name : String(s.friend_id)) + ' ' + exportMoney_(Number(s.amount));
    }).join('; ');

    var linkedAs = '';
    if (link) {
      linkedAs = (link.kind === 'repayment' ? 'Repayment' : 'Loan') +
        (link.direction === 'they_owe_me' ? ' (they owe me)' : link.direction === 'i_owe_them' ? ' (I owe them)' : '');
    }

    lines.push([
      csvCell_(e.id), csvCell_(e.date), csvCell_(e.type), csvCell_(e.description), csvCell_(e.merchant), csvCell_(category),
      amount, csvCell_(e.currency), amountPen == null ? '' : exportMoney_(amountPen), exportMoney_(share), sharePen == null ? '' : exportMoney_(sharePen),
      csvCell_(splitWith),
      csvCell_(method ? method.nickname : ''), csvCell_(toMethod ? toMethod.nickname : ''), csvCell_(paidBy),
      csvCell_(link ? link.friend : ''), csvCell_(linkedAs),
      csvCell_((lk.tagNamesByEntry[e.id] || []).join('; ')), csvCell_(e.status), csvCell_(e.source), csvCell_(e.created_at)
    ].join(','));
  });
  return { text: lines.join('\r\n') + '\r\n', rows: entries.length };
}

function exportMoney_(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

// One CSV cell. Quoted when it holds a comma, quote or line break. A text
// that starts with = + - @ would be run as a formula by Excel / Numbers
// (descriptions come from bank emails and photos, i.e. from outside), so it
// gets a leading single quote, which spreadsheets show as plain text. Only
// used for text columns; amounts are written as bare numbers.
function csvCell_(value) {
  var s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---- Full backup ----

function buildBackupJson_(now) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tables = {};
  var total = 0;
  EXPORT_BACKUP_TABS_.forEach(function (name) {
    if (!ss.getSheetByName(name)) return;
    var rows = getAllRows(name);
    tables[name] = rows;
    total += rows.length;
  });
  var text = JSON.stringify({
    exported_at: now.toISOString(),
    note: 'Raw rows of each data tab, exactly as stored (amounts stay in their original currency).',
    tables: tables
  });
  return { text: text, rows: total };
}
