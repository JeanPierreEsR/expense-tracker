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
  assert.deepEqual(names(r), ["Lomo Saltado:42.00", "Inca Kola 500:6.00", "Promo Lomo:-10.00"]);
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
