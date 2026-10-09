// Interbank Visa reader (docs/statement-parsers.js): a month where more was paid than owed.
// The bank then prints "PAGO DEL MES 0.00" while the subtotals add to a negative (a credit
// balance). Rows below are made up; they only mimic the layout the reader expects.
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

// Columns: S/ amounts end at x1=440, US$ amounts at x1=560; the header row puts the split at 500.
function row(...cells) {
  const cs = cells.map((c) => (typeof c === "string" ? { str: c, x0: 20, x1: 20 + c.length * 5 } : c));
  return { text: cs.map((c) => c.str).join(" "), cells: cs };
}
const pen = (v) => ({ str: v, x0: 400, x1: 440 });
const usd = (v) => ({ str: v, x0: 520, x1: 560 });

function statement({ monthlyUsd }) {
  return [
    row("INTERBANK VISA INFINITE 4772 89** **** 1234 - SOLES"),
    row("del 26/08/2026 al cierre de 25/09/2026"),
    row("DETALLE DE PAGO DEL MES"),
    row("TU ESTADO DE CUENTA ANTERIOR", { str: "S/", x0: 420, x1: 440 }, { str: "US$", x0: 560, x1: 580 }),
    row("Debías en el estado de cuenta anterior *", pen("100.00"), usd("50.00")),
    row("PAGOS REALIZADOS"),
    row("05-Sep", "PAGO", pen("-100.00"), usd("-72.29")),
    row("SUBTOTAL ----", pen("0.00"), usd("-22.29")),
    row("TUS CONSUMOS"),
    row("10-Sep", "SHOP", pen("30.00")),
    row("SUBTOTAL ----", pen("30.00"), usd("0.00")),
    row("OTROS COBROS"),
    row("SUBTOTAL ----", pen("0.00"), usd("0.00")),
    row("PAGO DEL MES (Suma de subtotales)", pen("30.00"), usd(monthlyUsd))
  ];
}

test("paid more than owed: PAGO DEL MES 0.00 with negative subtotals is accepted as a credit balance", () => {
  const r = SP.parseStatement(statement({ monthlyUsd: "0.00" }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.balances.USD.opening, -50);
  assert.equal(r.balances.USD.closing, 22.29, "the credit is carried as a positive balance");
  assert.equal(r.balances.PEN.closing, -30);
});

test("a genuinely wrong PAGO DEL MES is still rejected", () => {
  const r = SP.parseStatement(statement({ monthlyUsd: "5.00" }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /Sum of subtotals/);
});
