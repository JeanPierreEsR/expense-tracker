/**
 * Reads the words out of a simple PDF, with no Google service and nothing paid (2026-11-07).
 *
 * Bank documents made by a program (Interbank's "Constancia de pago", iTextSharp) keep their text as plain words inside
 * compressed blocks ("FlateDecode"). Apps Script has no way to unpack those blocks (Utilities.ungzip needs a gzip wrapper
 * whose checksum we cannot know in advance), so this file carries a small standard "inflate" decoder (RFC 1951) and then
 * picks the text-showing commands (Tj / TJ) out of each page block, in the order the page draws them.
 * Fonts that hide the text behind glyph numbers (a ToUnicode map) are NOT read: such a PDF gives back no words, and the
 * caller treats it as unreadable. Scanned PDFs (pictures) are never read here (images are the Mac Mini's job).
 */

// ---- inflate (RFC 1950 zlib wrapper + RFC 1951 deflate) ----

var PDF_LEN_BASE_ = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var PDF_LEN_EXTRA_ = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var PDF_DIST_BASE_ = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var PDF_DIST_EXTRA_ = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var PDF_STOP_ = { pdf: 'stop' };   // thrown inside the decoder when the data runs out or is invalid (never shown to anyone)
var PDF_CL_ORDER_ = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A Huffman table from code lengths: counts per length + symbols in code order. */
function pdfHuffman_(lengths) {
  var counts = [], symbols = [], offs = [], i;
  for (i = 0; i < 16; i++) counts[i] = 0;
  for (i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  offs[1] = 0;
  for (i = 1; i < 15; i++) offs[i + 1] = offs[i] + counts[i];
  for (i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]]++] = i;
  return { counts: counts, symbols: symbols };
}

/** Unpacks zlib/deflate data (an array of 0–255 numbers); returns the bytes, or null when the data is not valid deflate. */
function pdfInflate_(data) {
  var pos = 0, bit = 0, out = [];
  // zlib header (2 bytes) when present: CMF 0x78 is by far the usual one; a raw deflate block starts directly.
  if (data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0) pos = 2;
  function bits(n) {
    var v = 0;
    for (var k = 0; k < n; k++) {
      if (pos >= data.length) throw PDF_STOP_;
      v |= ((data[pos] >> bit) & 1) << k;
      if (++bit === 8) { bit = 0; pos++; }
    }
    return v;
  }
  function decode(h) {
    var code = 0, first = 0, index = 0;
    for (var len = 1; len < 16; len++) {
      code |= bits(1);
      var count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw PDF_STOP_;
  }
  var fixedLit = null, fixedDist = null;
  try {
    var last = 0;
    while (!last) {
      last = bits(1);
      var type = bits(2), lit, dist, i;
      if (type === 0) {
        if (bit) { bit = 0; pos++; }
        var len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        for (i = 0; i < len; i++) out.push(data[pos++]);
        continue;
      }
      if (type === 1) {
        if (!fixedLit) {
          var l = [];
          for (i = 0; i < 288; i++) l[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
          fixedLit = pdfHuffman_(l);
          var d = [];
          for (i = 0; i < 30; i++) d[i] = 5;
          fixedDist = pdfHuffman_(d);
        }
        lit = fixedLit; dist = fixedDist;
      } else if (type === 2) {
        var hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4, cl = [];
        for (i = 0; i < 19; i++) cl[i] = 0;
        for (i = 0; i < hclen; i++) cl[PDF_CL_ORDER_[i]] = bits(3);
        var clh = pdfHuffman_(cl), lens = [];
        while (lens.length < hlit + hdist) {
          var sym = decode(clh);
          if (sym < 16) lens.push(sym);
          else {
            var rep = 0, val = 0;
            if (sym === 16) { val = lens[lens.length - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep--) lens.push(val);
          }
        }
        lit = pdfHuffman_(lens.slice(0, hlit));
        dist = pdfHuffman_(lens.slice(hlit));
      } else return null;
      for (;;) {
        var s = decode(lit);
        if (s < 256) out.push(s);
        else if (s === 256) break;
        else {
          s -= 257;
          var length = PDF_LEN_BASE_[s] + bits(PDF_LEN_EXTRA_[s]);
          var ds = decode(dist);
          var back = PDF_DIST_BASE_[ds] + bits(PDF_DIST_EXTRA_[ds]);
          var from = out.length - back;
          if (from < 0) return null;
          for (i = 0; i < length; i++) out.push(out[from + i]);
        }
      }
    }
  } catch (err) {
    return out.length ? out : null;   // a stream cut short still gives what it had
  }
  return out;
}

// ---- text out of a PDF ----

/** Bytes (Apps Script gives signed -128..127, tests give 0..255) as a 0..255 array. */
function pdfUnsigned_(bytes) {
  var out = new Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] & 0xff;
  return out;
}

function pdfLatin1_(arr, from, to) {
  var s = '';
  for (var i = from; i < to; i += 4096) s += String.fromCharCode.apply(null, arr.slice(i, Math.min(to, i + 4096)));
  return s;
}

/** One PDF string "(…)" body, escapes undone; bytes read as Windows-1252/Latin-1 (á é í ó ú ñ are the same in both). */
function pdfUnescape_(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, function (m, c) {
    if (/^[0-7]/.test(c)) return String.fromCharCode(parseInt(c, 8) & 0xff);
    if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t';
    if (c === 'b' || c === 'f' || /^\r?\n$/.test(c)) return '';
    return c;
  });
}

/** The words a content block draws, one string per Tj / TJ command, in order. */
function pdfStringsFromContent_(content) {
  var out = [];
  var re = /\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj|\[((?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*)\]\s*TJ/g, m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) { out.push(pdfUnescape_(m[1])); continue; }
    var parts = [], pr = /\(((?:\\[\s\S]|[^\\)])*)\)/g, p;
    while ((p = pr.exec(m[2]))) parts.push(pdfUnescape_(p[1]));
    out.push(parts.join(''));
  }
  return out;
}

/**
 * Every string a PDF draws, in drawing order, trimmed (empty ones kept as '' so table cells stay in place).
 * Returns [] for a PDF it cannot read (pictures only, glyph-number fonts, damaged).
 */
function pdfTextStrings_(bytes) {
  var arr = pdfUnsigned_(bytes || []);
  var raw = pdfLatin1_(arr, 0, arr.length);
  if (raw.slice(0, 5) !== '%PDF-') return [];
  var out = [];
  var re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[0-9A-Fa-f\s]*>)*)>>\s*stream\r?\n/g, m;
  while ((m = re.exec(raw))) {
    var dict = m[1];
    if (/\/Subtype\s*\/Image|\/Length1|\/Type\s*\/(XRef|ObjStm|EmbeddedFile)/.test(dict)) continue;
    var start = m.index + m[0].length;
    var lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    var end = lenM ? start + Number(lenM[1]) : raw.indexOf('endstream', start);
    if (end < start || end > raw.length) end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    var content;
    if (/\/Filter\s*\/FlateDecode/.test(dict) || /\/Filter\s*\[\s*\/FlateDecode\s*\]/.test(dict)) {
      var inflated = pdfInflate_(arr.slice(start, end));
      if (!inflated) continue;
      content = pdfLatin1_(inflated, 0, inflated.length);
    } else if (!/\/Filter/.test(dict)) {
      content = raw.slice(start, end);
    } else continue;
    if (!/\bBT\b/.test(content)) continue;   // not a page's text (fonts, pictures)
    pdfStringsFromContent_(content).forEach(function (s) { out.push(s.trim()); });
  }
  return out;
}
