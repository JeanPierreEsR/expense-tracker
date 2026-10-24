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

test("an old .xls and a file that is not a spreadsheet give clear error codes", async () => {
  await assert.rejects(() => ST.readTable(Uint8Array.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]), "old.xls"), /xlsx-legacy/);
  await assert.rejects(() => ST.readTable(bytes("not a zip at all, but named like one"), "broken.xlsx"), /xlsx-not-zip/);
});
