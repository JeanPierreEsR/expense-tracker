// SIP's CTS statement ("Estado de Cuenta CTS", docs/statement-parsers.js, 2026-11-20; SIP's layout only). Every row below is made up;
// it only mimics the layout: a description wraps over two lines, its second half may come AFTER the amounts, and at a page break
// the first half of a description may sit at the bottom of the page before its "<n> <date>".
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

const row = (text) => ({ text, cells: [{ str: text, x0: 20, x1: 20 + text.length * 5 }] });

function ctsRows(moves, opts) {
  opts = opts || {};
  const head = [
    "Estado de Cuenta CTS", "01/02/2026", "DATOS DE LA CUENTA CTS", "Número de cuenta: 110000009876",
    "Moneda: Sol Fecha de Apertura: 4/11/2022", "TEA: 6.50 % Retención Judicial: No", "SALDO",
    "Saldo Total (S/) Saldo Intangible (S/) Saldo Disponible (S/)", (opts.total || "0.00") + " 0.00 " + (opts.total || "0.00"),
    "TITULARES", "1", "ANA PRUEBA", "DNI 00000000 Titular", "MOVIMIENTOS", "Nro.", "Fecha de", "movimiento", "Descripción Moneda Monto Saldo"
  ];
  return head.concat(moves).concat(opts.footer === false ? [] : ["Este correo electrónico fue enviado por: EMPRESA PRUEBA S.A."]).map(row);
}

// The usual case: the first half of the words, then the amounts, then the second half.
const MOVES = [
  "1 15/11/2024 Abono de capital", "Sol 1,000.00 1,000.00", "(Semestral)",
  "2 17/11/2024 Retiro por libre", "Sol -1,000.00 0.00", "disponibilidad",
  "3 30/11/2024 Capitalización de", "Sol 0.38 0.38", "intereses",
  "4 09/05/2025 Abono de capital", "Sol 2,500.10 2,500.48", "(Semestral)",
  "5 10/05/2025 Retiro por libre", "Sol -2,500.00 0.48", "disponibilidad",
  // a page break: the first half of movement 6's words is left at the bottom of the page
  "Capitalización de",
  "6 31/05/2025 intereses Sol 0.05 0.53"
];

test("recognised as SIP's CTS statement; the three kinds read with clean words, Salary on deposits, withdrawals marked as transfers", () => {
  const rows = ctsRows(MOVES, { total: "0.53" });
  assert.equal(SP.detectKind(rows), "sipcts");
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.verified, true);
  assert.equal(r.bank, "SIP");
  assert.equal(r.account.last4, "9876");
  assert.deepEqual(r.balances.PEN, { opening: 0, closing: 0.53 });
  assert.deepEqual(r.period, { start: "2024-11-15", end: "2026-02-01" });
  assert.deepEqual(r.lines.map((l) => [l.date, l.description, l.amount, l.category || "", !!l.transfer]), [
    ["2024-11-15", "Abono de capital (Semestral)", 1000, "Salary", false],
    ["2024-11-17", "Retiro por libre disponibilidad", -1000, "", true],
    ["2024-11-30", "Capitalización de intereses", 0.38, "", false],
    ["2025-05-09", "Abono de capital (Semestral)", 2500.1, "Salary", false],
    ["2025-05-10", "Retiro por libre disponibilidad", -2500, "", true],
    ["2025-05-31", "Capitalización de intereses", 0.05, "", false]
  ]);
  assert.equal(SP.STATEMENT_BANK_BY_KIND.sipcts, "SIP");
  assert.ok(!r.due, "not a card: no pay-by date");
});

test("a page break that carries the first words of a deposit onto the previous movement still reads as a deposit", () => {
  const moves = [
    "1 30/11/2024 Capitalización de", "Sol 0.38 0.38", "intereses", "Abono de capital",
    "2 13/05/2025 (Semestral) Sol 700.00 700.38"
  ];
  const r = SP.parseStatement(ctsRows(moves, { total: "700.38" }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.lines.map((l) => [l.description, l.category || ""]), [["Capitalización de intereses", ""], ["Abono de capital (Semestral)", "Salary"]]);
});

test("a running balance that does not add up, a missing movement, or a last balance unlike 'Saldo Total' is refused", () => {
  const bad = SP.parseStatement(ctsRows(["1 15/11/2024 Abono de capital", "Sol 1,000.00 1,000.00", "(Semestral)",
    "2 30/11/2024 Capitalización de", "Sol 0.38 1,000.50", "intereses"], { total: "1,000.50" }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /2/);
  const gap = SP.parseStatement(ctsRows(["1 15/11/2024 Abono de capital", "Sol 1,000.00 1,000.00", "(Semestral)",
    "3 30/11/2024 Capitalización de", "Sol 0.38 1,000.38", "intereses"], { total: "1,000.38" }));
  assert.equal(gap.ok, false);
  const total = SP.parseStatement(ctsRows(MOVES, { total: "9.99" }));
  assert.equal(total.ok, false);
});

test("movements from before the person's history starts are left out; the opening balance moves so it still adds up", () => {
  const r = SP.parseStatement(ctsRows(MOVES, { total: "0.53" }));
  const t = SP.trimSipCtsToHistory(r, "2025-01-01");
  assert.equal(t.skippedBeforeHistory, 3);
  assert.equal(t.historyStart, "2025-01-01");
  assert.deepEqual(t.lines.map((l) => l.date), ["2025-05-09", "2025-05-10", "2025-05-31"]);
  assert.deepEqual(t.balances.PEN, { opening: 0.38, closing: 0.53 });
  assert.equal(t.period.start, "2025-05-09");
  assert.equal(r.lines.length, 6, "the full reading is not changed");
  assert.equal(SP.trimSipCtsToHistory(r, ""), r, "no history start: nothing is left out");
  assert.equal(SP.trimSipCtsToHistory(r, "2020-01-01"), r, "nothing older: the same reading");
});

test("another bank's statement is never taken for SIP's CTS", () => {
  const rows = ["Estado de Cuenta de Ahorros", "FECHA PROC", "MOVIMIENTOS", "01/02 COMPRA 10.00"].map(row);
  assert.notEqual(SP.detectKind(rows), "sipcts");
});
