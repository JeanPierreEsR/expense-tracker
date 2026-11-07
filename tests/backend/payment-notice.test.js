// Interbank "Constancia de pago" PDFs (2026-11-07): money a company paid into the person's account. The e-mail only says who paid; the
// amount is in the PDF, which the owner sends to his own Gmail. Each PDF becomes one waiting INCOME entry. The PDFs here are MADE UP,
// built like the bank's (compressed page text, labels first then values); no real payer, amount or file name.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { freshApp } = require("./helpers");

const OWNER = "Owner <test@example.com>";

// A one-page PDF whose page text is a FlateDecode stream of Tj commands, like iTextSharp writes.
function makePdf(strings, { compress = true, tj = "Tj" } = {}) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = "BT\n/F1 10 Tf\n" + strings.map((s, i) => `1 0 0 1 50 ${800 - i * 12} Tm\n` +
    (tj === "TJ" ? `[(${esc(s.slice(0, 3))}) -20 (${esc(s.slice(3))})] TJ` : `(${esc(s)})Tj`)).join("\n") + "\nET";
  const raw = Buffer.from(content, "latin1");
  const body = compress ? zlib.deflateSync(raw) : raw;
  const parts = [Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n4 0 obj<</Length " + body.length + (compress ? "/Filter/FlateDecode" : "") + ">>stream\n", "latin1"),
    body, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")];
  return [...Buffer.concat(parts)];
}
const notice = (payer, date, rows) => ["Constancia de pago", "Información del pago", "Información de los documentos",
  "Ordenante", "Fecha", "Tipo", "Código del lote", payer, date, "Abono en Cuenta", "ZZ"]
  .concat(...rows.map((r, i) => ["0000" + (i + 1), "", "Factura", r.cur === "$" ? "Dólares" : "Soles", " /  /", r.cur + " " + r.amt]));
const NAME = "20260102_101500_0001_99ZZ01ZZ.pdf";

function setup(opts) {
  const { rt, data } = freshApp({ entries: 200, ...(opts || {}) });
  return { rt, data };
}
const run = (rt) => JSON.parse(JSON.stringify(rt.run("processEmails()")));
const incomes = (rt) => rt.rows("Entries").filter((e) => String(e.external_id || "").startsWith("ibk-pago:"));
const selfMail = (rt, attachments, extra) => rt.svc.gmail.addEmail({ from: OWNER, to: OWNER, subject: attachments[0].name.replace(".pdf", ""), body: "", attachments, ...(extra || {}) });
const pdfAtt = (name, bytes) => ({ name, size: bytes.length, bytes });
function addSueldo(rt, nickname, currencies) {
  const bank = rt.rows("Banks").find((b) => b.name === "Interbank");
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-sueldo-test', nickname: ${JSON.stringify(nickname)}, type: 'debit', bank_id: ${JSON.stringify(bank.id)}, last_4: '', currencies: ${JSON.stringify(currencies || "")} })`);
  return "pm-sueldo-test";
}

test("the PDF reader unpacks compressed page text and reads the words in order", () => {
  const { rt } = setup();
  const words = notice("EMPRESA PRUEBA SAC", "02/01/2026", [{ cur: "S/.", amt: "1,234.56" }]);
  const got = rt.run(`pdfTextStrings_(${JSON.stringify(makePdf(words))})`);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), words.map((w) => w.trim()));
  // TJ arrays (text split with spacing) and uncompressed pages read too; signed bytes (as Apps Script gives them) too.
  const tj = rt.run(`pdfTextStrings_(${JSON.stringify(makePdf(["Constancia de pago"], { tj: "TJ" }))})`);
  assert.equal(tj[0], "Constancia de pago");
  const plain = rt.run(`pdfTextStrings_(${JSON.stringify(makePdf(["Hola (prueba)"], { compress: false }))})`);
  assert.equal(plain[0], "Hola (prueba)");
  const signed = makePdf(words).map((b) => (b > 127 ? b - 256 : b));
  assert.equal(rt.run(`pdfTextStrings_(${JSON.stringify(signed)})`)[7], "EMPRESA PRUEBA SAC");
  assert.deepEqual(JSON.parse(JSON.stringify(rt.run(`pdfTextStrings_([1,2,3])`))), []);
});

test("inflate handles a large, repetitive page (dynamic Huffman blocks and long back-references)", () => {
  const { rt } = setup();
  const many = Array.from({ length: 400 }, (_, i) => "Linea de prueba numero " + (i % 37) + " áéíóúñ");
  const got = JSON.parse(JSON.stringify(rt.run(`pdfTextStrings_(${JSON.stringify(makePdf(many))})`)));
  assert.deepEqual(got, many);
});

test("a PDF sent to himself becomes one waiting income: payer, the PDF's date, amount, IBK sueldo", () => {
  const { rt } = setup();
  const pm = addSueldo(rt, "IBK Sueldo");
  selfMail(rt, [pdfAtt(NAME, makePdf(notice("EMPRESA PRUEBA SAC", "02/01/2026", [{ cur: "S/.", amt: "1,234.56" }])))]);
  const res = run(rt);
  assert.equal(res.paymentNotices, 1);
  const got = incomes(rt);
  assert.equal(got.length, 1);
  const e = got[0];
  assert.equal(e.type, "income");
  assert.equal(e.status, "pending");
  assert.equal(e.source, "email");
  assert.equal(e.description, "EMPRESA PRUEBA SAC");
  assert.equal(String(e.date).slice(0, 10), "2026-01-02");
  assert.equal(Number(e.amount), 1234.56);
  assert.equal(e.currency, "PEN");
  assert.equal(e.payment_method_id, pm);
  assert.equal(e.external_id, "ibk-pago:20260102_101500_0001_99ZZ01ZZ");
});

test("several invoices are added up; the same PDF sent twice, and the bank's own e-mail, make no second entry", () => {
  const { rt } = setup();
  const bytes = makePdf(notice("EMPRESA DOS SA", "03/01/2026", [{ cur: "S/.", amt: "100.10" }, { cur: "S/.", amt: "50.05" }]));
  selfMail(rt, [pdfAtt(NAME, bytes)]);
  run(rt);
  assert.equal(incomes(rt).length, 1);
  assert.equal(Number(incomes(rt)[0].amount), 150.15);
  selfMail(rt, [pdfAtt(NAME, bytes)], { subject: "otra vez" });
  rt.svc.gmail.addEmail({ from: "pagoactivo@notificaciones.interbank.pe", subject: "ANA, has recibido un pago", body: "Tenemos una notificación de pago para ti", attachments: [pdfAtt(NAME, bytes)] });
  const res = run(rt);
  assert.equal(incomes(rt).length, 1);
  assert.equal(res.duplicates, 2);
});

test("a dollar notice: in dollars, and not into a soles-only IBK sueldo (left for the person to pick)", () => {
  const { rt } = setup();
  addSueldo(rt, "IBK sueldo", "PEN");
  selfMail(rt, [pdfAtt("20260104_090000_0002_99ZZ02ZZ.pdf", makePdf(notice("EMPRESA TRES", "04/01/2026", [{ cur: "$", amt: "99.50" }])))]);
  run(rt);
  const e = incomes(rt)[0];
  assert.equal(e.currency, "USD");
  assert.equal(Number(e.amount), 99.5);
  assert.notEqual(e.payment_method_id, "pm-sueldo-test");
});

test("other PDFs he sends himself, statements, and PDFs from strangers are left alone", () => {
  const { rt } = setup();
  selfMail(rt, [pdfAtt("contrato.pdf", makePdf(["Contrato de alquiler", "Monto", "S/. 500.00"]))]);
  selfMail(rt, [pdfAtt("account_summary_01.pdf", makePdf(notice("NO DEBE LEERSE", "05/01/2026", [{ cur: "S/.", amt: "1.00" }])))]);
  rt.svc.gmail.addEmail({ from: "Desconocido <x@example.org>", to: OWNER, subject: "pago", body: "", attachments: [pdfAtt(NAME, makePdf(notice("EXTRAÑO", "05/01/2026", [{ cur: "S/.", amt: "9.00" }])))] });
  run(rt);
  assert.equal(incomes(rt).length, 0);
});

test("the Statements Inbox never lists a Constancia de pago, but still lists account_summary", () => {
  const { rt } = setup();
  assert.equal(rt.run(`stmtIsStatementAttachment_(${JSON.stringify(NAME)})`), false);
  assert.equal(rt.run(`stmtIsStatementAttachment_('account_summary_01.pdf')`), true);
});
