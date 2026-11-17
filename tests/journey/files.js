// Made-up files a person brings to the app on their first days (journeys, 2026-11-17): bank statements (PDF in the layouts the
// app's readers know, and the "movements" spreadsheets banks let people download) and exports of other money apps. Every name,
// number and amount is invented; the layouts imitate the real ones (the PDF ones are checked against the app's own readers by
// tests/journey/check-files.js; the spreadsheet ones are plausible imitations, NOT copies of real files).
const zlib = require("zlib");

// ---------- tiny PDF writer: text cells at x positions, one row per line ----------
// rows: [[{ str, x }]] top to bottom. Helvetica 9pt, WinAnsi (Spanish accents work). 46 rows a page.
function pdf(rows) {
  const PER_PAGE = 46, pages = [];
  for (let i = 0; i < rows.length; i += PER_PAGE) pages.push(rows.slice(i, i + PER_PAGE));
  const esc = (s) => Buffer.from(String(s), "latin1").toString("latin1").replace(/[\\()]/g, (c) => "\\" + c);
  const objs = [];   // strings (latin1)
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1 + pages.length * 2;   // the Pages object comes after every page and content
  const kids = [];
  pages.forEach((pr) => {
    let stream = "";
    pr.forEach((cells, r) => {
      const y = 800 - r * 16;
      cells.filter((c) => c && String(c.str).trim()).forEach((c) => { stream += `BT /F1 9 Tf ${c.x} ${y} Td (${esc(c.str)}) Tj ET\n`; });
    });
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  add(`<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = "%PDF-1.4\n", offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, "latin1")); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ---------- tiny .xlsx writer: one sheet, strings shared, numbers as numbers, dates as Excel serials ----------
function zip(files) {   // [{ name, data: Buffer }] → deflated zip
  const parts = [], central = [];
  let offset = 0;
  files.forEach((f) => {
    const name = Buffer.from(f.name), comp = zlib.deflateRawSync(f.data), crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(f.data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  });
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;
// rows: arrays of values; a value { date: "YYYY-MM-DD" } is a real Excel date (shown dd/mm/yyyy), a number stays a number.
function xlsx(rows, sheetName = "Hoja1") {
  const strings = [], idx = new Map();
  const si = (s) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s); };
  const col = (i) => { let s = ""; i++; while (i) { s = String.fromCharCode(65 + ((i - 1) % 26)) + s; i = Math.floor((i - 1) / 26); } return s; };
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
    const ref = col(ci) + (ri + 1);
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    if (v && v.date) return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
    return `<c r="${ref}" t="s"><v>${si(String(v))}</v></c>`;
  }).join("") + "</row>").join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`
  };
  files["xl/sharedStrings.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join("")}</sst>`;
  return zip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data, "utf8") })));
}
const csv = (rows, sep = ",") => rows.map((r) => r.map((v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(sep)).join("\r\n") + "\r\n";

// ---------- helpers ----------
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];
const MES_LARGO = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SETIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const fmt = (n) => Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const signed = (n) => (n < 0 ? "-" : "+") + fmt(n);
const r2 = (n) => Math.round(n * 100) / 100;
const dmy = (iso, sep = "/") => iso.slice(8, 10) + sep + iso.slice(5, 7) + sep + iso.slice(0, 4);
const dmyShort = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(2, 4);
const at = (str, x) => ({ str, x });

// ---------- bank statements (PDF), in the layouts docs/statement-parsers.js reads ----------
// lines: [{ date: "YYYY-MM-DD", description, amount (− = money out / a card charge), currency? }]

// Interbank savings ("Cuenta Simple Soles"): running balance on every row, closing "SALDO CONTABLE AL".
function interbankSavingsPdf({ holder, number, currency = "PEN", start, end, opening, lines }) {
  const word = currency === "PEN" ? "SOLES" : "DÓLARES";
  const rows = [
    [at("Interbank", 40)], [at(holder, 40)],
    [at(`CUENTA SIMPLE ${word}`, 40), at(number, 300)],
    [at(`ESTADO DE CUENTA DEL ${+start.slice(8)} DE ${MES_LARGO[+start.slice(5, 7) - 1]} AL ${+end.slice(8)} DE ${MES_LARGO[+end.slice(5, 7) - 1]}`, 40)],
    [at(`EMPEZASTE EL MES CON ${fmt(opening)}`, 40)],
    [at("DETALLE DE MOVIMIENTOS", 40)],
    [at("FECHA", 40), at("DESCRIPCIÓN", 110), at("MONTO", 400), at("SALDO", 490)]
  ];
  let bal = opening, tin = 0, tout = 0;
  lines.forEach((l) => {
    bal = r2(bal + l.amount);
    if (l.amount > 0) tin = r2(tin + l.amount); else tout = r2(tout + l.amount);
    rows.push([at(dmy(l.date), 40), at(l.description, 110), at(signed(l.amount), 400), at(fmt(bal), 490)]);
  });
  rows.push([at("SALDO CONTABLE AL", 40), at(end.slice(8, 10) + "/" + end.slice(5, 7), 140), at(signed(tin), 300), at(signed(tout), 400), at(fmt(bal), 490)]);
  rows.push([at("Cómo leer tu estado de cuenta", 40)]);
  return pdf(rows);
}

// BCP savings ("Estado de Cuenta de Ahorros", Cuenta Digital): charges and credits columns, totals, closing "SALDO".
function bcpSavingsPdf({ holder, code, currency = "PEN", start, end, opening, lines }) {
  const word = currency === "PEN" ? "SOLES" : "DOLARES";
  const ddmon = (iso) => iso.slice(8, 10) + MES[+iso.slice(5, 7) - 1].toUpperCase();
  const rows = [
    [at("BCP", 40)], [at("Estado de Cuenta de Ahorros", 40)], [at(holder, 40)],
    [at("CUENTA DIGITAL", 40), at(word, 160), at(code, 300)],
    [at(`DEL ${dmyShort(start)} AL ${dmyShort(end)}`, 40)],
    [at("FECHA PROC", 40), at("FECHA VALOR", 100), at("DESCRIPCION", 160), at("CARGOS / DEBE", 360), at("ABONOS / HABER", 470)],
    [at("SALDO ANTERIOR", 160), at(fmt(opening), 470)]
  ];
  let charges = 0, credits = 0;
  lines.forEach((l) => {
    const cells = [at(ddmon(l.date), 40), at(ddmon(l.date), 100), at(l.description, 160)];
    if (l.amount < 0) { charges = r2(charges - l.amount); cells.push(at(fmt(l.amount), 380)); }
    else { credits = r2(credits + l.amount); cells.push(at(fmt(l.amount), 480)); }
    rows.push(cells);
  });
  rows.push([at("TOTAL MOVIMIENTO", 160), at(fmt(charges), 380), at(fmt(credits), 480)]);
  rows.push([at("SALDO", 40), at(fmt(r2(opening + credits - charges)), 480)]);
  return pdf(rows);
}

// Interbank credit card (Visa / Mastercard / Amex): two currency columns, sections with subtotals, "PAGO DEL MES".
// lines here: card view, charges POSITIVE in the PDF; we take amount < 0 = purchase, > 0 = payment.
function interbankCardPdf({ holder, cardName = "VISA CLASICA INTERNACIONAL", last4, start, end, previous = { PEN: 0, USD: 0 }, lines }) {
  const pen = (v) => at(v, 400), usd = (v) => at(v, 520);
  const dd = (iso) => iso.slice(8, 10) + "-" + cap(MES[+iso.slice(5, 7) - 1]);
  const sum = (arr, cur) => r2(arr.filter((l) => (l.currency || "PEN") === cur).reduce((a, l) => a + l.amount, 0));
  const pays = lines.filter((l) => l.amount > 0), buys = lines.filter((l) => l.amount < 0);
  const amt = (l) => ((l.currency || "PEN") === "USD" ? [pen("0.00"), usd((l.amount > 0 ? "-" : "") + fmt(l.amount))] : [pen((l.amount > 0 ? "-" : "") + fmt(l.amount)), usd("0.00")]);
  const sub1 = { PEN: r2(previous.PEN - sum(pays, "PEN")), USD: r2(previous.USD - sum(pays, "USD")) };
  const sub2 = { PEN: r2(-sum(buys, "PEN")), USD: r2(-sum(buys, "USD")) };
  const rows = [
    [at(`${cardName} 4772 89** **** ${last4} - SOLES`, 40)], [at(holder, 40)],
    [at("Queremos contarte todo lo que necesitas saber en www.interbank.pe", 40)],
    [at(`del ${dmy(start)} al cierre de ${dmy(end)}`, 40)],
    [at("DETALLE DE PAGO DEL MES", 40)],
    [at("TU ESTADO DE CUENTA ANTERIOR", 40), at("S/", 420), at("US$", 560)],
    [at("Debías en el estado de cuenta anterior *", 40), pen(fmt(previous.PEN)), usd(fmt(previous.USD))],
    [at("PAGOS REALIZADOS", 40)],
    ...pays.map((l) => [at(dd(l.date), 40), at(l.description, 110), ...amt(l)]),
    [at("SUBTOTAL ----", 40), pen(sub1.PEN < 0 ? "-" + fmt(sub1.PEN) : fmt(sub1.PEN)), usd(sub1.USD < 0 ? "-" + fmt(sub1.USD) : fmt(sub1.USD))],
    [at("TUS CONSUMOS", 40)],
    ...buys.map((l) => [at(dd(l.date), 40), at(l.description, 110), ...amt(l)]),
    [at("SUBTOTAL ----", 40), pen(fmt(sub2.PEN)), usd(fmt(sub2.USD))],
    [at("OTROS COBROS", 40)],
    [at("SUBTOTAL ----", 40), pen("0.00"), usd("0.00")],
    [at("PAGO DEL MES (Suma de subtotales)", 40), pen(fmt(r2(sub1.PEN + sub2.PEN))), usd(fmt(r2(sub1.USD + sub2.USD)))]
  ];
  return pdf(rows);
}

// BCP credit card ("Estado de Cuenta Tarjeta VISA"): Soles at x 410, Dólares at x 500, payments with a trailing "-".
function bcpCardPdf({ holder, title = "VISA", last4, start, end, previous = { PEN: 0, USD: 0 }, lines }) {
  const bpen = (v) => at(v, 410), busd = (v) => at(v, 500);
  const dd = (iso) => iso.slice(8, 10) + cap(MES[+iso.slice(5, 7) - 1]);
  const tot = { PEN: previous.PEN, USD: previous.USD };
  const body = lines.map((l) => {
    const cur = l.currency === "USD" ? "USD" : "PEN";
    tot[cur] = r2(tot[cur] - l.amount);
    const v = fmt(l.amount) + (l.amount > 0 ? "-" : "");
    return [at(dd(l.date), 20), at(dd(l.date), 60), at(l.description, 120), at(l.amount > 0 ? "PAGO" : "CONSUMO", 250), cur === "USD" ? busd(v) : bpen(v)];
  });
  const rows = [
    [at(`Estado de Cuenta Tarjeta ${title}`, 20), at("Pag 1", 450), at("de 1", 500)],
    [at("Ciclo de Facturación", 300)],
    [at(holder, 20), at("Número de tarjeta", 170), at("Del", 320), at("Al", 380)],
    [at("Av. Inventada 123", 20), at(`4557-88XX-XXXX-${last4}`, 170), at(dmyShort(start), 320), at(dmyShort(end), 380)],
    [at("Fecha de", 20), at("Fecha de", 60), at("Descripción", 120), at("Tipo de", 250), at("Soles", 400), at("Dólares", 480)],
    [at("SALDO ANTERIOR", 120), bpen(fmt(previous.PEN)), busd(fmt(previous.USD))],
    ...body,
    [at("SUB TOTAL", 120), bpen(fmt(tot.PEN)), busd(fmt(tot.USD))],
    [at("MONTO TOTAL FACTURADO", 120), bpen(fmt(tot.PEN)), busd(fmt(tot.USD))]
  ];
  return pdf(rows);
}

// ---------- bank "movements" spreadsheets (imitations of what online banking lets people download) ----------
function bcpMovementsXlsx({ lines, opening = 0 }) {   // newest first, like the bank's list
  let bal = opening;
  const withBal = lines.map((l) => { bal = r2(bal + l.amount); return { ...l, bal }; });
  return xlsx([["Fecha", "Fecha valuta", "Descripción operación", "Monto", "Saldo", "Sucursal - agencia", "Operación - Número"],
    ...withBal.reverse().map((l, i) => [{ date: l.date }, { date: l.date }, l.description.toUpperCase(), l.amount, l.bal, "LIMA", String(10000 + i)])], "Movimientos");
}
function interbankMovementsCsv({ lines }) {
  return csv([["Fecha de operación", "Fecha de proceso", "Nro. de operación", "Movimiento", "Descripción", "Canal", "Cargo", "Abono"],
    ...lines.map((l, i) => [dmy(l.date), dmy(l.date), String(500000 + i), l.amount < 0 ? "CONSUMO" : "ABONO", l.description.toUpperCase(), "APP", l.amount < 0 ? fmt(l.amount) : "", l.amount > 0 ? fmt(l.amount) : ""])], ";");
}
function bbvaMovementsXlsx({ lines }) {
  return xlsx([["Movimientos de cuenta"], [], ["F. Operación", "F. Valor", "Código", "Nº. Doc.", "Concepto", "Importe", "Oficina"],
    ...lines.map((l, i) => [dmy(l.date), dmy(l.date), "0" + (100 + (i % 50)), String(i + 1), l.description.toUpperCase(), l.amount, "0123"])], "Movimientos");
}
function scotiabankMovementsCsv({ lines }) {
  return csv([["Fecha", "Descripción", "Monto", "Moneda"], ...lines.map((l) => [dmy(l.date), l.description.toUpperCase(), l.amount.toFixed(2), (l.currency || "PEN") === "PEN" ? "SOLES" : "DOLARES"])]);
}

// ---------- other money apps' exports ----------
// entries: [{ date, time?, type: "expense"|"income", amount (positive), currency, category, description, account }]
function spendeeCsv(entries) {   // the layout the app knows by name
  return csv([["Date", "Wallet", "Type", "Category name", "Amount", "Currency", "Note", "Labels", "Author"],
    ...entries.map((e) => [`${e.date}T${e.time || "12:00"}:00+00:00`, e.account || "Mi billetera", e.type === "income" ? "Income" : "Expense", e.category,
      (e.type === "income" ? "" : "-") + e.amount.toFixed(2), e.currency || "PEN", e.description, "", "Ana Lo*"])]);
}
function walletCsv(entries) {   // Wallet by BudgetBakers
  return csv([["account", "category", "currency", "amount", "ref_currency_amount", "type", "payment_type", "payment_type_local", "note", "date", "gps_latitude", "gps_longitude", "gps_accuracy_in_meters", "warranty_in_month", "transfer", "payee", "labels", "envelope_id", "custom_category"],
    ...entries.map((e) => [e.account || "Efectivo", e.category, e.currency || "PEN", (e.type === "income" ? "" : "-") + e.amount.toFixed(2), (e.type === "income" ? "" : "-") + e.amount.toFixed(2),
      e.type === "income" ? "Income" : "Expenses", "CASH", "Efectivo", e.description, `${e.date} ${e.time || "12:00"}:00`, "", "", "", "0", "false", "", "", "", "false"])], ";");
}
function monefyCsv(entries) {   // Monefy: day first, the currency column twice
  return csv([["date", "account", "category", "amount", "currency", "converted amount", "currency", "description"],
    ...entries.map((e) => [dmy(e.date), e.account || "Cash", e.category, (e.type === "income" ? "" : "-") + e.amount.toFixed(2), e.currency || "PEN", (e.type === "income" ? "" : "-") + e.amount.toFixed(2), e.currency || "PEN", e.description])]);
}
function moneyManagerXlsx(entries) {   // Money Manager (Realbyte): month FIRST ("11/14/2026 13:22:05"), "Exp."/"Income"
  const mdy = (iso, t) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)} ${t || "12:00"}:00`;
  return xlsx([["Period", "Accounts", "Category", "Subcategory", "Note", "PEN", "Income/Expense", "Description", "Amount", "Currency", "Accounts"],
    ...entries.map((e) => [mdy(e.date, e.time), e.account || "Cash", e.category, "", e.description, e.amount, e.type === "income" ? "Income" : "Exp.", "", e.amount, e.currency || "PEN", e.amount])], "Sheet1");
}
function homemadeXlsx(entries) {   // a person's own Excel: a title, Spanish headings, real dates, positive amounts, a blank line and a total
  const total = r2(entries.filter((e) => e.type !== "income").reduce((a, e) => a + e.amount, 0));
  return xlsx([["MIS GASTOS"], [], ["Fecha", "Concepto", "Categoría", "Monto (S/)", "Tipo"],
    ...entries.map((e) => [{ date: e.date }, e.description, e.category, e.amount, e.type === "income" ? "Ingreso" : "Gasto"]),
    [], ["", "TOTAL GASTOS", "", total, ""]], "Gastos");
}

module.exports = { pdf, xlsx, csv, interbankSavingsPdf, bcpSavingsPdf, interbankCardPdf, bcpCardPdf,
  bcpMovementsXlsx, interbankMovementsCsv, bbvaMovementsXlsx, scotiabankMovementsCsv,
  spendeeCsv, walletCsv, monefyCsv, moneyManagerXlsx, homemadeXlsx };
