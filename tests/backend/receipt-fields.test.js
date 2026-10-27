// Receipt / invoice / payment-screenshot text -> the fields an expense or income needs (docs/receipt-fields.js).
// Made-up receipts only (no real names, numbers or amounts).
const test = require("node:test");
const assert = require("node:assert/strict");
const { parse, toNumber, amountsOf, datesOf } = require("../../docs/receipt-fields.js");

const TODAY = "2026-10-27";

test("amounts: thousands and decimals in both styles; percentages and dates are not amounts", () => {
  assert.equal(toNumber("1,180.00"), 1180);
  assert.equal(toNumber("1.180,00"), 1180);
  assert.equal(toNumber("118,50"), 118.5);
  assert.ok(Number.isNaN(toNumber("118")));
  assert.deepEqual(amountsOf("IGV 18%   18.00"), [18]);
  assert.deepEqual(amountsOf("Fecha 12.10.2026"), []);
  assert.deepEqual(amountsOf("OP. GRAVADA  S/ 100.00   TOTAL  118.00"), [100, 118]);
});

test("dates: day first, two-digit years, words in Spanish and English, impossible ones refused", () => {
  assert.deepEqual(datesOf("Fecha: 12/10/2026"), ["2026-10-12"]);
  assert.deepEqual(datesOf("12-10-26"), ["2026-10-12"]);
  assert.deepEqual(datesOf("2026-10-12 14:33"), ["2026-10-12"]);
  assert.deepEqual(datesOf("12 oct. 2026"), ["2026-10-12"]);
  assert.deepEqual(datesOf("5 de septiembre de 2026"), ["2026-09-05"]);
  assert.deepEqual(datesOf("Oct 12 2026"), [], "month-first words are not guessed");
  assert.deepEqual(datesOf("31/02/2026"), []);
  assert.deepEqual(datesOf("10/25/2026"), ["2026-10-25"], "a month above 12 can only be the day");
});

const FACTURA = `
LIBRERIA ANDINA SAC
RUC: 20123456789
FACTURA ELECTRONICA
F001-00012
Fecha de emisión: 12/10/2026
Señor(es): ESTUDIO ALFA SAC
Cant  Descripción        P.Unit   Importe
2     Papel bond A3      30.00    60.00
1     Marcadores         40.00    40.00
OP. GRAVADA              100.00
IGV 18%                   18.00
IMPORTE TOTAL            118.00
SON: CIENTO DIECIOCHO CON 00/100 SOLES
`;

test("an invoice: total, date, business, IGV, invoice number, RUC and the client", () => {
  const f = parse(FACTURA, { today: TODAY });
  assert.equal(f.amount, "118.00");
  assert.equal(f.date, "2026-10-12");
  assert.equal(f.name, "Libreria Andina SAC");
  assert.equal(f.igv, "18.00");
  assert.equal(f.invoice, "F001-00012");
  assert.equal(f.ruc, "20123456789");
  assert.equal(f.payer, "Estudio Alfa SAC");
  assert.equal(f.currency, "PEN");
});

test("the subtotal, the base and the IGV are never mistaken for the total", () => {
  const f = parse(`BODEGA SOL\nSUBTOTAL 84.75\nOP. GRAVADA 84.75\nIGV 15.25\nTOTAL 100.00\n`, { today: TODAY });
  assert.equal(f.amount, "100.00");
  assert.equal(f.igv, "15.25");
  const noTotal = parse(`BODEGA SOL\nSUBTOTAL 84.75\nIGV 15.25\n`, { today: TODAY });
  assert.equal(noTotal.amount, "", "a subtotal alone is not the total");
});

test("OCR slips in the keywords are repaired (T0TAL, 1GV)", () => {
  const f = parse(`FERRETERIA UNO SRL\n1GV 18%  27.00\nT0TAL  177.00\n`, { today: TODAY });
  assert.equal(f.amount, "177.00");
  assert.equal(f.igv, "27.00");
});

test("an IGV as large as the total is a misread and is left out", () => {
  const f = parse(`TIENDA\nIGV 118.00\nTOTAL 118.00\n`, { today: TODAY });
  assert.equal(f.igv, "");
});

test("a receipt without IGV leaves it blank; the date prefers the line that says Fecha", () => {
  const f = parse(`MERCADO CENTRAL\nCaja 3  01/01/2026\nFecha: 20/10/2026\nTOTAL 23.50\n`, { today: TODAY });
  assert.equal(f.igv, "");
  assert.equal(f.date, "2026-10-20");
  assert.equal(f.amount, "23.50");
});

test("a date still to come is a misread and is ignored", () => {
  const f = parse(`MERCADO CENTRAL\nFecha: 20/10/2029\nTOTAL 23.50\n`, { today: TODAY });
  assert.equal(f.date, "");
});

test("the number printed on the line after TOTAL is read", () => {
  const f = parse(`BODEGA SOL\nTOTAL A PAGAR\n45.90\n`, { today: TODAY });
  assert.equal(f.amount, "45.90");
});

test("a payment screenshot: amount next to the currency, the person who paid, the date", () => {
  const f = parse(`¡Te yaperon!\nAna Lo* te yapeó\nS/ 350\n27 oct. 2026 | 10:32 a. m.\nCódigo de seguridad 123\n`, { today: TODAY });
  assert.equal(f.amount, "350.00");
  assert.equal(f.payer, "Ana Lo*");
  assert.equal(f.date, "2026-10-27");
  assert.equal(f.currency, "PEN");
});

test("a dollar amount is read with the currency it is printed in", () => {
  const f = parse(`Transferencia recibida\nDe: Acme Studio LLC\nMonto: US$ 1,250.50\nFecha 2026-10-15\n`, { today: TODAY });
  assert.equal(f.amount, "1250.50");
  assert.equal(f.currency, "USD");
  assert.equal(f.payer, "Acme Studio LLC");
  assert.equal(f.date, "2026-10-15");
});

test("invoice numbers: a letter and three characters, OCR's O for zero repaired; other dashes are not invoices", () => {
  assert.equal(parse("Factura N° FOO1-123\nTOTAL 10.00").invoice, "F001-123");
  assert.equal(parse("B001-7\nTOTAL 10.00").invoice, "B001-7");
  assert.equal(parse("Telf 987-654321\nTOTAL 10.00").invoice, "");
  assert.equal(parse("Pedido ABC-12\nTOTAL 10.00").invoice, "");
});

test("the business name skips addresses, RUC and headers; an empty or noisy text gives nothing, never a crash", () => {
  const f = parse(`BOLETA DE VENTA ELECTRONICA\nAv. Los Pinos 123\nRUC 20111111111\nCAFE DEL PARQUE\nTOTAL 12.00\n`);
  assert.equal(f.name, "Cafe del Parque".replace("del", "Del"), "title-cased, address and header lines skipped");
  const empty = parse("");
  assert.deepEqual(empty, { amount: "", date: "", name: "", payer: "", igv: "", invoice: "", ruc: "", currency: "" });
  assert.doesNotThrow(() => parse("\n\n @@@ ### \n 1 2 3 \n"));
});
