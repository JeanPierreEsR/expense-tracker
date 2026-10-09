// Receipt text -> bill pieces (docs/receipt-parse.js). Made-up receipts only,
// written the way the phone's OCR tends to return them.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseReceipt, parseAmount } = require("../../docs/receipt-parse.js");

const names = (r) => r.items.map((i) => `${i.name}:${i.discount ? "-" : ""}${i.price}`);

test("amounts in the usual shapes", () => {
  assert.equal(parseAmount("38.00"), 38);
  assert.equal(parseAmount("38,00"), 38);
  assert.equal(parseAmount("1,234.50"), 1234.5);
  assert.equal(parseAmount("1.234,50"), 1234.5);
  assert.equal(parseAmount("abc"), null);
});

test("a restaurant receipt: dishes, quantity x unit price, service and total", () => {
  const r = parseReceipt([
    "RESTAURANTE EJEMPLO S.A.C.",
    "RUC 20123456789",
    "MESA 5    MOZO: ANA",
    "CANT DESCRIPCION   P.UNIT  IMPORTE",
    "1 CEVICHE MIXTO     38.00   38.00",
    "2 PISCO SOUR        18.00   36.00",
    "1 CHICHA JARRA      15.00",
    "SUBTOTAL            89.00",
    "SERVICIO 10%         8.90",
    "TOTAL S/            97.90"
  ].join("\n"));
  assert.deepEqual(names(r), ["Ceviche Mixto:38.00", "Pisco Sour x2:36.00", "Chicha Jarra:15.00"]);
  assert.deepEqual(r.charges, [{ name: "Servicio", amount: "8.90" }]);
  assert.equal(r.total, "97.90");
  assert.deepEqual(r.warnings, []);
});

test("a discount printed under a dish (negative or DSCTO) is a discount line", () => {
  const r = parseReceipt([
    "1 LOMO SALTADO   42.00",
    "1 INCA KOLA 500   6.00",
    "DSCTO PROMO LOMO  -10.00",
    "TOTAL            38.00"
  ].join("\n"));
  // the discount names the Lomo, so it is moved to sit right under it
  assert.deepEqual(names(r), ["Lomo Saltado:42.00", "Promo Lomo:-10.00", "Inca Kola 500:6.00"]);
  assert.equal(r.total, "38.00");
  assert.deepEqual(r.warnings, []);
});

test("a trailing minus counts as negative too", () => {
  const r = parseReceipt("1 ARROZ CHAUFA 20.00\nDESCUENTO 2.00-\nTOTAL 18.00");
  assert.deepEqual(names(r), ["Arroz Chaufa:20.00", "Descuento:-2.00"]);
});

test("a bill-wide discount after the subtotal is kept apart, and the total is the one BEFORE it", () => {
  const r = parseReceipt([
    "1 PIZZA FAMILIAR   60.00",
    "1 GASEOSA 1.5L     10.00",
    "SUBTOTAL           70.00",
    "DESCUENTO 10%      -7.00",
    "TOTAL              63.00"
  ].join("\n"));
  assert.deepEqual(names(r), ["Pizza Familiar:60.00", "Gaseosa 1.5l:10.00"]);
  assert.deepEqual(r.discounts, [{ name: "Descuento 10%", amount: "7.00" }]);
  assert.equal(r.total, "70.00");
  assert.deepEqual(r.warnings, []);
});

test("OCR slips inside prices are repaired (O for 0, comma decimals)", () => {
  const r = parseReceipt("1 CAFE AMERICANO  1O,OO\n1 TORTA CHOCOLATE 14,50\nTOTAL 24,50");
  assert.deepEqual(names(r), ["Cafe Americano:10.00", "Torta Chocolate:14.50"]);
  assert.equal(r.total, "24.50");
});

test("a suggested tip printed BELOW the total is not part of the bill", () => {
  const r = parseReceipt("1 PAN CON CHICHARRON 18.00\nTOTAL 18.00\nPROPINA SUGERIDA 10%  1.80");
  assert.deepEqual(r.charges, []);
  assert.equal(r.total, "18.00");
  assert.deepEqual(r.warnings, []);
});

test("when the lines don't add up to the total, it says so instead of guessing", () => {
  const r = parseReceipt("1 SOPA 12.00\nTOTAL 20.00");
  assert.equal(r.total, "20.00");
  assert.match(r.warnings.join(" "), /add up to 12\.00 but the bill says 20\.00/);
});

test("a convenience-store receipt with tax lines and a payment block", () => {
  const r = parseReceipt([
    "TIENDA EJEMPLO",
    "RUC 20999999999",
    "AGUA MINERAL 625ML   2.50",
    "GALLETAS CHOCO       3.20",
    "2 CERVEZA LATA       5.00  10.00",
    "OP. GRAVADA         13.14",
    "IGV 18%              2.56",
    "TOTAL S/            15.70",
    "EFECTIVO            20.00",
    "VUELTO               4.30"
  ].join("\n"));
  assert.deepEqual(names(r), ["Agua Mineral 625ml:2.50", "Galletas Choco:3.20", "Cerveza Lata x2:10.00"]);
  assert.equal(r.total, "15.70");
  assert.deepEqual(r.warnings, []);
});

test("garbage in gives empty lists and warnings, not a crash", () => {
  const r = parseReceipt("???\n@@@\n");
  assert.deepEqual(r.items, []);
  assert.ok(r.warnings.length >= 1);
  assert.deepEqual(parseReceipt("").items, []);
});

test("a service line whose amount the reader garbled is worked out from the total, and flagged", () => {
  const r = parseReceipt([
    "1 CEVICHE MIXTO     38.00",
    "1 LOMO SALTADO      42.00",
    "SUBTOTAL            80.00",
    "SERVICIO 10%        Les 10",
    "TOTAL S/            88.00"
  ].join("\n"));
  assert.deepEqual(r.charges, [{ name: "Servicio", amount: "8.00" }]);
  assert.equal(r.total, "88.00");
  assert.match(r.warnings.join(" "), /couldn't be read; 8\.00 was worked out/);
});

test("an unreadable service line is NOT guessed when the gap is implausibly large", () => {
  const r = parseReceipt("1 SOPA 10.00\nSERVICIO 10%  ???\nTOTAL 40.00");
  assert.deepEqual(r.charges, []);
  assert.match(r.warnings.join(" "), /add up to 10\.00 but the bill says 40\.00/);
});

// ---- the Cant / P.U / Importe layout (made-up items; layout and reader slips as seen on a real photo) ----
const COLUMNS = [
  "18/09/2026 22:54:19",
  "Articulo        Cant   P.U  Importe",
  "Agua Mora: 500 ML    1  12.00  12.00",
  "  SIN GAS",
  "Agua Mora: 500 ML    1  12.00  12.08",
  "  CON GAS",
  "Limonada Frozen      2  14.00  28.00",
  "Lomo Fino            1  55.00  55.00",
  "Papas Rusticas       1  22.00  22.08",
  "Helado Mixto         2  16.00  32.00",
  "Cafe Cortado         1   9.00   9.00",
  "Postre Casa          1   0.00   0.00",
  "total Venta:               S/ 170.00",
  "Dcto (Otros):              S/  20.00",
  "total a pagar:             S/ 150.00"
].join("\n");

test("quantity AFTER the name, wrapped names, a Dcto line after the total, 0-read-as-8 repaired", () => {
  const r = parseReceipt(COLUMNS);
  assert.deepEqual(names(r), [
    "Agua Mora: 500 ML Sin Gas:12.00",
    "Agua Mora: 500 ML Con Gas:12.00",   // 12.08 -> 12.00 (quantity x unit says so)
    "Limonada Frozen x2:28.00",
    "Lomo Fino:55.00",
    "Papas Rusticas:22.00",              // 22.08 -> 22.00
    "Helado Mixto x2:32.00",
    "Cafe Cortado:9.00",                 // a real 9 is left alone
    "Postre Casa:0.00"
  ]);
  assert.equal(r.total, "170.00");       // the total BEFORE the bill-wide discount
  assert.deepEqual(r.discounts, [{ name: "Dcto (Otros)", amount: "20.00" }]);
  assert.deepEqual(r.warnings, []);
});

test("a stray third decimal and a comma decimal are read as prices", () => {
  const r = parseReceipt("Ceviche    1  48.060  48.00\nSopa   1  45,00  45,00\nTOTAL  93.00");
  assert.deepEqual(names(r), ["Ceviche:48.00", "Sopa:45.00"]);
  assert.equal(r.total, "93.00");
});

test("when the lines don't add up, the one line whose 8/9 should be a 0 is fixed and flagged", () => {
  const r = parseReceipt("Ceviche 38.00\nSopa 12.08\nArroz 20.00\nTOTAL 70.00");
  assert.deepEqual(names(r), ["Ceviche:38.00", "Sopa:12.00", "Arroz:20.00"]);
  assert.match(r.warnings.join(" "), /Fixed a number.*"Sopa"/);
});

test("a total whose own 0 was read as a 9 is repaired from the lines", () => {
  const r = parseReceipt("Ceviche 38.00\nSopa 12.00\nTOTAL 50.09");
  assert.equal(r.total, "50.00");
  assert.deepEqual(r.warnings, []);
});

test("an ambiguous misread is NOT guessed", () => {
  // two lines could each be the culprit for a 0.08 gap -> leave both, say so
  const r = parseReceipt("Plato A 10.08\nPlato B 10.08\nTOTAL 20.08");
  assert.equal(r.total, "20.08");
  assert.deepEqual(names(r), ["Plato A:10.08", "Plato B:10.08"]);
});

test("junk words with no letters in a wrapped line are not glued onto a dish name", () => {
  const r = parseReceipt("Lomo Fino   1  55.00  55.00\na AZ\nTOTAL 55.00");
  assert.deepEqual(names(r), ["Lomo Fino:55.00"]);
});

test("a zero misread in the whole-soles part is fixed when quantity x unit price agrees", () => {
  // real line is 2 x 50.00 = 100.00; the reader gave 50.08 and 109.08
  const r = parseReceipt("Pasta Nera: 2    2  50.08  109.08\nTOTAL 100.00");
  assert.deepEqual(names(r), ["Pasta Nera: 2 x2:100.00"]);
  assert.deepEqual(r.warnings, []);
});

test("a free item misread as 8.09 is a free item (0.00 x 1 says so)", () => {
  const r = parseReceipt("Flan Casero   1  0.00  8.09\nLomo Fino   1  55.00  55.00\nTOTAL 55.00");
  assert.deepEqual(names(r), ["Flan Casero:0.00", "Lomo Fino:55.00"]);
});

test("a last number that lost a digit (16.0) is read as 16.00", () => {
  const r = parseReceipt("Agua Mora   1  16.00  16.0\nTOTAL 16.00");
  assert.deepEqual(names(r), ["Agua Mora:16.00"]);
  assert.deepEqual(r.warnings, []);
});

test("a bill that prices items WITHOUT its taxes: IGV / surcharge between SUBTOTAL and TOTAL are added as charges", () => {
  const r = parseReceipt([
    "1 HAMBURGUESA CLASICA   28.00",
    "1 PAPAS FRITAS          10.00",
    "SUBTOTAL: 38.00",
    "RECARGO CONSUMO: 2.66",
    "IGV: 6.84",
    "TOTAL: 47.50"
  ].join("\n"));
  assert.equal(r.total, "47.50");
  assert.deepEqual(r.charges.map((c) => c.amount).sort(), ["2.66", "6.84"]);
  assert.match(r.warnings.join(" "), /adds .* on top of the item prices/i);
});

test("taxes printed AFTER the total (already inside the prices) are not charges", () => {
  const r = parseReceipt("1 SOPA 30.00\n1 JUGO 8.00\nTotal a Pagar S/ 38.00\nIGV 18.00% S/ 5.80\nImporte Total S/ 38.00");
  assert.deepEqual(r.charges, []);
  assert.equal(r.total, "38.00");
  assert.deepEqual(r.warnings, []);
});

test("a dish line whose price the reader missed is kept with an empty price; a single one is filled from the total", () => {
  const one = parseReceipt("1 SPRITE\n1 PILSEN CALLAO   14.00\n1 LOMO FINO   20.00\nTotal : S/.44.00");
  assert.deepEqual(one.items.map((i) => `${i.name}:${i.price}`), ["Sprite:10.00", "Pilsen Callao:14.00", "Lomo Fino:20.00"]);
  assert.match(one.warnings.join(" "), /price of "Sprite" wasn't read; 10\.00/);
  const two = parseReceipt("1 SPRITE\n1 VASO SMIRNOFF\n1 PILSEN CALLAO   14.00\nTotal : S/.60.00");
  assert.deepEqual(two.items.map((i) => `${i.name}:${i.price}`), ["Sprite:", "Vaso Smirnoff:", "Pilsen Callao:14.00"]);
  assert.match(two.warnings.join(" "), /2 lines have no price read/);
});

test("free modifier lines (no price) are dropped when the bill already adds up without them", () => {
  const r = parseReceipt("1 CAFE LATTE   14.00\n+LECHE DE ALMENDRA   1\n1 GALLETA   9.00\nTotal Venta: S/ 23.00");
  assert.deepEqual(r.items.map((i) => `${i.name}:${i.price}`), ["Cafe Latte:14.00", "Galleta:9.00"]);
  assert.deepEqual(r.warnings, []);
});
