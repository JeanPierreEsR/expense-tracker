/**
 * Cells typed by hand in the Sheet (owner's decision, 2026-11-06). The app reads what is clear (`Confirmed`, `Expense`, `usd`, `12,50`,
 * `2026/11/06`) as if it had been saved properly. A row still unclear (`abc`, `1,234`, `06/11/2026`, an empty date) gets the status
 * `unreadable` and an amount of 0 IN MEMORY, so every list and total leaves it out and nothing can turn a month into NaN; Home names it on
 * one card (getHomeGlance). The Sheet itself is never changed. Runs on every read of Entries and Entry Splits, so a healthy row takes the
 * short way through. See specs/home-tab.md § Rows the app cannot read.
 */

var ENTRY_STATUSES_ = { confirmed: true, pending: true, discarded: true };
var ENTRY_TYPES_ = { expense: true, income: true, transfer: true, investment: true };
var ENTRY_DAY_RE_ = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// A number, or null when the cell does not clearly say one. `1,234` and `1.234` could each be two amounts: never guessed.
function readableAmount_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === '' || v == null || v instanceof Date) return null;
  var s = String(v).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+[.,]\d{1,2}$/.test(s)) return Number(s.replace(',', '.'));
  if (/^-?\d{1,3}(,\d{3})+\.\d{1,2}$/.test(s) || /^-?\d{1,3}(,\d{3}){2,}$/.test(s)) return Number(s.replace(/,/g, ''));
  if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) return Number(s.replace(/\./g, ''));
  return null;
}

// 'yyyy-mm-dd', or null. The year must come first: 06/11/2026 could be June or November.
function readableDay_(v) {
  var m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T ].*)?$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(y, mo, 0).getDate()) return null;
  return m[1] + '-' + pad2_(mo) + '-' + pad2_(d);
}

function sheetColumnLetter_(index) {
  var out = '';
  for (var n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}

function markUnreadable_(obj, headers, rowNumber, fields, original) {
  obj._unreadable = {
    row: rowNumber,
    cells: fields.map(function (f) {
      return { field: f, cell: sheetColumnLetter_(headers.indexOf(f)) + rowNumber, value: String(original[f] == null ? '' : original[f]) };
    })
  };
}

function cleanEntryRow_(obj, headers, rowNumber) {
  if (typeof obj.amount === 'number' && isFinite(obj.amount) && ENTRY_STATUSES_[obj.status] && ENTRY_TYPES_[obj.type] &&
      /^[A-Z]{3}$/.test(obj.currency) && ENTRY_DAY_RE_.test(obj.date)) return obj;
  if (headers.every(function (h) { return obj[h] === '' || obj[h] == null; })) return obj;   // a blank row

  var original = { status: obj.status, type: obj.type, currency: obj.currency, date: obj.date, amount: obj.amount };
  var bad = [];
  var has = function (f) { return headers.indexOf(f) !== -1; };

  var status = String(obj.status == null ? '' : obj.status).trim().toLowerCase();
  if (has('status')) { if (ENTRY_STATUSES_[status]) obj.status = status; else bad.push('status'); }
  var type = String(obj.type == null ? '' : obj.type).trim().toLowerCase();
  if (has('type')) { if (ENTRY_TYPES_[type]) obj.type = type; else bad.push('type'); }
  var currency = String(obj.currency == null ? '' : obj.currency).trim().toUpperCase();
  if (has('currency')) { if (/^[A-Z]{3}$/.test(currency)) obj.currency = currency; else bad.push('currency'); }
  if (has('date')) {
    var day = readableDay_(obj.date);
    if (day) obj.date = day;
    else { bad.push('date'); obj.date = ''; }
  }
  if (has('amount')) {
    // A waiting entry may have no amount yet: the person fills it in on its Needs review card.
    var waitingEmpty = status === 'pending' && (obj.amount === '' || obj.amount == null);
    var amount = readableAmount_(obj.amount);
    if (amount !== null) obj.amount = amount;
    else if (!waitingEmpty) { bad.push('amount'); obj.amount = 0; }
  }
  if (bad.length && status !== 'discarded') {
    obj.status = 'unreadable';
    markUnreadable_(obj, headers, rowNumber, bad, original);
  }
  return obj;
}

function cleanSplitRow_(obj, headers, rowNumber) {
  if (typeof obj.amount === 'number' && isFinite(obj.amount)) return obj;
  if (headers.every(function (h) { return obj[h] === '' || obj[h] == null; })) return obj;
  var original = { amount: obj.amount };
  var amount = readableAmount_(obj.amount);
  if (amount !== null) { obj.amount = amount; return obj; }
  obj.amount = 0;
  markUnreadable_(obj, headers, rowNumber, ['amount'], original);
  return obj;
}

function cleanSheetRow_(sheetName, obj, headers, rowNumber) {
  if (sheetName === 'Entries') return cleanEntryRow_(obj, headers, rowNumber);
  if (sheetName === 'Entry Splits') return cleanSplitRow_(obj, headers, rowNumber);
  return obj;
}

// What Home's card lists: the rows above, and confirmed entries in a currency that has no rate at all (they are left out of the totals
// too, and otherwise nothing would ever say so). At most 5 rows travel; `count` is all of them.
function unreadableSheetRows_() {
  var main = homeCurrency_();
  var rates = buildRatesByCurrency_();
  var rows = [];
  var entries = getAllRows('Entries');
  entries.forEach(function (e, i) {
    if (e._unreadable) {
      e._unreadable.cells.forEach(function (c) {
        rows.push({ sheet: 'Entries', row: e._unreadable.row, cell: c.cell, field: c.field, value: c.value, description: String(e.description || '') });
      });
    } else if (e.status === 'confirmed' && e.currency !== main && !rates[e.currency]) {
      var column = Object.keys(e).indexOf('currency');
      rows.push({ sheet: 'Entries', row: i + 2, cell: sheetColumnLetter_(column) + (i + 2), field: 'currency', value: String(e.currency), description: String(e.description || '') });
    }
  });
  var byId = null;
  getAllRows('Entry Splits').forEach(function (s) {
    if (!s._unreadable) return;
    if (!byId) { byId = {}; entries.forEach(function (e) { byId[e.id] = e; }); }
    var parent = byId[s.entry_id];
    s._unreadable.cells.forEach(function (c) {
      rows.push({ sheet: 'Entry Splits', row: s._unreadable.row, cell: c.cell, field: c.field, value: c.value, description: parent ? String(parent.description || '') : '' });
    });
  });
  if (!rows.length) return null;
  return { count: rows.length, rows: rows.slice(0, 5) };
}

// Text starting with = + - @ would become a formula in a real Sheet (text can come from a bank e-mail, so this is also a safety matter).
// The leading apostrophe tells Google "this is text": it is not part of the value and reading the cell gives the text back unchanged.
// That also means a whole column read and written back must pass through here again. A plain number sent as text ("-5") stays a number.
// Only for the Entries tab, whose free text is not in a plain-text column: a plain-text column (a phone on another tab) could keep the
// apostrophe as part of the value.
function sheetSafeText_(v) {
  if (typeof v !== 'string' || !v) return v;
  var c = v.charAt(0);
  if (c !== '=' && c !== '+' && c !== '-' && c !== '@') return v;
  if (v.trim().length > 1 && !isNaN(Number(v))) return v;
  return "'" + v;
}

function sheetSafeRows_(rows) {
  return rows.map(function (r) { return r.map(sheetSafeText_); });
}
