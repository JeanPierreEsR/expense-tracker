/**
 * Small counts from friends' phones (and the installer page) that help the owner improve the app, collected in the
 * owner's Sheet tab "Beta Events". Same door and same rules as the app-speed reports (PerfReports.gs):
 *   - it is the second action that needs no sign-in (friends' phones are not signed in to the owner's copy), so every
 *     field is checked hard: only a fixed list of kinds, names (setup steps) and short codes is accepted; any other
 *     field is thrown away, so no amount, text, name or account can end up here even by accident;
 *   - the free-text "label" (the friend's first name) is reduced to letters, digits and a few marks (perfLabel_);
 *   - rows are only ever APPENDED; every entry has a number (`seq`) that grows per install, anything at or below the
 *     last stored number is ignored, so a re-sent report never duplicates;
 *   - caps: 100 entries per request, 600 per install per day, 100,000 rows in total (Telegram heads-up at 80%).
 * Kinds (the beta learning plan): "setup" = a step the installer page reached (name from a fixed list, `n` =
 * seconds since the person tapped the first button), "error" = an app action that failed (name = the action's own name,
 * `detail` = a short error code, never the message), "queue" = what the person did with ONE pending entry in the review
 * queue (name = confirmed / edited / discarded, `detail` = the bank it came from, from the bank catalog, or where else it
 * came from), "queue_edit" = one field they changed on it (name = which field, never its content), "screen" = how many
 * times a screen was opened in one week (name from a fixed list, `detail` = the week "w2026_43", `n` = the count).
 * Friends' own copies refuse these reports. The tab is written only here (not in TABLE_DEFINITIONS).
 */

var BETA_SHEET_ = 'Beta Events';
var BETA_HEADERS_ = ['received_at', 'install_id', 'label', 'seq', 'at', 'kind', 'name', 'detail', 'n', 'app_version', 'device'];
var BETA_MAX_BATCH_ = 100;
var BETA_MAX_PER_INSTALL_PER_DAY_ = 600;
var BETA_MAX_ROWS_ = 100000;   // x 11 columns = 1.1 million cells, well inside the 10 million a spreadsheet may hold
// The steps the installer page reports (docs/setup/index.html). Anything else is dropped.
var BETA_SETUP_NAMES_ = { tapped: 1, api_switch_needed: 1, sheet_created: 1, app_created: 1, sent_to_google: 1,
  back_from_google: 1, help_card_shown: 1, approved: 1, ready: 1, step_failed: 1 };

// The screens of the app (docs/index.html, id="screen-…", hyphens as underscores) — the only names a "screen" count may carry.
var BETA_SCREENS_ = { entries: 1, overview: 1, budgets: 1, projections: 1, loans: 1, more: 1, recurring: 1, accounts: 1,
  categories: 1, trips: 1, trip_detail: 1, exchange_rates: 1, perf: 1, export: 1, statements: 1 };
var BETA_QUEUE_OUTCOMES_ = { confirmed: 1, edited: 1, discarded: 1 };
var BETA_QUEUE_FIELDS_ = { category: 1, category_filled: 1, amount: 1, description: 1, account: 1 };
// Where a pending entry came from when it is not a bank e-mail (or the e-mail's bank has no account in the app).
var BETA_QUEUE_PLACES_ = { no_account: 1, other_bank: 1, photo: 1, shortcut: 1, import: 1, manual: 1, other_source: 1 };

// The same rule the phone uses (PerfShare.bankSlug in docs/perf-share.js): lower case, no accents, other characters become "_".
function betaSlug_(name) {
  return String(name === undefined || name === null ? '' : name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 30);
}

// A bank's slug is kept only if it is a bank of the app's own catalog; a bank the person typed in themselves becomes "other_bank".
function betaQueueDetail_(detail) {
  if (BETA_QUEUE_PLACES_.hasOwnProperty(detail)) return detail;
  var known = bankCatalogNames_().concat(BANK_NAMES);
  for (var i = 0; i < known.length; i++) if (betaSlug_(known[i]) === detail) return detail;
  return 'other_bank';
}

function ensureBetaEventsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BETA_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(BETA_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, BETA_HEADERS_.length);
  headerRange.setValues([BETA_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, sheet.getMaxRows(), BETA_HEADERS_.length).setNumberFormat('@');   // see ensurePerfReportsSheet_
  return sheet;
}

// One entry -> one sheet row, or null when it is not a well-formed beta entry.
function betaRow_(e, batch, nowMs, receivedAt) {
  if (!e || typeof e !== 'object') return null;
  var seq = perfInt_(e.s, 1, 2000000000);
  var t = perfInt_(e.t, nowMs - 400 * 86400000, nowMs + 2 * 86400000);
  var n = perfInt_(e.v, 0, 1000000000);
  if (seq === null || t === null || n === null) return null;
  var name = String(e.n === undefined || e.n === null ? '' : e.n);
  var detail = String(e.d === undefined || e.d === null ? '' : e.d);
  if (detail !== '' && !/^[a-z0-9_]{1,40}$/.test(detail)) return null;
  if (e.k === 'setup') {
    if (!BETA_SETUP_NAMES_.hasOwnProperty(name)) return null;
  } else if (e.k === 'error') {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(name) || detail === '') return null;
  } else if (e.k === 'queue') {
    if (!BETA_QUEUE_OUTCOMES_.hasOwnProperty(name)) return null;
    detail = betaQueueDetail_(detail);
  } else if (e.k === 'queue_edit') {
    if (!BETA_QUEUE_FIELDS_.hasOwnProperty(name)) return null;
    detail = betaQueueDetail_(detail);
  } else if (e.k === 'screen') {
    if (!BETA_SCREENS_.hasOwnProperty(name) || !/^w\d{4}_\d{2}$/.test(detail) || n < 1) return null;
  } else {
    return null;
  }
  return [receivedAt, batch.install, batch.label, seq, perfIso_(t), e.k, name, detail, n, batch.app, batch.device];
}

// Called by doPost BEFORE the sign-in check (see Api.gs). Returns { ack, stored }: `ack` is the highest seq the phone may
// now forget (stored, already stored, or malformed and being dropped).
function reportBeta_(p) {
  if (isFriendCopy_()) throw codedError_('beta_not_collected', 'This copy does not collect beta reports.');
  p = p || {};
  var install = String(p.install || '');
  if (!/^[0-9a-f-]{16,36}$/.test(install)) throw codedError_('beta_bad_report', 'Not a beta report.');
  var batch = {
    install: install,
    label: perfLabel_(p.label) || '(no name)',
    app: /^[0-9A-Za-z:.\-]{1,30}$/.test(String(p.app || '')) ? String(p.app) : '',
    device: PERF_DEVICES_[String(p.device || '')] ? String(p.device) : 'Other'
  };
  var entries = Array.isArray(p.entries) ? p.entries.slice(0, BETA_MAX_BATCH_) : [];
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw codedError_('beta_busy', 'Busy, try again later.');
  try {
    var seqKey = 'betaseq:' + install;
    var last = Number(props.getProperty(seqKey) || 0);
    var nowMs = Date.now();
    var receivedAt = perfIso_(nowMs);
    var rows = [];
    var top = last;
    entries.forEach(function (e) {
      var s = perfInt_(e && e.s, 1, 2000000000);
      if (s === null || s <= last) return;      // already stored (a re-send), or not a real entry number
      if (s > top) top = s;
      var row = betaRow_(e, batch, nowMs, receivedAt);
      if (row) rows.push(row);
    });
    rows.sort(function (a, b) { return a[3] - b[3]; });
    rows = rows.filter(function (r, i) { return i === 0 || r[3] !== rows[i - 1][3]; });   // never the same seq twice
    if (!rows.length) {
      if (top > last) props.setProperty(seqKey, String(top));
      return { ack: top, stored: 0 };
    }
    var cache = CacheService.getScriptCache();
    var dayKey = 'betaday:' + install + ':' + receivedAt.substring(0, 10);
    var today = Number(cache.get(dayKey) || 0);
    if (today + rows.length > BETA_MAX_PER_INSTALL_PER_DAY_) throw codedError_('beta_busy', 'Too many reports today, try again tomorrow.');
    var sheet = ensureBetaEventsSheet_();
    var used = sheet.getLastRow() - 1;
    // Full: refused WITHOUT acknowledging, so phones keep their entries until the owner has archived the tab.
    if (used + rows.length > BETA_MAX_ROWS_) throw codedError_('beta_full', 'The beta events tab is full.');
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, BETA_HEADERS_.length).setValues(rows);
    props.setProperty(seqKey, String(top));
    cache.put(dayKey, String(today + rows.length), 90000);
    if (used + rows.length >= BETA_MAX_ROWS_ * 0.8 && !props.getProperty('BETA_FULL_WARNED')) {
      props.setProperty('BETA_FULL_WARNED', 'yes');
      try { sendTelegramText_(tr_('beta.tabNearlyFull', { n: used + rows.length, max: BETA_MAX_ROWS_ })); } catch (err) { console.error('beta warning: ' + err); }
    }
    return { ack: top, stored: rows.length };
  } finally {
    lock.releaseLock();
  }
}
