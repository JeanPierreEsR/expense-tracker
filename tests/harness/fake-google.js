// A minimal in-memory imitation of the parts of Google Apps Script the
// backend (backend/*.gs) actually uses. Only the PLATFORM is faked here — the
// app's own logic is the real .gs code, loaded unchanged by gas-runtime.js.
//
// Anything the backend calls that isn't imitated throws "FAKE-GOOGLE: ... not
// supported", so a gap shows up loudly instead of silently passing.
// Everything in tests/ is made-up data only; never put real data here.

const crypto = require("crypto");

const TZ = "America/Lima";

function unsupported(what) {
  throw new Error("FAKE-GOOGLE: " + what + " is not supported yet (add it to tests/harness/fake-google.js)");
}

// ---- Dates ----------------------------------------------------------------

function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  f.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  return p;
}

function formatDate(date, tz, fmt) {
  const p = tzParts(date, tz || TZ);
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  let out = "";
  for (let i = 0; i < fmt.length; ) {
    if (fmt[i] === "'") {
      const j = fmt.indexOf("'", i + 1);
      out += fmt.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    const rest = fmt.slice(i);
    const tok = ["yyyy", "MM", "dd", "HH", "mm", "ss", "SSS"].find((t) => rest.startsWith(t));
    if (!tok) {
      if (/[A-Za-z]/.test(fmt[i])) unsupported("date format token '" + fmt[i] + "' in " + fmt);
      out += fmt[i++];
      continue;
    }
    out += ({ yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second, SSS: ms })[tok];
    i += tok.length;
  }
  return out;
}

// Sheets turns a recognisable date string into a real Date when it is written
// to a cell that isn't text-formatted (see the comment above DATE_FIELD_FORMATS
// in Api.gs). Mimicked so the backend's string-normalising code is exercised.
function maybeDate(v) {
  if (typeof v !== "string") return v;
  // "2026-09-30" and also "2026-09" (Sheets reads that as 1 Sep 2026).
  if (/^\d{4}-\d{2}$/.test(v) && Number(v.slice(5)) >= 1 && Number(v.slice(5)) <= 12) return new Date(`${v}-01T00:00:00-05:00`);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  return new Date(`${v}T00:00:00-05:00`);
}

// ---- Spreadsheet ------------------------------------------------------------

// Real Google Sheets is far slower than this in-memory fake, so wall-clock time
// here understates the real app. What carries over is the AMOUNT of sheet work:
// each read call and each cell read is counted, and a request that does 10x the
// reads will be roughly 10x slower on the real sheet too.
const stats = { reads: 0, cellsRead: 0, writes: 0, cellsWritten: 0 };
function resetStats() { stats.reads = 0; stats.cellsRead = 0; stats.writes = 0; stats.cellsWritten = 0; }

class FakeRange {
  constructor(sheet, row, col, nrows, ncols) {
    Object.assign(this, { sheet, row, col, nrows, ncols });
  }
  getValues() { return this.sheet._read(this.row, this.col, this.nrows, this.ncols); }
  getValue() { return this.sheet._read(this.row, this.col, 1, 1)[0][0]; }
  setValues(vals) { this.sheet._write(this.row, this.col, vals); return this; }
  setValue(v) { this.sheet._write(this.row, this.col, [[v]]); return this; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nrows; }
  getNumColumns() { return this.ncols; }
  setNumberFormat(fmt) {
    if (fmt === "@") for (let c = this.col; c < this.col + this.ncols; c++) this.sheet.textCols.add(c);
    return this;
  }
  setFontWeight() { return this; }
  clearContent() {
    for (let r = this.row; r < this.row + this.nrows; r++) {
      const arr = this.sheet.rows[r - 1];
      if (!arr) continue;
      for (let c = this.col; c < this.col + this.ncols; c++) arr[c - 1] = "";
    }
    this.sheet._trim();
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];          // rows[r-1][c-1]
    this.textCols = new Set();
    this.lastCol = 0;
    this.frozen = 0;
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.lastCol; }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  setFrozenRows(n) { this.frozen = n; }
  getRange(row, col, nrows, ncols) {
    if (typeof row !== "number") unsupported("getRange with A1 notation");
    return new FakeRange(this, row, col || 1, nrows || 1, ncols || 1);
  }
  appendRow(values) {
    this._write(this.rows.length + 1, 1, [values]);
  }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  deleteRows(r, n) { this.rows.splice(r - 1, n); }
  _norm(v, col) {
    if (v === undefined || v === null) return "";
    if (this.textCols.has(col)) return v;
    return maybeDate(v);
  }
  _write(row, col, vals) {
    stats.writes++;
    vals.forEach((rv) => { stats.cellsWritten += rv.length; });
    vals.forEach((rv, i) => {
      const r = row + i;
      while (this.rows.length < r) this.rows.push([]);
      const arr = this.rows[r - 1];
      rv.forEach((v, j) => {
        const c = col + j;
        while (arr.length < c) arr.push("");
        arr[c - 1] = this._norm(v, c);
        if (c > this.lastCol && arr[c - 1] !== "") this.lastCol = c;
      });
    });
  }
  _read(row, col, nrows, ncols) {
    stats.reads++;
    stats.cellsRead += nrows * ncols;
    const out = [];
    for (let r = row; r < row + nrows; r++) {
      const src = this.rows[r - 1] || [];
      const line = [];
      for (let c = col; c < col + ncols; c++) {
        const v = src[c - 1];
        line.push(v === undefined ? "" : v);
      }
      out.push(line);
    }
    return out;
  }
  _trim() {
    while (this.rows.length && this.rows[this.rows.length - 1].every((v) => v === "")) this.rows.pop();
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(n) { return this.sheets.get(n) || null; }
  insertSheet(n) {
    const s = new FakeSheet(n);
    this.sheets.set(n, s);
    return s;
  }
  deleteSheet(s) { this.sheets.delete(s.getName()); }
  getSheets() { return [...this.sheets.values()]; }
}

// ---- Everything else -----------------------------------------------------------

// ---- Gmail -----------------------------------------------------------------
// Threads hold messages and labels. search() understands just what the backend
// uses: from:<address>, -label:<name>, newer_than:<N>d (+ start/max).
function buildGmail() {
  const threads = [];
  const labels = new Map();
  let nextId = 1;

  const mkLabel = (name) => ({ getName: () => name });
  const api = {
    getUserLabelByName: (n) => labels.get(n) || null,
    createLabel(n) { const l = mkLabel(n); labels.set(n, l); return l; },
    search(query, start = 0, max = 500) {
      const from = (/from:(\S+)/.exec(query) || [])[1];
      const notLabel = (/-label:(\S+)/.exec(query) || [])[1];
      const mustLabel = (/(?:^|\s)label:(\S+)/.exec(query) || [])[1];
      const days = (/newer_than:(\d+)d/.exec(query) || [])[1];
      const cutoff = days ? Date.now() - Number(days) * 86400000 : 0;
      return threads
        .filter((t) => (!from || t.messages.some((m) => m.getFrom().includes(from))))
        .filter((t) => !notLabel || !t.labelNames.has(notLabel))
        .filter((t) => !mustLabel || t.labelNames.has(mustLabel))
        .filter((t) => t.messages.some((m) => m.getDate().getTime() >= cutoff))
        .slice(start, start + max);
    },
    getMessageById: () => unsupported("GmailApp.getMessageById")
  };

  // Test helper: add an email (own thread unless threadWith is given).
  function addEmail({ from, subject, body, daysAgo = 0, threadWith }) {
    const msg = {
      _id: "m" + nextId++,
      getSubject: () => subject, getPlainBody: () => body, getFrom: () => from,
      getDate: () => new Date(Date.now() - daysAgo * 86400000 + 1000 * nextId),
      getId() { return this._id; }, getAttachments: () => []
    };
    let thread = threadWith;
    if (!thread) {
      thread = {
        messages: [], labelNames: new Set(),
        getMessages() { return this.messages; },
        addLabel(l) { this.labelNames.add(l.getName()); },
        removeLabel(l) { this.labelNames.delete(l.getName()); },
        getFirstMessageSubject() { return this.messages[0].getSubject(); }
      };
      threads.push(thread);
    }
    thread.messages.push(msg);
    return thread;
  }
  return { api, addEmail, threads };
}

function buildServices(state) {
  const ss = new FakeSpreadsheet();
  const props = new Map();
  const cache = new Map();
  const fetchLog = [];
  const uiLog = [];

  const uiChain = {
    addItem() { return uiChain; }, addToUi() { return uiChain; },
    createMenu() { return uiChain; },
    // Tests can script the dialogs: state.promptResponse (text typed into a
    // prompt; unset = the user cancels) and state.alertButton (answer to a
    // yes/no alert; default OK).
    alert(...args) { uiLog.push(args.map(String).join(" | ")); return state.alertButton || "OK"; },
    prompt() {
      return state.promptResponse === undefined
        ? { getSelectedButton: () => "CANCEL", getResponseText: () => "" }
        : { getSelectedButton: () => "OK", getResponseText: () => state.promptResponse };
    },
    ButtonSet: { OK_CANCEL: 1, YES_NO: 2 }, Button: { OK: "OK", CANCEL: "CANCEL", YES: "YES", NO: "NO" }
  };

  const store = (m) => ({
    getProperty: (k) => (m.has(k) ? m.get(k) : null),
    setProperty(k, v) { m.set(k, String(v)); },
    deleteProperty(k) { m.delete(k); },
    getProperties: () => Object.fromEntries(m)
  });

  const gmail = buildGmail();
  return {
    ss, props, cache, fetchLog, uiLog, gmail,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      getUi: () => uiChain
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate,
      DigestAlgorithm: { MD5: "md5", SHA_1: "sha1", SHA_256: "sha256" },
      computeDigest(alg, input) {
        return [...crypto.createHash(alg).update(String(input)).digest()].map((b) => (b > 127 ? b - 256 : b));
      },
      base64Encode: (x) => Buffer.from(typeof x === "string" ? x : Buffer.from(x)).toString("base64"),
      base64EncodeWebSafe: (x) => Buffer.from(typeof x === "string" ? x : Buffer.from(x)).toString("base64url"),
      parseCsv: () => unsupported("Utilities.parseCsv")
    },
    PropertiesService: {
      getScriptProperties: () => store(props),
      getUserProperties: () => store(new Map()),
      getDocumentProperties: () => store(new Map())
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put(k, v) { cache.set(k, String(v)); },
        remove(k) { cache.delete(k); },
        removeAll(ks) { ks.forEach((k) => cache.delete(k)); }
      })
    },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true })
    },
    Session: {
      getScriptTimeZone: () => TZ,
      getActiveUser: () => ({ getEmail: () => "test@example.com" })
    },
    ContentService: {
      MimeType: { JSON: "json", TEXT: "text" },
      createTextOutput(text) {
        const o = { _text: text, setMimeType() { return o; }, getContent: () => text };
        return o;
      }
    },
    // Telegram etc. Every outgoing call is recorded in fetchLog; the reply is
    // whatever state.fetchHandler(url, options) returns (default: Telegram "ok").
    UrlFetchApp: {
      fetch(url, options) {
        fetchLog.push({ url, options });
        const body = state.fetchHandler
          ? state.fetchHandler(url, options)
          : { ok: true, result: { message_id: 1 } };
        return { getContentText: () => JSON.stringify(body), getResponseCode: () => 200 };
      }
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger() {},
      newTrigger: () => unsupported("ScriptApp.newTrigger"),
      getService: () => ({ getUrl: () => "http://localhost/fake-exec" })
    },
    GmailApp: gmail.api,
    DriveApp: new Proxy({}, { get: (_, p) => () => unsupported("DriveApp." + String(p)) }),
    Logger: { log: (...a) => { if (state.verbose) console.log("[Logger]", ...a); } }
  };
}

module.exports = { buildServices, formatDate, TZ, stats, resetStats };
