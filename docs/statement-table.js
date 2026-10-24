/**
 * Spreadsheet statements (Fill my history, phase 3): turns a CSV or Excel (.xlsx) file the bank lets the person download into
 * the same lines the PDF readers produce — { date, description, amount, currency } — so the rest of the flow (matching,
 * transfers, Fill my history, Undo) is unchanged.
 *
 * Everything runs on the phone (the file is never uploaded) and in Node (tests). No libraries: a CSV reader, and a small
 * .xlsx reader (a zip of XML, opened with the browser's own DecompressionStream). Legacy .xls is not supported.
 *
 * The person never types a pattern: guessMapping() looks at the header words (Spanish and English) and at the values,
 * and the screen lets them correct any column. Nothing here talks to the server.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StatementTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- text ----------

  // UTF-8 when the bytes are valid UTF-8, otherwise Windows-1252 (what Excel's "CSV" saves in Latin-American locales).
  function decodeText(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch (e) { text = new TextDecoder('windows-1252').decode(u8); }
    return text.charAt(0) === '﻿' ? text.slice(1) : text;
  }

  function norm(s) {
    return String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // ---------- CSV ----------

  function detectDelimiter(text) {
    var sample = text.split(/\r?\n/).slice(0, 12).join('\n');
    var best = ',', bestScore = -1;
    [',', ';', '\t', '|'].forEach(function (d) {
      var inQuotes = false, perLine = [], n = 0;
      for (var i = 0; i < sample.length; i++) {
        var c = sample[i];
        if (c === '"') inQuotes = !inQuotes;
        else if (!inQuotes && c === d) n++;
        else if (!inQuotes && c === '\n') { perLine.push(n); n = 0; }
      }
      perLine.push(n);
      var nonEmpty = perLine.filter(function (x) { return x > 0; });
      // The delimiter is the one that shows up the same (non-zero) number of times on most lines.
      if (!nonEmpty.length) return;
      var counts = {};
      nonEmpty.forEach(function (x) { counts[x] = (counts[x] || 0) + 1; });
      var common = Math.max.apply(null, Object.keys(counts).map(function (k) { return counts[k]; }));
      var score = common * 1000 + nonEmpty[0];
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function parseCsv(text, delimiter) {
    var d = delimiter || detectDelimiter(text);
    var rows = [], row = [], cell = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
        } else cell += c;
      } else if (c === '"' && cell === '') {
        inQuotes = true;
      } else if (c === d) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows
      .map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.some(function (x) { return x !== ''; }); });
  }

  // ---------- .xlsx ----------

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('xlsx-no-inflate');
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // { 'xl/workbook.xml': async () => Uint8Array, ... } from the zip's central directory.
  function zipEntries(bytes) {
    var eocd = -1;
    for (var i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('xlsx-not-zip');
    var count = u16(bytes, eocd + 10), p = u32(bytes, eocd + 16), out = {};
    for (var n = 0; n < count; n++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('xlsx-not-zip');
      var method = u16(bytes, p + 10), csize = u32(bytes, p + 20);
      var nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32), local = u32(bytes, p + 42);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      (function (method, csize, local) {
        out[name] = async function () {
          var start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
          var data = bytes.subarray(start, start + csize);
          return method === 0 ? data : inflateRaw(data);
        };
      })(method, csize, local);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  function xmlText(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, e) {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }

  function attr(tag, name) {
    var m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
    return m ? xmlText(m[1]) : '';
  }

  function sharedStrings(xml) {
    var out = [], re = /<si\b[^>]*>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      var s = '', t = /<t\b[^>]*>([\s\S]*?)<\/t>/g, tm;
      while ((tm = t.exec(body))) s += tm[1];
      out.push(xmlText(s));
    }
    return out;
  }

  var BUILTIN_DATE_FORMATS = {};
  [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58].forEach(function (id) { BUILTIN_DATE_FORMATS[id] = true; });

  // A custom number-format code ("dd/mm/yyyy", "[$-409]d mmm yy") that shows a date: it has d/m/y/h letters outside quotes and brackets.
  function isDateFormatCode(code) {
    var c = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dmyh]/i.test(c) && !/^[#0.,?_*%()\- ]*$/.test(c);
  }

  // style index -> is it a date format
  function dateStyles(xml) {
    var custom = {}, re = /<numFmt\b[^>]*>/g, m;
    while ((m = re.exec(xml))) {
      custom[attr(m[0], 'numFmtId')] = isDateFormatCode(attr(m[0], 'formatCode'));
    }
    var xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml), out = [];
    if (!xfs) return out;
    var x = /<xf\b[^>]*>/g, xm;
    while ((xm = x.exec(xfs[1]))) {
      var id = attr(xm[0], 'numFmtId');
      out.push(!!BUILTIN_DATE_FORMATS[id] || !!custom[id]);
    }
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoFromSerial(serial) {
    var d = new Date(Math.round((serial - 25569) * 86400000));
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function colIndex(ref) {
    var letters = /^[A-Z]+/.exec(ref)[0], n = 0;
    for (var i = 0; i < letters.length; i++) n = n * 26 + letters.charCodeAt(i) - 64;
    return n - 1;
  }

  // The first sheet of the workbook as rows of cell values. Dates come back as 'YYYY-MM-DD' text, numbers as numbers.
  async function readXlsx(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var z = zipEntries(u8);
    var read = async function (name) { return z[name] ? new TextDecoder().decode(await z[name]()) : ''; };
    var sheetPath = 'xl/worksheets/sheet1.xml';
    var wb = await read('xl/workbook.xml'), rels = await read('xl/_rels/workbook.xml.rels');
    var first = /<sheet\b[^>]*>/.exec(wb);
    if (first) {
      var rid = attr(first[0], 'r:id');
      var rel = new RegExp('<Relationship\\b[^>]*Id="' + rid + '"[^>]*>').exec(rels);
      if (rel) { var target = attr(rel[0], 'Target').replace(/^\//, ''); sheetPath = /^xl\//.test(target) ? target : 'xl/' + target; }
    }
    if (!z[sheetPath]) {
      sheetPath = Object.keys(z).filter(function (n) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(n); }).sort()[0];
      if (!sheetPath) throw new Error('xlsx-no-sheet');
    }
    var strings = sharedStrings(await read('xl/sharedStrings.xml'));
    var isDate = dateStyles(await read('xl/styles.xml'));
    var xml = await read(sheetPath), rows = [];
    var rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g, rm;
    while ((rm = rowRe.exec(xml))) {
      var rowTag = rm[0].slice(0, rm[0].indexOf('>') + 1);
      var r = [];
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cellRe.exec(rm[1] || ''))) {
        var ref = attr(cm[1], 'r'), type = attr(cm[1], 't'), style = Number(attr(cm[1], 's') || 0), inner = cm[2] || '';
        var v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner), val = v ? xmlText(v[1]) : '';
        var out;
        if (type === 's') out = strings[Number(val)] || '';
        else if (type === 'inlineStr') { var t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner); out = t ? xmlText(t[1]) : ''; }
        else if (type === 'str' || type === 'e') out = val;
        else if (type === 'b') out = val === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'd') out = val.slice(0, 10);
        else if (val === '') out = '';
        else { var num = Number(val); out = isDate[style] && num > 0 && num < 80000 ? isoFromSerial(num) : num; }
        var idx = ref ? colIndex(ref) : r.length;
        while (r.length < idx) r.push('');
        r[idx] = out;
      }
      var rn = Number(attr(rowTag, 'r'));
      if (rn) while (rows.length < rn - 1) rows.push([]);
      rows.push(r);
    }
    return rows.map(function (r) { return r.map(function (x) { return typeof x === 'string' ? x.trim() : x; }); })
      .filter(function (r) { return r.some(function (x) { return x !== ''; }); });
  }

  // ---------- .xls (an OLE2 container holding BIFF records) ----------

  var NOSECT = 0xFFFFFFFA;   // sector ids at or above this are markers (end of chain, free, FAT sector…)

  // The bytes of the workbook stream inside an OLE2 compound file. Throws 'xls-unreadable' when there is none.
  function cfbWorkbook(u8) {
    var ssz = 1 << u16(u8, 30), mssz = 1 << u16(u8, 32);
    var dirStart = u32(u8, 48), cutoff = u32(u8, 56) || 4096, miniStart = u32(u8, 60), difatStart = u32(u8, 68), nDifat = u32(u8, 72);
    function sectorOff(id) { return (id + 1) * ssz; }
    var difat = [], i, j;
    for (i = 0; i < 109; i++) { var v = u32(u8, 76 + 4 * i); if (v < NOSECT) difat.push(v); }
    for (var next = difatStart, d = 0; d < nDifat && next < NOSECT; d++) {
      var off = sectorOff(next);
      for (j = 0; j < ssz / 4 - 1; j++) { var w = u32(u8, off + 4 * j); if (w < NOSECT) difat.push(w); }
      next = u32(u8, off + ssz - 4);
    }
    var fat = [];
    difat.forEach(function (sid) { var o = sectorOff(sid); for (var k = 0; k < ssz / 4; k++) fat.push(u32(u8, o + 4 * k)); });
    function chain(start, table) {
      var out = [], id = start, guard = 0;
      while (id < NOSECT && guard++ <= table.length) { out.push(id); id = table[id]; }
      return out;
    }
    function readChain(start, size) {
      var ids = chain(start, fat), buf = new Uint8Array(ids.length * ssz);
      ids.forEach(function (id, n) { buf.set(u8.subarray(sectorOff(id), sectorOff(id) + ssz), n * ssz); });
      return size === undefined ? buf : buf.subarray(0, size);
    }
    var dir = readChain(dirStart), entries = [];
    for (var o = 0; o + 128 <= dir.length; o += 128) {
      var nameLen = Math.max(0, u16(dir, o + 64) - 2);
      entries.push({ name: new TextDecoder('utf-16le').decode(dir.subarray(o, o + nameLen)), type: dir[o + 66], start: u32(dir, o + 116), size: u32(dir, o + 120) });
    }
    var root = entries[0], book = entries.filter(function (e) { return e.type === 2 && /^(workbook|book)$/i.test(e.name); })[0];
    if (!root || !book) throw new Error('xls-unreadable');
    if (book.size >= cutoff) return readChain(book.start, book.size);
    // A small workbook lives in the "mini stream": 64-byte pieces chained through the mini FAT.
    var mini = readChain(root.start, root.size), miniFatBytes = readChain(miniStart), miniFat = [];
    for (i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
    var ids = chain(book.start, miniFat), out = new Uint8Array(ids.length * mssz);
    ids.forEach(function (id, n) { out.set(mini.subarray(id * mssz, id * mssz + mssz), n * mssz); });
    return out.subarray(0, book.size);
  }

  // RK numbers pack a number into 32 bits: bit 0 = divide by 100, bit 1 = the rest is an integer (else the top bits of a double).
  function rkValue(rk) {
    var v;
    if (rk & 2) v = rk >> 2;
    else { var dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, (rk & 0xFFFFFFFC) >>> 0, true); v = dv.getFloat64(0, true); }
    return (rk & 1) ? v / 100 : v;
  }

  // The strings of the shared string table. `segs` = the SST record's data followed by the data of each CONTINUE record. A string that
  // runs over a segment boundary restarts with one flags byte (8-bit or 16-bit characters) in the next segment.
  function sstStrings(segs) {
    var si = 0, off = 0, out = [];
    function more() { if (off >= segs[si].length && si + 1 < segs.length) { si++; off = 0; return true; } return off < segs[si].length; }
    function u8n() { return more() ? segs[si][off++] : 0; }
    function u16n() { var a = u8n(); return a | (u8n() << 8); }
    function u32n() { var a = u16n(); return (a + u16n() * 65536) >>> 0; }
    function skip(n) { while (n > 0 && more()) { var t = Math.min(n, segs[si].length - off); off += t; n -= t; } }
    function chars(cch, high) {
      var text = '', left = cch;
      while (left > 0) {
        if (off >= segs[si].length) { if (si + 1 >= segs.length) break; si++; off = 0; high = (segs[si][off++] & 1) === 1; }
        var per = high ? 2 : 1, can = Math.min(left, Math.floor((segs[si].length - off) / per));
        if (can === 0) { off = segs[si].length; continue; }
        for (var k = 0; k < can; k++) {
          text += String.fromCharCode(high ? segs[si][off] | (segs[si][off + 1] << 8) : segs[si][off]);
          off += per;
        }
        left -= can;
      }
      return text;
    }
    skip(4); var unique = u32n();
    for (var n = 0; n < unique && (off < segs[si].length || si + 1 < segs.length); n++) {
      var cch = u16n(), flags = u8n(), runs = (flags & 8) ? u16n() : 0, ext = (flags & 4) ? u32n() : 0;
      out.push(chars(cch, (flags & 1) === 1));
      skip(runs * 4); skip(ext);
    }
    return out;
  }

  // The first worksheet of an old Excel file (BIFF5 and BIFF8) as rows of cell values; dates come back as 'YYYY-MM-DD' text.
  function readXls(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var s = cfbWorkbook(u8), dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    var biff8 = true, date1904 = false, firstSheet = -1, xfFormat = [], formatIsDate = {}, strings = [];
    function recAt(p) { return { id: u16(s, p), len: u16(s, p + 2), at: p + 4 }; }
    function latin(a, b) { var t = ''; for (var i = a; i < b; i++) t += String.fromCharCode(s[i]); return t; }
    function utf16(a, b) { var t = ''; for (var i = a; i + 1 < b; i += 2) t += String.fromCharCode(s[i] | (s[i + 1] << 8)); return t; }
    function isDateXf(xf) { var f = xfFormat[xf]; return f !== undefined && (!!BUILTIN_DATE_FORMATS[f] || !!formatIsDate[f]); }

    // -- workbook globals: formats, styles, shared strings, where the first sheet starts --
    var p = 0;
    if (u16(s, 0) !== 0x0809) throw new Error('xls-unreadable');
    biff8 = u16(s, 4) >= 0x0600;
    while (p + 4 <= s.length) {
      var r = recAt(p);
      if (r.id === 0x000A) break;   // EOF of the globals
      if (r.id === 0x002F) throw new Error('xls-encrypted');
      if (r.id === 0x0022) date1904 = u16(s, r.at) === 1;
      else if (r.id === 0x0085 && firstSheet < 0 && s[r.at + 5] === 0) firstSheet = u32(s, r.at);
      else if (r.id === 0x00E0) xfFormat.push(u16(s, r.at + 2));
      else if (r.id === 0x041E) {
        var fcch = biff8 ? u16(s, r.at + 2) : s[r.at + 2];
        var code = biff8 ? ((s[r.at + 4] & 1) ? utf16(r.at + 5, r.at + 5 + fcch * 2) : latin(r.at + 5, r.at + 5 + fcch)) : latin(r.at + 3, r.at + 3 + fcch);
        formatIsDate[u16(s, r.at)] = isDateFormatCode(code);
      } else if (r.id === 0x00FC) {
        var segs = [s.subarray(r.at, r.at + r.len)], q = p + 4 + r.len;
        while (q + 4 <= s.length && u16(s, q) === 0x003C) { var c = recAt(q); segs.push(s.subarray(c.at, c.at + c.len)); q += 4 + c.len; }
        strings = sstStrings(segs);
        p = q; continue;
      }
      p += 4 + r.len;
    }
    if (firstSheet < 0) throw new Error('xls-unreadable');

    // -- the sheet's cells --
    var rows = [], pendingText = null;
    function put(row, col, value) { var line = rows[row] || (rows[row] = []); while (line.length < col) line.push(''); line[col] = value; }
    function number(xf, n) { return isDateXf(xf) && n > 0 && n < 80000 ? isoFromSerial(date1904 ? n + 1462 : n) : n; }
    function bytesText(at, cch, hasFlags) {
      if (!biff8) return latin(at, at + cch);
      var high = (s[at] & 1) === 1;
      return high ? utf16(at + 1, at + 1 + cch * 2) : latin(at + 1, at + 1 + cch);
    }
    for (p = firstSheet; p + 4 <= s.length;) {
      var h = recAt(p), a = h.at, row = u16(s, a), col = u16(s, a + 2), xf = u16(s, a + 4);
      if (h.id === 0x000A) break;
      if (h.id === 0x00FD) put(row, col, strings[u32(s, a + 6)] || '');
      else if (h.id === 0x0203) put(row, col, number(xf, dv.getFloat64(a + 6, true)));
      else if (h.id === 0x027E) put(row, col, number(xf, rkValue(u32(s, a + 6))));
      else if (h.id === 0x00BD) {
        var count = (h.len - 6) / 6;
        for (var m = 0; m < count; m++) put(row, col + m, number(u16(s, a + 4 + 6 * m), rkValue(u32(s, a + 6 + 6 * m))));
      } else if (h.id === 0x0204) put(row, col, bytesText(a + 8, u16(s, a + 6)));
      else if (h.id === 0x0006) {
        if (u16(s, a + 12) === 0xFFFF) {
          var kind = s[a + 6];
          if (kind === 0) pendingText = { row: row, col: col };   // the text arrives in the STRING record that follows
          else if (kind === 1) put(row, col, s[a + 8] ? 'TRUE' : 'FALSE');
          else put(row, col, '');
        } else put(row, col, number(xf, dv.getFloat64(a + 6, true)));
      } else if (h.id === 0x0207 && pendingText) {
        put(pendingText.row, pendingText.col, bytesText(h.at + 2, u16(s, h.at)));
        pendingText = null;
      }
      p += 4 + h.len;
    }
    for (var i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows.map(function (rw) { return rw.map(function (x) { return typeof x === 'string' ? x.trim() : x; }); })
      .filter(function (rw) { return rw.some(function (x) { return x !== ''; }); });
  }

  // ---------- HTML tables (many banks save an HTML page with an .xls name) ----------

  var NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
    Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü' };
  function htmlText(s) {
    return s.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return NAMED_ENTITIES[e] !== undefined ? NAMED_ENTITIES[e] : m;
    }).replace(/\s+/g, ' ').trim();
  }
  // The table with the most rows on the page, as rows of text.
  function parseHtmlTable(text) {
    var best = [], tables = text.match(/<table\b[\s\S]*?<\/table>/gi) || [text];
    tables.forEach(function (t) {
      var rows = [], rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, rm;
      while ((rm = rowRe.exec(t))) {
        var cells = [], cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi, cm;
        while ((cm = cellRe.exec(rm[1]))) cells.push(htmlText(cm[1]));
        if (cells.some(function (x) { return x !== ''; })) rows.push(cells);
      }
      if (rows.length > best.length) best = rows;
    });
    return best;
  }

  // File bytes + name -> rows of cells. Throws an Error whose message is a code the screen turns into words.
  async function readTable(bytes, fileName) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var isZip = u8[0] === 0x50 && u8[1] === 0x4B, isOle = u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;
    if (isZip) return readXlsx(u8);
    if (isOle) return readXls(u8);
    if (/\.xlsx$/i.test(fileName || '')) throw new Error('xlsx-not-zip');
    var text = decodeText(u8);
    // An ".xls" that is really a web page (common for bank downloads) or plain text.
    if (/^\s*<(\?xml|!doctype|html|table|meta|head|body)/i.test(text) && /<tr\b/i.test(text)) return parseHtmlTable(text);
    return parseCsv(text);
  }

  // ---------- values ----------

  var MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, oct: 10, nov: 11, dic: 12, dec: 12 };

  function dateParts(value) {
    var s = String(value === undefined || value === null ? '' : value).trim();
    if (!s) return null;
    s = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm|z|[+-]\d{2}:?\d{2})?$/i, '').trim();
    var m = /^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/.exec(s);
    if (m) return { order: 'ymd', y: +m[1], a: +m[2], b: +m[3] };
    m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/.exec(s);
    if (m) return { order: '?', a: +m[1], b: +m[2], y: m[3].length === 2 ? 2000 + +m[3] : +m[3] };
    m = /^(\d{1,2})[ \-\/]([a-zA-Z]{3,})\.?[ \-\/,]*(\d{2}|\d{4})$/.exec(s);
    if (m && MONTHS[norm(m[2]).slice(0, 3)]) return { order: 'named', y: m[3].length === 2 ? 2000 + +m[3] : +m[3], mo: MONTHS[norm(m[2]).slice(0, 3)], d: +m[1] };
    m = /^([a-zA-Z]{3,})\.?[ \-\/]+(\d{1,2}),?[ \-\/]+(\d{2}|\d{4})$/.exec(s);
    if (m && MONTHS[norm(m[1]).slice(0, 3)]) return { order: 'named', y: m[3].length === 2 ? 2000 + +m[3] : +m[3], mo: MONTHS[norm(m[1]).slice(0, 3)], d: +m[2] };
    return null;
  }

  // 'dmy' | 'mdy' for dd/mm/yyyy-style text, decided by the whole column: a first part above 12 means day first, a second part
  // above 12 means month first. Undecided: day first (Peru's own order).
  function detectDateOrder(values) {
    var dmy = 0, mdy = 0;
    values.forEach(function (v) {
      var p = dateParts(v);
      if (!p || p.order !== '?') return;
      if (p.a > 12) dmy++;
      if (p.b > 12) mdy++;
    });
    return mdy > dmy ? 'mdy' : 'dmy';
  }

  var ISO_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})$/i;

  // A date-and-time with a UTC offset ("2026-09-12T03:10:00+00:00", what Spendee writes) is a moment, not a calendar day: it becomes the
  // day it was where the person lives (`timeZone`, default this device's) — 03:10 UTC is still the evening before in Lima.
  function toIsoDate(value, order, timeZone) {
    var iso = ISO_WITH_OFFSET.exec(String(value === undefined || value === null ? '' : value).trim());
    if (iso) {
      var off = iso[3].toUpperCase() === 'Z' ? 'Z' : iso[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
      var when = new Date(iso[1] + 'T' + (iso[2].length === 5 ? iso[2] + ':00' : iso[2]) + off);
      if (isNaN(when.getTime())) return '';
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when);
      return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : '';
    }
    var p = dateParts(value), y, mo, d;
    if (!p) return '';
    if (p.order === 'ymd') { y = p.y; mo = p.a; d = p.b; }
    else if (p.order === 'named') { y = p.y; mo = p.mo; d = p.d; }
    else if (order === 'mdy') { y = p.y; mo = p.a; d = p.b; }
    else { y = p.y; mo = p.b; d = p.a; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return '';
    var check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  // '.' or ',' — which one marks the decimals in this column's text.
  function detectDecimal(values) {
    var comma = 0, dot = 0;
    values.forEach(function (v) {
      if (typeof v === 'number') return;
      var s = String(v).replace(/[^\d.,]/g, '');
      var lastC = s.lastIndexOf(','), lastD = s.lastIndexOf('.');
      if (lastC >= 0 && lastD >= 0) { if (lastC > lastD) comma++; else dot++; }
      else if (lastC >= 0 && /,\d{1,2}$/.test(s)) comma++;
      else if (lastD >= 0 && /\.\d{1,2}$/.test(s)) dot++;
    });
    return comma > dot ? ',' : '.';
  }

  // The number in a cell, or NaN. Handles "S/ 1,234.50", "1.234,50", "(12.50)", "12.50-", "−5", "USD 10".
  function parseAmount(value, decimal) {
    if (typeof value === 'number') return value;
    var s = String(value === undefined || value === null ? '' : value).trim();
    if (!s) return NaN;
    var negative = /^\(.*\)$/.test(s) || /^[-−–]/.test(s.replace(/^[^\d(\-−–.,]+/, '')) || /[-−–]\s*$/.test(s);
    var digits = s.replace(/[^\d.,]/g, '');
    if (!/\d/.test(digits)) return NaN;
    if (decimal === ',') digits = digits.replace(/\./g, '').replace(',', '.');
    else digits = digits.replace(/,/g, '');
    var n = parseFloat(digits);
    return isNaN(n) ? NaN : (negative ? -Math.abs(n) : n);
  }

  function currencyFromText(value) {
    var s = norm(value).replace(/\./g, '');
    if (!s) return '';
    if (/^(s\/?|pen|sol(es)?|nuevos? soles?)$/.test(s)) return 'PEN';
    if (/^(us\$?|\$|usd|dolar(es)?( americanos?)?)$/.test(s)) return 'USD';
    if (/^(eur|euros?|€)$/.test(s)) return 'EUR';
    return /^[a-z]{3}$/.test(s) ? s.toUpperCase() : '';
  }

  // ---------- finding and mapping the columns ----------

  function cellText(v) { return typeof v === 'number' ? String(v) : String(v || ''); }
  function looksNumeric(v) { return typeof v === 'number' || (/\d/.test(String(v)) && !isNaN(parseAmount(v, '.')) && !dateParts(v)); }

  // The row holding the column names: the first row of mostly text whose following rows contain a date. -1 = no header row.
  function findHeaderRow(rows) {
    for (var i = 0; i < Math.min(rows.length, 30); i++) {
      var cells = rows[i].filter(function (c) { return cellText(c) !== ''; });
      if (cells.length < 2) continue;
      var texty = cells.filter(function (c) { return !looksNumeric(c) && !dateParts(c); }).length;
      if (texty < cells.length * 0.7) continue;
      for (var j = i + 1; j < Math.min(rows.length, i + 6); j++) {
        if (rows[j].some(function (c) { return dateParts(c); })) return i;
      }
    }
    return -1;
  }

  var HEADER_WORDS = {
    date: /^(fecha( de)?( operacion| proceso| movimiento| consumo| transaccion| contable)?|f\.? ?(operacion|proceso|valor)|date|transaction date|posting date|booking date|dia)$/,
    dateLoose: /fecha|date/,
    description: /descripcion|detalle|concepto|glosa|movimiento|referencia|narrativa|memo|payee|merchant|comercio|establecimiento|description|details?|transaction|^notes?$|^nota(s)?$|comentario|observacion/,
    account: /^(wallet|cartera|billetera|account|account name|cuenta|nombre de la cuenta|nombre de cuenta)$/,
    category: /^(category|category name|categoria|nombre de la categoria|nombre de categoria)$/,
    type: /^(type|tipo|transaction type|tipo de transaccion|tipo de movimiento|income\/expense|ingreso\/gasto|entry type)$/,
    amount: /^(monto|importe|amount|valor|total|monto total|importe total)$/,
    amountLoose: /monto|importe|amount/,
    out: /cargo|retiro|debito|egreso|salida|debit|withdraw|paid out|money out|gasto|pago|payment out/,
    in: /abono|deposito|ingreso|entrada|credito|credit|paid in|money in|deposit/,
    currency: /moneda|currency|divisa/
  };

  function columnValues(rows, from, col) {
    return rows.slice(from).map(function (r) { return r[col]; }).filter(function (v) { return cellText(v) !== ''; });
  }

  // { headerRow, hasHeader, headers, date, description, amount, out, in, currency, dateOrder, decimal, sign }
  // Column fields are indexes or -1. `sign`: 'negative' (money out is negative) or 'positive' (money out is positive, as many
  // credit-card exports show it); `isCard` says the account is a credit card, which decides the guess when the numbers are not mixed.
  function guessMapping(rows, opts) {
    opts = opts || {};
    var hr = findHeaderRow(rows), first = hr + 1;
    var width = rows.reduce(function (n, r) { return Math.max(n, r.length); }, 0);
    var headers = [];
    for (var c = 0; c < width; c++) headers.push(hr >= 0 ? cellText(rows[hr][c]) : '');
    var h = headers.map(norm);
    function find(re, used) { for (var i = 0; i < h.length; i++) if (h[i] && re.test(h[i]) && used.indexOf(i) < 0) return i; return -1; }
    var used = [], m = { headerRow: hr, hasHeader: hr >= 0, headers: headers, date: -1, description: -1, amount: -1, out: -1, in: -1, currency: -1, account: -1, category: -1, type: -1 };
    m.date = find(HEADER_WORDS.date, used); if (m.date < 0) m.date = find(HEADER_WORDS.dateLoose, used);
    if (m.date >= 0) used.push(m.date);
    m.currency = find(HEADER_WORDS.currency, used); if (m.currency >= 0) used.push(m.currency);
    m.account = find(HEADER_WORDS.account, used); if (m.account >= 0) used.push(m.account);
    m.category = find(HEADER_WORDS.category, used); if (m.category >= 0) used.push(m.category);
    m.out = find(HEADER_WORDS.out, used);
    m.in = find(HEADER_WORDS.in, used.concat(m.out >= 0 ? [m.out] : []));
    if (m.out >= 0 && m.in >= 0) { used.push(m.out, m.in); }
    else { m.out = -1; m.in = -1; }
    if (m.out < 0) { m.amount = find(HEADER_WORDS.amount, used); if (m.amount < 0) m.amount = find(HEADER_WORDS.amountLoose, used); if (m.amount >= 0) used.push(m.amount); }
    m.type = find(HEADER_WORDS.type, used); if (m.type >= 0) used.push(m.type);
    m.description = find(HEADER_WORDS.description, used); if (m.description >= 0) used.push(m.description);

    // No usable words in the header (or no header at all): decide from the values.
    if (m.date < 0) {
      var best = -1, bestN = 0;
      for (var d = 0; d < width; d++) { var n = columnValues(rows, first, d).filter(function (v) { return dateParts(v); }).length; if (n > bestN) { best = d; bestN = n; } }
      m.date = best;
    }
    if (m.out < 0 && m.amount < 0) {
      var numericCols = [];
      for (var a = 0; a < width; a++) {
        if (a === m.date || a === m.currency || a === m.account || a === m.category || a === m.type) continue;
        var vals = columnValues(rows, first, a);
        if (vals.length && vals.filter(looksNumeric).length >= vals.length * 0.8) numericCols.push(a);
      }
      // With a running balance next to the amount, the amount is the first of the numeric columns.
      if (numericCols.length) m.amount = numericCols[0];
    }
    if (m.description < 0) {
      var longest = -1, longestLen = 0;
      for (var t = 0; t < width; t++) {
        if (t === m.date || t === m.amount || t === m.out || t === m.in || t === m.currency || t === m.account || t === m.category || t === m.type) continue;
        var tv = columnValues(rows, first, t), avg = tv.length ? tv.reduce(function (s, v) { return s + cellText(v).length; }, 0) / tv.length : 0;
        if (tv.filter(function (v) { return !looksNumeric(v) && !dateParts(v); }).length >= tv.length * 0.6 && avg > longestLen) { longest = t; longestLen = avg; }
      }
      m.description = longest;
    }

    m.dateOrder = detectDateOrder(columnValues(rows, first, m.date));
    var numberCols = [m.amount, m.out, m.in].filter(function (i) { return i >= 0; });
    m.decimal = detectDecimal([].concat.apply([], numberCols.map(function (i) { return columnValues(rows, first, i); })));
    m.sign = 'negative';
    if (m.amount >= 0) {
      var vs = columnValues(rows, first, m.amount).map(function (v) { return parseAmount(v, m.decimal); }).filter(function (n) { return !isNaN(n) && n !== 0; });
      var neg = vs.filter(function (n) { return n < 0; }).length;
      // All one sign: a card's list of purchases is usually all positive; a savings account's always has both.
      if (vs.length && neg === 0) m.sign = opts.isCard ? 'positive' : 'negative';
      else if (vs.length && neg === vs.length) m.sign = 'negative';
      else if (vs.length && opts.isCard && neg <= vs.length * 0.5) m.sign = 'positive';   // a card's lines are mostly purchases; the minority are payments
    }
    return m;
  }

  // What a Type column (or a category called "Transfer") says about a line: 'expense', 'income', 'transfer' or '' (unknown).
  // Only a plain statement of it counts — a line is a transfer ONLY when the file says so, never from the wording of a note.
  var TYPE_WORDS = {
    transfer: /^(transfer|transfers|transferencia|transferencias|traspaso|traspasos|transfer between accounts|transferencia entre cuentas)$/,
    expense: /^(expense|expenses|gasto|gastos|egreso|egresos|debit|debito|withdrawal|retiro|salida|outflow|spending)$/,
    income: /^(income|ingreso|ingresos|credit|credito|deposit|deposito|entrada|inflow|abono)$/
  };
  function typeKind(value) {
    var t = norm(value);
    if (!t) return '';
    return ['transfer', 'expense', 'income'].filter(function (k) { return TYPE_WORDS[k].test(t); })[0] || '';
  }

  // To the cent, the same way for money out and money in: a half cent goes away from zero (JavaScript's own Math.round sends -2.5 to -2, so
  // expenses would lose a cent at every tie while income did not — found on a real export with 124 such amounts). The tiny extra absorbs
  // binary noise (1.005 is stored as 1.00499999…).
  function roundCents(n) { return (n < 0 ? -1 : 1) * Math.round(Math.abs(n) * 100 + 1e-7) / 100; }

  // Turns the rows into lines with the mapping the person confirmed.
  // m.currencyFixed is used when there is no currency column (or its cell is empty / unknown).
  // Returns { lines: [{ date, description, amount, currency }], skipped: [{ row, reason }], period: { start, end } }.
  function applyMapping(rows, m, opts) {
    var tz = opts && opts.timeZone;
    var lines = [], skipped = [], start = m.headerRow >= 0 ? m.headerRow + 1 : 0;
    // Do the amounts carry their own sign (money out is negative)? If so the sign wins; if not (every amount positive), a Type column
    // says which way the money went.
    var signed = false;
    if (m.amount >= 0) for (var q = start; q < rows.length && !signed; q++) { var pv = parseAmount(rows[q][m.amount], m.decimal); if (pv < 0) signed = true; }
    for (var i = start; i < rows.length; i++) {
      var r = rows[i];
      var date = m.date >= 0 ? toIsoDate(r[m.date], m.dateOrder, tz) : '';
      if (!date) { skipped.push({ row: i + 1, reason: 'date' }); continue; }
      var amount = NaN;
      if (m.out >= 0 || m.in >= 0) {
        var o = m.out >= 0 ? parseAmount(r[m.out], m.decimal) : NaN, n = m.in >= 0 ? parseAmount(r[m.in], m.decimal) : NaN;
        if (!isNaN(o) && o !== 0) amount = -Math.abs(o);
        else if (!isNaN(n) && n !== 0) amount = Math.abs(n);
      } else if (m.amount >= 0) {
        var v = parseAmount(r[m.amount], m.decimal);
        amount = isNaN(v) ? NaN : (m.sign === 'positive' ? -v : v);
      }
      if (isNaN(amount) || Math.abs(amount) < 0.005) { skipped.push({ row: i + 1, reason: 'amount' }); continue; }
      var kind = m.type >= 0 ? typeKind(r[m.type]) : '';
      var catText = m.category >= 0 ? cellText(r[m.category]) : '';
      var isTransfer = kind === 'transfer' || (m.category >= 0 && typeKind(catText) === 'transfer');
      if (m.out < 0 && m.in < 0 && !signed && (kind === 'expense' || kind === 'income')) amount = (kind === 'expense' ? -1 : 1) * Math.abs(amount);
      // A transfer with unsigned amounts has no direction: the file does not say which account it left, so it is left out and counted.
      if (isTransfer && !signed && m.out < 0 && m.in < 0) { skipped.push({ row: i + 1, reason: 'transfer' }); continue; }
      var description = m.description >= 0 ? cellText(r[m.description]).replace(/\s+/g, ' ').trim() : '';
      var category = m.category >= 0 ? cellText(r[m.category]).replace(/\s+/g, ' ').trim() : '';
      var currency = (m.currency >= 0 && currencyFromText(r[m.currency])) || m.currencyFixed || 'PEN';
      var line = { date: date, description: description || category || '—', amount: roundCents(amount), currency: currency };
      if (category) line.category = category;
      if (isTransfer) line.transfer = true;
      if (m.account >= 0) line.account = cellText(r[m.account]).replace(/\s+/g, ' ').trim();
      lines.push(line);
    }
    var dates = lines.map(function (l) { return l.date; }).sort();
    return { lines: lines, skipped: skipped, period: { start: dates[0] || '', end: dates[dates.length - 1] || '' } };
  }

  // What identifies "the same layout" next time: the header words. A file without a header row is told apart by the SHAPE of its
  // columns instead (date, number, text), so two banks' header-less files are not taken for one another.
  function signature(m, rows) {
    if (m.hasHeader) return m.headers.map(norm).join('|').slice(0, 300);
    var shape = '';
    for (var c = 0; c < m.headers.length; c++) {
      var vals = rows ? columnValues(rows, 0, c).slice(0, 12) : [];
      var d = vals.filter(function (v) { return dateParts(v); }).length, n = vals.filter(looksNumeric).length;
      shape += !vals.length ? '-' : (d >= vals.length * 0.7 ? 'D' : (n >= vals.length * 0.7 ? 'N' : 'T'));
    }
    return 'noheader:' + shape;
  }

  // Layouts the app knows by name. A file whose header words include all of `requires` is that layout; its columns are found by header
  // word, so extra or reordered columns do not matter. Only add a layout here after checking a real file of it. Anything else the
  // person confirms once is remembered on the server under its own tag (backend/StatementFormats.gs).
  var KNOWN_FORMATS = [
    { id: 'spendee', name: 'Spendee export', requires: ['date', 'wallet', 'category name', 'amount', 'currency'],
      columns: { date: 'date', description: 'note', amount: 'amount', currency: 'currency', account: 'wallet', category: 'category name', type: 'type' },
      sign: 'negative', decimal: '.', dateOrder: 'dmy', source: 'app' }
  ];

  // { id, name, mapping } for a known layout, else null. `mapping` has the same fields guessMapping makes.
  function recognize(headers) {
    var h = headers.map(norm);
    for (var k = 0; k < KNOWN_FORMATS.length; k++) {
      var f = KNOWN_FORMATS[k];
      if (!f.requires.every(function (w) { return h.indexOf(w) >= 0; })) continue;
      var m = { out: -1, in: -1, sign: f.sign, decimal: f.decimal, dateOrder: f.dateOrder, source: f.source || '' };
      Object.keys(f.columns).forEach(function (field) { m[field] = h.indexOf(f.columns[field]); });
      return { id: f.id, name: f.name, mapping: m };
    }
    return null;
  }

  // The different values in one column, most frequent first: [{ value, count }].
  function distinctValues(rows, m, col) {
    var counts = {}, order = [];
    for (var i = (m.headerRow >= 0 ? m.headerRow + 1 : 0); i < rows.length; i++) {
      var v = cellText(rows[i][col]).replace(/\s+/g, ' ').trim();
      if (v === '') continue;
      if (counts[v] === undefined) { counts[v] = 0; order.push(v); }
      counts[v]++;
    }
    return order.map(function (v) { return { value: v, count: counts[v] }; }).sort(function (a, b) { return b.count - a.count; });
  }

  return {
    decodeText: decodeText, parseCsv: parseCsv, readXlsx: readXlsx, readXls: readXls, parseHtmlTable: parseHtmlTable, readTable: readTable,
    findHeaderRow: findHeaderRow, guessMapping: guessMapping, applyMapping: applyMapping, signature: signature, recognize: recognize, distinctValues: distinctValues, KNOWN_FORMATS: KNOWN_FORMATS,
    roundCents: roundCents, typeKind: typeKind, parseAmount: parseAmount, toIsoDate: toIsoDate, detectDateOrder: detectDateOrder, detectDecimal: detectDecimal, currencyFromText: currencyFromText
  };
});
