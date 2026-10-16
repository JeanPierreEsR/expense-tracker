/**
 * App-speed reports from friends' phones (and the owner's own), collected in the owner's Sheet.
 *
 * Each phone times its own server calls (docs/app.js "Performance log") and, if the person agreed, sends the new
 * timings here from time to time. This is the ONLY action that needs no sign-in: friends' phones are not signed in
 * to the owner's copy. So everything is checked hard:
 *   - only a fixed set of numbers/words is accepted; any other field in a report is thrown away, so no amount,
 *     description, name or account can end up here even by accident;
 *   - the free-text "label" (the friend's first name) is reduced to letters, digits and a few marks, so it can
 *     never be read as a spreadsheet formula;
 *   - rows are only ever APPENDED; every report carries a number (`seq`) that grows per install, and anything at
 *     or below the last number already stored for that install is ignored, so a re-sent report never duplicates;
 *   - size/rate caps: 200 entries per request, 4,000 entries per install per day, 300,000 rows in total.
 * Friends' own copies refuse these reports (only the owner's copy collects them).
 * The tab is written to only here: it is not in TABLE_DEFINITIONS, so nothing else reads or edits it.
 */

var PERF_REPORTS_SHEET_ = 'Perf Reports';
var PERF_REPORT_HEADERS_ = ['received_at', 'install_id', 'label', 'seq', 'at', 'kind', 'action',
  'total_ms', 'server_ms', 'cold', 'attempts', 'ok', 'app_version', 'device'];
var PERF_MAX_BATCH_ = 200;
var PERF_MAX_PER_INSTALL_PER_DAY_ = 4000;
var PERF_MAX_ROWS_ = 300000;   // x 14 columns = 4.2 million cells, well inside the 10 million a spreadsheet may hold
var PERF_DEVICES_ = { iPhone: 1, iPad: 1, Android: 1, Mac: 1, Windows: 1, Other: 1,
  'iPhone (home screen)': 1, 'iPad (home screen)': 1, 'Android (home screen)': 1, 'Mac (home screen)': 1, 'Windows (home screen)': 1, 'Other (home screen)': 1 };

function ensurePerfReportsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PERF_REPORTS_SHEET_);
  if (sheet) return sheet;
  sheet = ss.insertSheet(PERF_REPORTS_SHEET_);
  var headerRange = sheet.getRange(1, 1, 1, PERF_REPORT_HEADERS_.length);
  headerRange.setValues([PERF_REPORT_HEADERS_]);
  headerRange.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // timestamps and ids must stay text (Sheets would turn "2026-10-16T…" into its own date type)
  sheet.getRange(1, 1, sheet.getMaxRows(), PERF_REPORT_HEADERS_.length).setNumberFormat('@');
  return sheet;
}

function perfInt_(v, min, max) {
  var n = Number(v);
  if (typeof v === 'boolean' || v === null || v === '' || !isFinite(n) || Math.floor(n) !== n || n < min || n > max) return null;
  return n;
}

// Letters, digits, spaces and . - _ ' only; must start with a letter or digit; at most 30 characters.
function perfLabel_(raw) {
  var s = String(raw === undefined || raw === null ? '' : raw);
  s = s.replace(/[^\p{L}\p{N} .\-_']/gu, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  return s.substring(0, 30);
}

function perfIso_(ms) {
  return Utilities.formatDate(new Date(ms), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

// One entry -> one sheet row, or null when it is not a well-formed timing entry.
function perfRow_(e, batch, nowMs, receivedAt) {
  if (!e || typeof e !== 'object') return null;
  var seq = perfInt_(e.s, 1, 2000000000);
  var t = perfInt_(e.t, nowMs - 400 * 86400000, nowMs + 2 * 86400000);
  var total = perfInt_(e.tm, 0, 3600000);
  if (seq === null || t === null || total === null) return null;
  if (e.k !== 'call' && e.k !== 'startup') return null;
  var name = String(e.n === undefined || e.n === null ? '' : e.n);
  if (!/^[A-Za-z0-9_:.→ -]{1,60}$/.test(name)) return null;
  var server = e.sm === null || e.sm === undefined ? '' : perfInt_(e.sm, 0, 3600000);
  if (server === null) return null;
  var attempts = e.k === 'call' ? perfInt_(e.a, 1, 20) : '';
  if (attempts === null) return null;
  return [receivedAt, batch.install, batch.label, seq, perfIso_(t), e.k, name, total, server,
    e.k === 'call' ? (e.c ? 'yes' : 'no') : '', attempts, e.k === 'call' ? (e.o === false ? 'no' : 'yes') : '',
    batch.app, batch.device];
}

// Called by doPost BEFORE the sign-in check (see Api.gs). Returns { ack, stored[, full] }: `ack` is the highest
// seq the phone may now delete from its own outbox (everything at or below it is stored, was already stored, or was
// malformed and is being dropped).
function reportPerf_(p) {
  if (isFriendCopy_()) throw codedError_('perf_not_collected', 'This copy does not collect performance reports.');
  p = p || {};
  var install = String(p.install || '');
  if (!/^[0-9a-f-]{16,36}$/.test(install)) throw codedError_('perf_bad_report', 'Not a performance report.');
  var batch = {
    install: install,
    label: perfLabel_(p.label) || '(no name)',
    app: /^[0-9A-Za-z:.\-]{1,30}$/.test(String(p.app || '')) ? String(p.app) : '',
    device: PERF_DEVICES_[String(p.device || '')] ? String(p.device) : 'Other'
  };
  var entries = Array.isArray(p.entries) ? p.entries.slice(0, PERF_MAX_BATCH_) : [];
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw codedError_('perf_busy', 'Busy, try again later.');
  try {
    var seqKey = 'perfseq:' + install;
    var last = Number(props.getProperty(seqKey) || 0);
    var nowMs = Date.now();
    var receivedAt = perfIso_(nowMs);
    var rows = [];
    var top = last;
    entries.forEach(function (e) {
      var s = perfInt_(e && e.s, 1, 2000000000);
      if (s === null || s <= last) return;      // already stored (a re-send), or not a real entry number
      if (s > top) top = s;
      var row = perfRow_(e, batch, nowMs, receivedAt);
      if (row) rows.push(row);
    });
    rows.sort(function (a, b) { return a[3] - b[3]; });
    // never the same seq twice, even inside one request
    rows = rows.filter(function (r, i) { return i === 0 || r[3] !== rows[i - 1][3]; });
    if (!rows.length) {
      if (top > last) props.setProperty(seqKey, String(top));
      return { ack: top, stored: 0 };
    }
    var cache = CacheService.getScriptCache();
    var dayKey = 'perfday:' + install + ':' + receivedAt.substring(0, 10);
    var today = Number(cache.get(dayKey) || 0);
    if (today + rows.length > PERF_MAX_PER_INSTALL_PER_DAY_) throw codedError_('perf_busy', 'Too many reports today, try again tomorrow.');
    var sheet = ensurePerfReportsSheet_();
    var used = sheet.getLastRow() - 1;
    // Full: refuse WITHOUT acknowledging, so phones keep their entries (up to their own size limit) until the owner
    // has archived the tab — nothing is thrown away by the backend.
    if (used + rows.length > PERF_MAX_ROWS_) throw codedError_('perf_full', 'The performance report tab is full.');
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, PERF_REPORT_HEADERS_.length).setValues(rows);
    props.setProperty(seqKey, String(top));
    cache.put(dayKey, String(today + rows.length), 90000);
    // One heads-up on Telegram when the tab passes 80% of its limit, so it can be archived before it fills.
    if (used + rows.length >= PERF_MAX_ROWS_ * 0.8 && !props.getProperty('PERF_FULL_WARNED')) {
      props.setProperty('PERF_FULL_WARNED', 'yes');
      try { sendTelegramText_(tr_('perf.tabNearlyFull', { n: used + rows.length, max: PERF_MAX_ROWS_ })); } catch (err) { console.error('perf warning: ' + err); }
    }
    return { ack: top, stored: rows.length };
  } finally {
    lock.releaseLock();
  }
}
