// CMR Falabella credit-card reader (docs/statement-parsers.js). Every row below is made up; it only mimics the layout the reader expects.
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

const at = (str, x0) => ({ str, x0, x1: x0 + str.length * 5 });
const row = (...cells) => ({ text: cells.map((c) => c.str).join(" "), cells });

function cmr({ totalDue = "S/ 100.00", prev = "100.00", card = "CMR VISA SIGNATURE", holder = "LOPEZ QUISPE ANA" } = {}) {
  return [
    row(at("statement-file|99999999|999999999999.pdf", 1)),
    row(at(holder, 489)),
    row(at("Estado de Cuenta", 100)),
    row(at(card, 100), at("LIMA/15001", 600)),
    row(at("Nº de Tarjeta", 30), at("4557-88**-****-1234", 200)),
    row(at("Periodo de facturación", 300), at("27/09 al 26/10", 460)),
    row(at("Último día de pago", 300), at("14/11/2026", 500)),
    row(at("Pago mínimo del mes", 300), at("S/ 20.00", 500)),
    row(at("Pago total del mes", 300), at(totalDue, 500)),
    row(at("Listado de movimientos", 30)),
    row(at("FECHA DE", 30), at("DETALLE TRANSACCIÓN", 140), at("MONTO", 300), at("TOTAL", 600)),
    row(at("-", 30), at("Total Facturado Mes Anterior", 140), at("-", 330), at(prev, 590)),
    row(at("Ana Lo* Tc: 455788******1234", 140)),
    row(at("02/10/2026", 30), at("03/10/2026", 90), at("Compra Tienda Uno.com", 140), at("Peru", 280), at("50.00", 605)),
    row(at("05/10/2026", 30), at("06/10/2026", 90), at("Devolucion Total Tienda Uno.com", 140), at("Peru", 280), at("-20.00", 600)),
    row(at("Establecimiento", 140)),
    row(at("08/10/2026", 30), at("09/10/2026", 90), at("Compra Bodega Dos", 140), at("Peru", 280), at("9.60", 610)),
    row(at("10/10/2026", 30), at("10/10/2026", 90), at("Compra Muebles", 140), at("Peru", 280), at("300.00", 220), at("1/6", 400), at("49.90", 520), at("10.00", 560), at("59.90", 605)),
    row(at("12/10/2026", 30), at("12/10/2026", 90), at("Pago Mobile", 140), at("Peru", 280), at("-100.00", 590)),
    row(at("12/10/2026", 30), at("12/10/2026", 90), at("Itf", 140), at("Peru", 280), at("0.50", 610)),
    row(at("Página 1 de 3", 590)),
    row(at("Ahorro Simple Soles", 30), at("S/ 9,999.99", 400), at("Disponible", 500))
  ];
}

test("CMR card is recognised, named and verified; the right-most amount of a row is its total", () => {
  const r = SP.parseStatement(cmr());
  assert.equal(r.kind, "cmr");
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.bank, "CMR Falabella");
  assert.equal(r.account.last4, "1234");
  assert.equal(r.account.label, "CMR Visa Signature");
  assert.deepEqual(r.period, { start: "2026-09-27", end: "2026-10-26" });
  assert.deepEqual(r.balances, { PEN: { opening: -100, closing: -100 } });
  assert.equal(r.lines.length, 6, "the card-holder row, the label row and the promo row at the bottom are not movements");
});

test("CMR lines: sign, transaction date, installments, refunds, payments and fees", () => {
  const r = SP.parseStatement(cmr());
  const by = (d) => r.lines.find((l) => l.description.startsWith(d));
  assert.deepEqual(by("Compra Tienda"), { date: "2026-10-02", description: "Compra Tienda Uno.com", amount: -50, currency: "PEN", section: "purchases" });
  assert.equal(by("Devolucion").amount, 20);
  assert.equal(by("Devolucion").section, "refunds");
  assert.equal(by("Pago Mobile").amount, 100);
  assert.equal(by("Pago Mobile").section, "payments");
  assert.equal(by("Itf").section, "fees");
  assert.equal(by("Compra Muebles").amount, -59.9, "an installment counts its TOTAL column (capital + interest), not its price or the 1/6");
  assert.equal(by("Compra Muebles").description, "Compra Muebles");
});

test("CMR: a month with nothing owed before (dashes only) opens at zero", () => {
  const rows = cmr({ prev: "-", totalDue: "S/ 0.00" });
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.balances.PEN.opening, 0);
});

test("CMR: a total that does not add up is rejected", () => {
  const r = SP.parseStatement(cmr({ totalDue: "S/ 150.00" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /100\.00.*150\.00/);
});

test("CMR: the cycle's year comes from the payment day (a January payment day after a December close)", () => {
  const rows = cmr();
  rows[5] = row(at("Periodo de facturación", 300), at("27/11 al 26/12", 460));
  rows[6] = row(at("Último día de pago", 300), at("14/01/2027", 500));
  const r = SP.parseStatement(rows);
  assert.deepEqual(r.period, { start: "2026-11-27", end: "2026-12-26" });
});

test("CMR: other CMR card names are read the same way", () => {
  const r = SP.parseStatement(cmr({ card: "CMR MASTERCARD" }));
  assert.equal(r.account.label, "CMR Mastercard");
});

test("CMR without a readable card number is reported, not guessed", () => {
  const rows = cmr();
  rows[4] = row(at("Nº de Tarjeta", 30));
  assert.equal(SP.parseStatement(rows).ok, false);
});

test("the other readers are not confused by the CMR layout", () => {
  assert.equal(SP.detectKind([row(at("Estado de Cuenta de Ahorros", 10)), row(at("FECHA PROC", 10))]), "bcp");
});

test("CMR: the holder is the lone line above \"Estado de Cuenta\" (the file-name line and the card line are not names)", () => {
  assert.equal(SP.parseStatement(cmr()).holder, "LOPEZ QUISPE ANA");
  assert.equal(SP.parseStatement(cmr({ holder: "Ana Lo*" })).holder, "", "an unrecognised line is never guessed");
});
