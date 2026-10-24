// Spreadsheet statements (docs/statement-table.js): CSV and Excel files become the same lines the PDF readers give.
// Every file below is made up; it only mimics the layouts banks export.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const ST = require("../../docs/statement-table.js");

const bytes = (s) => new TextEncoder().encode(s);

test("a CSV with quotes, a BOM and semicolons is read cell by cell", () => {
  const text = '﻿Fecha;Descripción;Monto\n05/03/2019;"COMPRA ""LA ESQUINA""; lima";-23,47\n06/03/2019;SUELDO;3.000,13\n';
  const rows = ST.parseCsv(ST.decodeText(bytes(text)));
  assert.deepEqual(rows[0], ["Fecha", "Descripción", "Monto"]);
  assert.deepEqual(rows[1], ["05/03/2019", 'COMPRA "LA ESQUINA"; lima', "-23,47"]);
  assert.equal(rows.length, 3);
});

test("Windows-1252 text (Excel's CSV in Latin America) keeps its accents", () => {
  const latin1 = Uint8Array.from([...Buffer.from("Descripci\xf3n;Monto\nCaf\xe9;-5\n", "latin1")]);
  const rows = ST.parseCsv(ST.decodeText(latin1));
  assert.equal(rows[0][0], "Descripción");
  assert.equal(rows[1][0], "Café");
});

test("numbers: thousands and decimals either way round, parentheses, trailing minus, currency words", () => {
  assert.equal(ST.parseAmount("S/ 1,234.50", "."), 1234.5);
  assert.equal(ST.parseAmount("1.234,50", ","), 1234.5);
  assert.equal(ST.parseAmount("(12.50)", "."), -12.5);
  assert.equal(ST.parseAmount("12.50-", "."), -12.5);
  assert.equal(ST.parseAmount("−5,00", ","), -5);
  assert.equal(ST.parseAmount("USD 10", "."), 10);
  assert.ok(Number.isNaN(ST.parseAmount("", ".")));
  assert.ok(Number.isNaN(ST.parseAmount("n/a", ".")));
  assert.equal(ST.detectDecimal(["1.234,50", "20,00"]), ",");
  assert.equal(ST.detectDecimal(["1,234.50", "20.00"]), ".");
  assert.equal(ST.detectDecimal([12.5, 3]), ".");
});

test("dates: day first unless the column proves month first; named months; times are ignored", () => {
  assert.equal(ST.detectDateOrder(["05/03/2019", "17/03/2019"]), "dmy");
  assert.equal(ST.detectDateOrder(["03/05/2019", "03/17/2019"]), "mdy");
  assert.equal(ST.detectDateOrder(["03/05/2019"]), "dmy");
  assert.equal(ST.toIsoDate("05/03/2019", "dmy"), "2019-03-05");
  assert.equal(ST.toIsoDate("03/05/2019", "mdy"), "2019-03-05");
  assert.equal(ST.toIsoDate("2019-03-05 14:30:00", "dmy"), "2019-03-05");
  assert.equal(ST.toIsoDate("5 mar 2019", "dmy"), "2019-03-05");
  assert.equal(ST.toIsoDate("05-Dic-19", "dmy"), "2019-12-05");
  assert.equal(ST.toIsoDate("Mar 5, 2019", "dmy"), "2019-03-05");
  assert.equal(ST.toIsoDate("31/02/2019", "dmy"), "", "no such day");
  assert.equal(ST.toIsoDate("hello", "dmy"), "");
});

test("a savings export with one signed amount column maps itself", () => {
  const rows = ST.parseCsv("Cuenta de ahorros;;\nFecha;Descripción;Monto;Saldo\n05/03/2019;COMPRA BODEGA;-23,47;976,53\n06/03/2019;ABONO SUELDO;3.000,13;3.976,66\n");
  const m = ST.guessMapping(rows, { isCard: false });
  assert.equal(m.headerRow, 1);
  assert.deepEqual([m.date, m.description, m.amount, m.out, m.in], [0, 1, 2, -1, -1]);
  assert.equal(m.decimal, ",");
  assert.equal(m.sign, "negative");
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.deepEqual(r.lines, [
    { date: "2019-03-05", description: "COMPRA BODEGA", amount: -23.47, currency: "PEN" },
    { date: "2019-03-06", description: "ABONO SUELDO", amount: 3000.13, currency: "PEN" }
  ]);
  assert.deepEqual(r.period, { start: "2019-03-05", end: "2019-03-06" });
});

test("separate Cargo / Abono columns: money out is negative, money in positive", () => {
  const rows = ST.parseCsv("Fecha,Detalle,Cargo,Abono\n2019-03-05,COMPRA BODEGA,23.47,\n2019-03-06,ABONO SUELDO,,3000.13\n2019-03-07,SALDO FINAL,,\n");
  const m = ST.guessMapping(rows);
  assert.deepEqual([m.out, m.in, m.amount], [2, 3, -1]);
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.deepEqual(r.lines.map((l) => l.amount), [-23.47, 3000.13]);
  assert.deepEqual(r.skipped, [{ row: 4, reason: "amount" }], "a row without an amount (a balance line) is skipped and counted");
});

test("a card export where purchases are positive is turned around; payments become money in", () => {
  const rows = ST.parseCsv("Date,Merchant,Amount,Currency\n03/05/2019,RAPPI PERU,41.37,PEN\n03/16/2019,AMAZON,12.99,USD\n");
  const m = ST.guessMapping(rows, { isCard: true });
  assert.equal(m.sign, "positive");
  assert.equal(m.dateOrder, "mdy");
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.deepEqual(r.lines, [
    { date: "2019-03-05", description: "RAPPI PERU", amount: -41.37, currency: "PEN" },
    { date: "2019-03-16", description: "AMAZON", amount: -12.99, currency: "USD" }
  ]);
});

test("a file with no header row is mapped from its values", () => {
  const rows = ST.parseCsv("05/03/2019,COMPRA BODEGA LA ESQUINA,-23.47\n06/03/2019,ABONO SUELDO,3000.13\n");
  const m = ST.guessMapping(rows);
  assert.equal(m.hasHeader, false);
  assert.deepEqual([m.date, m.description, m.amount], [0, 1, 2]);
  assert.equal(ST.applyMapping(rows, { ...m, currencyFixed: "PEN" }).lines.length, 2);
});

test("repeated header rows and total lines are skipped, not turned into entries", () => {
  const rows = ST.parseCsv("Fecha,Descripción,Monto\n05/03/2019,COMPRA,-10.00\nFecha,Descripción,Monto\nTOTAL,,-10.00\n");
  const m = ST.guessMapping(rows);
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.equal(r.lines.length, 1);
  assert.equal(r.skipped.length, 2);
});

test("the remembered-mapping signature depends on the header words only", () => {
  const a = ST.guessMapping(ST.parseCsv("Fecha,Descripción,Monto\n05/03/2019,X,-1\n"));
  const b = ST.guessMapping(ST.parseCsv("fecha,DESCRIPCION,monto\n06/04/2020,Y,-9\n"));
  const c = ST.guessMapping(ST.parseCsv("Date,Memo,Amount\n05/03/2019,X,-1\n"));
  assert.equal(ST.signature(a), ST.signature(b));
  assert.notEqual(ST.signature(a), ST.signature(c));
});

test("currency words in a currency column", () => {
  assert.equal(ST.currencyFromText("S/"), "PEN");
  assert.equal(ST.currencyFromText("Soles"), "PEN");
  assert.equal(ST.currencyFromText("US$"), "USD");
  assert.equal(ST.currencyFromText("Dólares"), "USD");
  assert.equal(ST.currencyFromText("eur"), "EUR");
  assert.equal(ST.currencyFromText("gbp"), "GBP");
  assert.equal(ST.currencyFromText("whatever"), "");
});

// ---- .xlsx: built here as a real zip so the reader is tested on the actual format ----

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files, { stored = false } = {}) {
  const parts = [], central = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text]) => {
    const raw = Buffer.from(text);
    const data = stored ? raw : zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt32LE(crc32(raw), 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eocd]));
}

const XLSX_FILES = {
  "[Content_Types].xml": "<Types/>",
  "xl/workbook.xml": '<workbook><sheets><sheet name="Movimientos" sheetId="1" r:id="rId7"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/data.xml"/></Relationships>',
  "xl/sharedStrings.xml": '<sst><si><t>Fecha</t></si><si><t>Descripción</t></si><si><t>Monto</t></si><si><r><t>COMPRA </t></r><r><t>BODEGA &amp; CIA</t></r></si><si><t>ABONO SUELDO</t></si></sst>',
  "xl/styles.xml": '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  // serial 43529 = 2019-03-05, 43530 = 2019-03-06 (one with the built-in date format, one with a custom one); row 4 has no first cell
  "xl/worksheets/data.xml": '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" s="1"><v>43529</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>-23.47</v></c></row>' +
    '<row r="3"><c r="A3" s="2"><v>43530</v></c><c r="B3" t="s"><v>4</v></c><c r="C3"><v>3000.13</v></c></row>' +
    '<row r="4"><c r="B4" t="inlineStr"><is><t>sin fecha</t></is></c></row>' +
    '</sheetData></worksheet>'
};

test("an .xlsx is opened: shared strings (with rich text and entities), date styles, the sheet the workbook points to", async () => {
  for (const stored of [false, true]) {
    const rows = await ST.readTable(zip(XLSX_FILES, { stored }), "movimientos.xlsx");
    assert.deepEqual(rows[0], ["Fecha", "Descripción", "Monto"]);
    assert.deepEqual(rows[1], ["2019-03-05", "COMPRA BODEGA & CIA", -23.47]);
    assert.deepEqual(rows[2], ["2019-03-06", "ABONO SUELDO", 3000.13]);
    assert.deepEqual(rows[3], ["", "sin fecha"], "a missing first cell keeps the columns lined up");
  }
});

test("an .xlsx runs through the same mapping as a CSV", async () => {
  const rows = await ST.readTable(zip(XLSX_FILES), "movimientos.xlsx");
  const m = ST.guessMapping(rows);
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.deepEqual(r.lines.map((l) => [l.date, l.amount]), [["2019-03-05", -23.47], ["2019-03-06", 3000.13]]);
  assert.equal(r.skipped.length, 1);
});

test("a file named .xlsx that is not a zip gives a clear error code", async () => {
  await assert.rejects(() => ST.readTable(bytes("not a zip at all, but named like one"), "broken.xlsx"), /xlsx-not-zip/);
});

// ---- .xls: an OLE2 container holding BIFF records. Built here from the file-format description (no real Excel file is
// available), so these tests prove the reader follows the format as written, not that every real bank file opens. ----

const le16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
const rec = (id, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([le16(id), le16(data.length), data]); };

function cfb(stream, { mini = false } = {}) {
  const ssz = 512, END = 0xFFFFFFFE, FATSECT = 0xFFFFFFFD, FREE = 0xFFFFFFFF;
  const pad = (b, n) => Buffer.concat([b, Buffer.alloc((n - (b.length % n)) % n)]);
  const entry = (name, type, start, size, child) => {
    const e = Buffer.alloc(128);
    e.write(name, 0, "utf16le"); e.writeUInt16LE((name.length + 1) * 2, 64); e[66] = type;
    e.writeUInt32LE(FREE, 68); e.writeUInt32LE(FREE, 72); e.writeUInt32LE(child === undefined ? FREE : child, 76);
    e.writeUInt32LE(start, 116); e.writeUInt32LE(size, 120);
    return e;
  };
  // The format keeps any stream under 4096 bytes in the "mini stream"; a workbook kept in ordinary sectors is padded up to 4096 as Excel does.
  if (!mini && stream.length < 4096) stream = Buffer.concat([stream, Buffer.alloc(4096 - stream.length)]);
  let fat = [], rootStart = END, bookStart = 2, miniFatSector = END, nMiniFat = 0;
  const header = Buffer.alloc(512, 0);
  Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).copy(header, 0);
  header.writeUInt16LE(0x3E, 24); header.writeUInt16LE(3, 26); header.writeUInt16LE(0xFFFE, 28);
  header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32);
  let dataSectors;
  if (!mini) {
    dataSectors = pad(stream, ssz);
    const n = dataSectors.length / ssz;
    fat = [FATSECT, END]; for (let i = 0; i < n; i++) fat.push(i === n - 1 ? END : 2 + i + 1);
  } else {
    // sector 2 = mini FAT, sectors 3.. = the mini stream (the workbook itself, in 64-byte pieces)
    const miniBytes = pad(stream, 64), nMini = miniBytes.length / 64;
    const miniFat = Buffer.alloc(512, 0xFF); for (let i = 0; i < nMini; i++) miniFat.writeUInt32LE(i === nMini - 1 ? END : i + 1, i * 4);
    const container = pad(miniBytes, ssz), n = container.length / ssz;
    dataSectors = Buffer.concat([miniFat, container]);
    fat = [FATSECT, END, END]; for (let i = 0; i < n; i++) fat.push(i === n - 1 ? END : 3 + i + 1);
    rootStart = 3; bookStart = 0; miniFatSector = 2; nMiniFat = 1;
  }
  const fatSector = Buffer.alloc(512, 0xFF); fat.forEach((v, i) => fatSector.writeUInt32LE(v >>> 0, i * 4));
  const root = entry("Root Entry", 5, rootStart, mini ? pad(stream, 64).length : 0, 1);
  const book = entry("Workbook", 2, bookStart, stream.length);
  const dir = Buffer.concat([root, book, entry("", 0, 0, 0), entry("", 0, 0, 0)]);
  header.writeUInt32LE(1, 44); header.writeUInt32LE(1, 48); header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(miniFatSector, 60); header.writeUInt32LE(nMiniFat, 64); header.writeUInt32LE(END, 68); header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);
  return new Uint8Array(Buffer.concat([header, fatSector, dir, dataSectors]));
}

// The shared string table, with the cut between records placed INSIDE a chosen string's characters.
function sst(strings, cutIn) {
  const body = [le32(strings.length), le32(strings.length)];
  let cutAt = -1, len = 8, highOfCut = false;
  strings.forEach((str, i) => {
    const high = /[^\x00-\x7f]/.test(str);
    const head = Buffer.concat([le16(str.length), Buffer.from([high ? 1 : 0])]);
    const chars = high ? Buffer.from(str, "utf16le") : Buffer.from(str, "latin1");
    body.push(head); len += head.length;
    if (i === cutIn) { cutAt = len + (high ? 2 : 1) * 3; highOfCut = high; }
    body.push(chars); len += chars.length;
  });
  const all = Buffer.concat(body);
  if (cutAt < 0) return rec(0x00FC, all);
  return Buffer.concat([rec(0x00FC, all.subarray(0, cutAt)), rec(0x003C, Buffer.from([highOfCut ? 1 : 0]), all.subarray(cutAt))]);
}

const bof = (type, ver = 0x0600) => rec(0x0809, le16(ver), le16(type), Buffer.alloc(12));
const eof = () => rec(0x000A);
const xfRec = (fmt) => rec(0x00E0, le16(0), le16(fmt), Buffer.alloc(16));
const rk = (n, int = true, div100 = false) => (int ? (((n << 2) | 2 | (div100 ? 1 : 0)) >>> 0) : 0);
const labelSst = (r, c, i) => rec(0x00FD, le16(r), le16(c), le16(0), le32(i));
const number = (r, c, xf, n) => rec(0x0203, le16(r), le16(c), le16(xf), f64(n));
const rkCell = (r, c, xf, value) => rec(0x027E, le16(r), le16(c), le16(xf), le32(value));

function xlsStream({ cut } = {}) {
  const strings = ["Fecha", "Descripción", "Monto", "COMPRA BODEGA & CIA", "ABONO SUELDO", "FORMULA TEXT"];
  const globalsHead = Buffer.concat([bof(0x0005), rec(0x0022, le16(0)), rec(0x041E, le16(164), le16(10), Buffer.from([0]), Buffer.from("dd/mm/yyyy")), xfRec(0), xfRec(14), xfRec(164)]);
  const boundLen = 4 + 4 + 2 + 2 + "Movimientos".length;   // header, offset, visibility+type, length+flags, name
  const sstRec = sst(strings, cut);
  const globalsLen = globalsHead.length + boundLen + sstRec.length + 4;
  const bound = rec(0x0085, le32(globalsLen), Buffer.from([0, 0]), Buffer.from([11, 0]), Buffer.from("Movimientos"));
  const sheet = Buffer.concat([
    bof(0x0010),
    labelSst(0, 0, 0), labelSst(0, 1, 1), labelSst(0, 2, 2),
    number(1, 0, 1, 43529), labelSst(1, 1, 3),
    // columns C and D of row 1 as one MULRK: -23.47 (an integer/100) and 976.53
    rec(0x00BD, le16(1), le16(2), le16(0), le32(rk(-2347, true, true)), le16(0), le32(rk(97653, true, true)), le16(3)),
    rkCell(2, 0, 2, rk(43530, true)), labelSst(2, 1, 4), number(2, 2, 0, 3000.13),
    number(3, 0, 1, 43531),
    rec(0x0006, le16(3), le16(1), le16(0), Buffer.from([0, 0, 0, 0, 0, 0, 0xFF, 0xFF]), Buffer.alloc(6)),   // a formula whose result is text …
    rec(0x0207, le16(12), Buffer.from([0]), Buffer.from("FORMULA TEXT")),                                  // … which comes in the STRING record
    number(3, 2, 0, -1),
    eof()
  ]);
  return Buffer.concat([globalsHead, bound, sstRec, eof(), sheet]);
}

test("an .xls is opened: shared strings across a CONTINUE record, 16-bit text, date formats, RK/MULRK numbers, formula text", async () => {
  for (const mini of [false, true]) {
    for (const cut of [undefined, 1, 3]) {   // no split, split inside a 16-bit string, split inside an 8-bit one
      const rows = await ST.readTable(cfb(xlsStream({ cut }), { mini }), "movimientos.xls");
      assert.deepEqual(rows[0], ["Fecha", "Descripción", "Monto"], `mini=${mini} cut=${cut}`);
      assert.deepEqual(rows[1], ["2019-03-05", "COMPRA BODEGA & CIA", -23.47, 976.53]);
      assert.deepEqual(rows[2], ["2019-03-06", "ABONO SUELDO", 3000.13]);
      assert.deepEqual(rows[3], ["2019-03-07", "FORMULA TEXT", -1]);
    }
  }
});

test("an .xls runs through the same mapping as a CSV", async () => {
  const rows = await ST.readTable(cfb(xlsStream({ cut: 3 })), "movimientos.xls");
  const m = ST.guessMapping(rows);
  const r = ST.applyMapping(rows, { ...m, currencyFixed: "PEN" });
  assert.deepEqual(r.lines.map((l) => [l.date, l.description, l.amount]), [["2019-03-05", "COMPRA BODEGA & CIA", -23.47], ["2019-03-06", "ABONO SUELDO", 3000.13], ["2019-03-07", "FORMULA TEXT", -1]]);
});

test("an Excel 5/95 .xls (8-bit labels, no shared strings) is opened too", async () => {
  const globals = Buffer.concat([bof(0x0005, 0x0500), xfRec(0), xfRec(14)]);
  const boundLen = 4 + 4 + 2 + 1 + 3;
  const lab = (r, c, text) => rec(0x0204, le16(r), le16(c), le16(0), le16(text.length), Buffer.from(text, "latin1"));
  const sheet = Buffer.concat([bof(0x0010, 0x0500), lab(0, 0, "Fecha"), lab(0, 1, "Monto"), number(1, 0, 1, 43529), number(1, 1, 0, -5), eof()]);
  const stream = Buffer.concat([globals, rec(0x0085, le32(globals.length + boundLen + 4), Buffer.from([0, 0]), Buffer.from([3, 0x41, 0x42, 0x43])), eof(), sheet]);
  assert.deepEqual(await ST.readTable(cfb(stream), "old.xls"), [["Fecha", "Monto"], ["2019-03-05", -5]]);
});

test("a password-protected or damaged .xls gives a clear error code", async () => {
  const locked = Buffer.concat([bof(0x0005), rec(0x002F, Buffer.alloc(54)), eof()]);
  await assert.rejects(() => ST.readTable(cfb(locked), "locked.xls"), /xls-encrypted/);
  await assert.rejects(() => ST.readTable(Uint8Array.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]), "broken.xls"), /xls-unreadable|Invalid|RangeError/);
});

test("an '.xls' that is really a web page or tab-separated text is read as one", async () => {
  const html = '<html><body><p>Estado de cuenta</p><table><tr><td>x</td></tr></table><table border=1>' +
    "<tr><th>Fecha</th><th>Descripci&oacute;n</th><th>Cargo</th><th>Abono</th></tr>" +
    "<tr><td>05/03/2019</td><td>COMPRA&nbsp;BODEGA &amp; CIA</td><td>23.47</td><td>&nbsp;</td></tr>" +
    "<tr><td>06/03/2019</td><td><b>ABONO</b> SUELDO</td><td></td><td>3,000.13</td></tr></table></body></html>";
  const rows = await ST.readTable(bytes(html), "movimientos.xls");
  assert.deepEqual(rows, [["Fecha", "Descripción", "Cargo", "Abono"], ["05/03/2019", "COMPRA BODEGA & CIA", "23.47", ""], ["06/03/2019", "ABONO SUELDO", "", "3,000.13"]]);
  const r = ST.applyMapping(rows, { ...ST.guessMapping(rows), currencyFixed: "PEN" });
  assert.deepEqual(r.lines.map((l) => l.amount), [-23.47, 3000.13]);
  const tsv = await ST.readTable(bytes("Fecha\tDetalle\tMonto\n05/03/2019\tCOMPRA\t-1,00\n"), "export.xls");
  assert.deepEqual(tsv[1], ["05/03/2019", "COMPRA", "-1,00"]);
});

// ---- app exports: Spendee's layout (made-up lines, the real column names), dates with a time zone, accounts and categories ----

const SPENDEE = 'Date,Wallet,Type,"Category name",Amount,Currency,Note,Labels,Author\n' +
  '2026-09-12T03:10:00+00:00,Wallet,Expense,Transport,-12.50000000,PEN,"Public transport",,Ana Lo\n' +
  '2026-09-12T15:00:00+00:00,Wallet,Expense,"Food & Drink",-8.25000000,PEN,Pinkberry,Kuchen,Ana Lo\n' +
  '2026-09-13T01:00:00+00:00,Savings,Income,Salary,2000.00000000,PEN,,,Ana Lo\n' +
  '2026-09-14T20:00:00+00:00,Savings,Expense,Gifts,-30.00000000,USD,,,Ana Lo\n';

test("a date with a UTC offset becomes the day it was where the person lives", () => {
  assert.equal(ST.toIsoDate("2026-09-12T03:10:00+00:00", "dmy", "America/Lima"), "2026-09-11", "03:10 UTC is the evening before in Lima");
  assert.equal(ST.toIsoDate("2026-09-12T15:00:00+00:00", "dmy", "America/Lima"), "2026-09-12");
  assert.equal(ST.toIsoDate("2026-09-12T23:30:00-05:00", "dmy", "America/Lima"), "2026-09-12");
  assert.equal(ST.toIsoDate("2026-09-12T10:00:00Z", "dmy", "UTC"), "2026-09-12");
  assert.equal(ST.toIsoDate("2026-09-12T10:00:00+0000", "dmy", "UTC"), "2026-09-12");
  assert.equal(ST.toIsoDate("2026-09-12 10:00", "dmy", "UTC"), "2026-09-12", "no offset: the calendar day as written");
});

test("Spendee's layout is recognized by its header words, wherever the columns sit", () => {
  const rows = ST.parseCsv(SPENDEE);
  const known = ST.recognize(ST.guessMapping(rows).headers);
  assert.equal(known.id, "spendee");
  assert.equal(known.name, "Spendee export");
  assert.deepEqual([known.mapping.date, known.mapping.account, known.mapping.category, known.mapping.amount, known.mapping.currency, known.mapping.description], [0, 1, 3, 4, 5, 6]);
  const shuffled = ST.recognize(["Author", "Labels", "Note", "Currency", "Amount", "Category name", "Type", "Wallet", "Date"]);
  assert.equal(shuffled.mapping.date, 8);
  assert.equal(ST.recognize(["Fecha", "Descripción", "Monto"]), null);
  assert.equal(ST.recognize(["Date", "Wallet", "Amount"]), null, "needs the whole set, not just a few shared words");
});

test("the plain guess already finds an app export's columns, so an unknown app needs no preset", () => {
  const m = ST.guessMapping(ST.parseCsv(SPENDEE));
  assert.deepEqual([m.date, m.account, m.category, m.amount, m.currency, m.description], [0, 1, 3, 4, 5, 6]);
});

test("lines keep their account value and category; an empty note falls back to the category; amounts are signed", () => {
  const rows = ST.parseCsv(SPENDEE);
  const r = ST.applyMapping(rows, { ...ST.guessMapping(rows), currencyFixed: "PEN" }, { timeZone: "America/Lima" });
  assert.deepEqual(r.lines, [
    { date: "2026-09-11", description: "Public transport", amount: -12.5, currency: "PEN", category: "Transport", account: "Wallet" },
    { date: "2026-09-12", description: "Pinkberry", amount: -8.25, currency: "PEN", category: "Food & Drink", account: "Wallet" },
    { date: "2026-09-12", description: "Salary", amount: 2000, currency: "PEN", category: "Salary", account: "Savings" },
    { date: "2026-09-14", description: "Gifts", amount: -30, currency: "USD", category: "Gifts", account: "Savings" }
  ]);
  assert.deepEqual(ST.distinctValues(rows, ST.guessMapping(rows), 1), [{ value: "Wallet", count: 2 }, { value: "Savings", count: 2 }]);
});

test("a file without a header row is fingerprinted by the shape of its columns", () => {
  const a = ST.parseCsv("05/03/2019,COMPRA BODEGA,-23.47\n06/03/2019,ABONO SUELDO,3000.13\n");
  const b = ST.parseCsv("2019-03-05,Cafe,Visa,-4.50\n2019-03-06,Taxi,Visa,-9.00\n");
  const ma = ST.guessMapping(a), mb = ST.guessMapping(b);
  assert.equal(ST.signature(ma, a), "noheader:DTN");
  assert.equal(ST.signature(mb, b), "noheader:DTTN");
  assert.notEqual(ST.signature(ma, a), ST.signature(mb, b));
  assert.equal(ST.signature(ST.guessMapping(ST.parseCsv("Fecha,Descripción,Monto\n05/03/2019,X,-1\n"))), "fecha|descripcion|monto");
});

test("amounts are rounded to the cent the same way for money out and money in (a half cent goes away from zero)", () => {
  assert.equal(ST.roundCents(-2.675), -2.68);
  assert.equal(ST.roundCents(2.675), 2.68);
  assert.equal(ST.roundCents(-100.125), -100.13);
  assert.equal(ST.roundCents(100.125), 100.13);
  assert.equal(ST.roundCents(-1.005), -1.01, "binary noise must not decide the cent");
  assert.equal(ST.roundCents(1.005), 1.01);
  assert.equal(ST.roundCents(-12.5), -12.5);
  assert.equal(ST.roundCents(-669.8368), -669.84);
  const rows = ST.parseCsv("Fecha,Descripción,Monto\n05/03/2019,A,-100.125\n06/03/2019,B,100.125\n");
  const r = ST.applyMapping(rows, { ...ST.guessMapping(rows), currencyFixed: "PEN" });
  assert.deepEqual(r.lines.map((l) => l.amount), [-100.13, 100.13], "an expense and an income of the same size come out the same size");
});
