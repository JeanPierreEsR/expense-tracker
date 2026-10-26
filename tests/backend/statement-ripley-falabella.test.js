// Banco Ripley credit-card reader and Banco Falabella savings reader (docs/statement-parsers.js).
// Every row below is made up; it only mimics the layouts the readers expect (names, streets and numbers are invented).
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

const at = (str, x0) => ({ str, x0, x1: x0 + str.length * 5 });
const row = (...cells) => ({ text: cells.map((c) => c.str).join(" "), cells });

// ---------- Ripley ----------

function ripley({ prev = "100.00", totalDue = "S/ 164.50", period = "27/ENE/2026-26/FEB/2026", extra = [], summary = null } = {}) {
  return [
    row(at("MARIA", 30)),
    row(at("EECC Tarjeta de Crédito Ripley", 300)),
    row(at("EJEMPLO PEREZ", 30)),
    row(at("CALLE INVENTADA 456", 30)),
    row(at("En Resumen", 10)),
    row(at("Número de Tarjeta Ripley:", 30), at("Moneda", 200), at("Último Día de Pago (1)", 330), at("(*) Pago Mínimo del Mes (1)", 470)),
    row(at("123456******4321", 150), at("Soles", 210), at("15/MAR/2026", 340), at("S/ 20.00", 480)),
    row(at("Linea de crédito (1)", 30), at("Periodo de Facturación", 330), at("(*) Pago Total del Mes (1)", 450)),
    row(at("S/ 5,000.00", 30), at(period, 330), at(totalDue, 480)),
    row(at("Tus movimientos del mes", 30)),
    row(at("Fecha de", 30), at("Fecha de", 90), at("Nº", 150), at("Descripción", 200), at("Monto", 330), at("Total", 520)),
    row(at("02/FEB/2026", 30), at("02/FEB/2026", 90), at("123456", 150), at("COMPRA EN REVOLVENTE TIENDA UNO", 200), at("T", 320), at("80.00", 345), at("59.99%", 400), at("1/1", 450), at("80.00", 530)),
    row(at("10/FEB/2026", 30), at("10/FEB/2026", 90), at("654321", 150), at("PAGO DIGITAL OTRO BANCO", 200), at("T", 320), at("-20.00", 530)),
    row(at("11/FEB/2026", 30), at("11/FEB/2026", 90), at("DEVOLUCION TIENDA UNO", 200), at("-5.00", 534)),
    row(at("26/FEB/2026", 30), at("26/FEB/2026", 90), at("SEGURO DE DESGRAVAMEN", 200), at("9.50", 538)),
    ...extra,
    row(at("¿Cómo se calcula el pago total y mínimo del mes?", 10)),
    row(at("+/- Saldo anterior", 30), at("+", 110), at("Consumo Revolvente", 120), at("+", 190), at("Cuota", 200), at("+", 250), at("Interés", 260), at("+", 300), at("Cargos", 310), at("-", 350), at("Pagos", 360), at("=", 400), at("(*) Pago Total del Mes", 410)),
    summary || row(at("S/ " + prev, 35), at("S/ 75.00", 125), at("S/ 9.50", 312), at("S/ 20.00", 362), at("S/ 164.50", 420))
  ];
}

test("Ripley card is recognised, named and verified; the right-most amount of a row is its total", () => {
  const r = SP.parseStatement(ripley());
  assert.equal(r.kind, "ripley");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.bank, "Banco Ripley");
  assert.equal(r.account.last4, "4321");
  assert.equal(r.account.label, "Ripley card");
  assert.deepEqual(r.period, { start: "2026-01-27", end: "2026-02-26" });
  assert.deepEqual(r.balances, { PEN: { opening: -100, closing: -164.5 } });
});

test("Ripley card lines: sign, currency, operation date, payments, refunds and fees", () => {
  const r = SP.parseStatement(ripley());
  const by = (d) => r.lines.find((l) => l.description.startsWith(d));
  assert.deepEqual(by("COMPRA EN REVOLVENTE"), { date: "2026-02-02", description: "COMPRA EN REVOLVENTE TIENDA UNO", amount: -80, currency: "PEN", section: "purchases" });
  assert.equal(by("PAGO DIGITAL").amount, 20);
  assert.equal(by("PAGO DIGITAL").section, "payments");
  assert.equal(by("DEVOLUCION").amount, 5);
  assert.equal(by("DEVOLUCION").section, "refunds");
  assert.equal(by("SEGURO").amount, -9.5);
  assert.equal(by("SEGURO").section, "fees");
  assert.equal(r.lines.length, 4, "the formula table below the movements is not read as lines");
});

test("Ripley card: the previous balance can be a 'SALDO INICIAL' row, and a blank summary column means zero", () => {
  const rows = ripley({
    prev: "0.00",
    totalDue: "S/ 64.50",
    summary: row(at("S/ 75.00", 125), at("S/ 9.50", 312), at("S/ 20.00", 362), at("S/ 64.50", 420))
  });
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.balances, { PEN: { opening: 0, closing: -64.5 } });
  const withRow = ripley({ prev: "0.00", totalDue: "S/ 64.50" });
  withRow.splice(11, 0, row(at("SALDO INICIAL", 200), at("0.00", 538)));
  assert.equal(SP.parseStatement(withRow).ok, true);
});

test("Ripley card: a total that does not add up is rejected, and so is a missing one", () => {
  const bad = SP.parseStatement(ripley({ totalDue: "S/ 170.00" }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /164\.50.*170\.00/);
  const rows = ripley();
  rows[8] = row(at("S/ 5,000.00", 30), at("27/ENE/2026-26/FEB/2026", 330));
  const missing = SP.parseStatement(rows);
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(" "), /Pago Total del Mes/);
});

test("Ripley card: the holder is the given name above the title plus the surnames below it", () => {
  assert.equal(SP.parseStatement(ripley()).holder, "MARIA EJEMPLO PEREZ");
});

test("Ripley card without a readable card number is reported, not guessed", () => {
  const rows = ripley();
  rows[6] = row(at("Soles", 210), at("15/MAR/2026", 340));
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, false);
});

// ---------- Falabella savings ----------

function falabella({ closing = "1,101.50", product = "CUENTA AHORRO BANCO FALABELLA SOLES", extra = [] } = {}) {
  return [
    row(at("statement-file|99999999|ECBF_CUENTA.pdf", 1)),
    row(at("Tu Estado de Cuenta", 300)),
    row(at("MARIA EJEMPLO PEREZ", 30), at("Producto:", 300), at(product, 380)),
    row(at("CALLE INVENTADA 456", 30), at("Fecha de apertura:", 300), at("01/03/2020", 380)),
    row(at("LIMA - 15001", 30), at("Período:", 300), at("01/09/2026 - 30/09/2026", 380)),
    row(at("-", 30), at("Número de la cuenta:", 300), at("1-234-5678901-2", 400)),
    row(at("TREA", 30), at("Moneda", 250)),
    row(at("0.50%", 30), at("SOLES", 260)),
    row(at("Saldo", 30), at("Saldo", 250)),
    row(at("Contable", 30), at(closing, 110), at("Disponible", 250), at(closing, 330)),
    row(at("DETALLE DE MOVIMIENTOS HISTÓRICOS*", 30)),
    row(at("FECHA", 40), at("MOVIMIENTOS", 120), at("SALDOS", 330)),
    row(at("01/09/2026", 40), at("SALDO ANTERIOR CONTABLE", 100), at("1,000.00", 380)),
    row(at("05/09/2026", 40), at("PAGO TCR MISMO TITULAR", 100), at("CENTRO FINANCIERO UNO", 200), at("-100.00", 395)),
    row(at("08/09/2026", 40), at("ABONO SUELDO", 100), at("EMPRESA DOS", 200), at("250.00", 399)),
    row(at("20/09/2026", 40), at("COMPRA VIA POS MN", 100), at("CENTRO FINANCIERO UNO", 200), at("-48.50", 399)),
    ...extra
  ];
}

test("Falabella savings account is recognised, named and verified by opening + movements = Saldo Contable", () => {
  const r = SP.parseStatement(falabella());
  assert.equal(r.kind, "falabella");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.bank, "Banco Falabella");
  assert.equal(r.account.last4, "9012");
  assert.equal(r.account.label, "Cuenta Ahorro Banco Falabella Soles");
  assert.deepEqual(r.period, { start: "2026-09-01", end: "2026-09-30" });
  assert.deepEqual(r.balances, { PEN: { opening: 1000, closing: 1101.5 } });
  assert.equal(r.holder, "MARIA EJEMPLO PEREZ");
});

test("Falabella savings lines: signed amounts as printed, the opening row is not a line", () => {
  const r = SP.parseStatement(falabella());
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.lines[0], { date: "2026-09-05", description: "PAGO TCR MISMO TITULAR CENTRO FINANCIERO UNO", amount: -100, currency: "PEN", section: "movement" });
  assert.equal(r.lines[1].amount, 250);
});

test("Falabella savings: a closing balance that does not add up is rejected; a dollar account is read as USD", () => {
  const bad = SP.parseStatement(falabella({ closing: "1,200.00" }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /1101\.50.*1200\.00/);
  const usd = SP.parseStatement(falabella({ product: "CUENTA AHORRO BANCO FALABELLA DÓLARES" }));
  assert.equal(usd.ok, true, JSON.stringify(usd.errors));
  assert.deepEqual(Object.keys(usd.balances), ["USD"]);
  assert.equal(usd.lines[0].currency, "USD");
});

test("the CMR card layout is not mistaken for the Falabella savings layout (and the other way round)", () => {
  assert.equal(SP.detectKind(falabella()), "falabella");
  assert.equal(SP.detectKind([row(at("Listado de movimientos", 1)), row(at("Total Facturado Mes Anterior CMR", 1))]), "cmr");
});
