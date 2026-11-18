// SIP credit card, the "scanned" layout (docs/statement-parsers.js): the headings with the bank's name are part of a picture,
// so the layout is recognised by its movement headings plus the "(C)" summary row that must add up. Every row below is
// made up; it only mimics the layout the reader expects.
const test = require("node:test");
const assert = require("node:assert/strict");
const SP = require("../../docs/statement-parsers.js");

function row(...cells) {
  let x = 20;
  const cs = cells.map((c) => {
    const cell = { str: c, x0: x, x1: x + c.length * 5 };
    x = cell.x1 + 10;
    return cell;
  });
  return { text: cs.map((c) => c.str).join(" "), cells: cs };
}

function scannedSip(opening, movements, summary) {
  return [
    row("Tarjeta ****1234"),
    row("Movimientos del 09/10/2026 al 08/11/2026"),
    row("DETALLE DE MOVIMIENTO DEL MES"),
    row("FECHA", "DESCRIPCION", "TIT/ADIC", "IMPORTE"),
    row("SALDO MES ANTERIOR", opening),
    ...movements.map((m) => row(m[0], m[1], "T", m[2])),
    row(...summary),
  ];
}

test("SIP scanned layout: a normal month (total debt owed) is recognised", () => {
  const rows = scannedSip("10.00", [["12/10/2026", "SHOP ONE", "40.00"], ["20/10/2026", "PAGO EN LINEA", "- 10.00"]],
    ["10.00", "40.00", "10.00", "40.00"]);
  assert.equal(SP.detectKind(rows), "sip");
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.balances.PEN.closing, -40);
});

test("SIP scanned layout: a month paid beyond what was owed ends in a credit printed '- 25.00' and is still recognised", () => {
  const rows = scannedSip("10.00", [["12/10/2026", "SHOP ONE", "15.00"], ["20/10/2026", "PAGO EN LINEA", "- 50.00"]],
    ["10.00", "15.00", "50.00", "- 25.00"]);
  assert.equal(SP.detectKind(rows), "sip");
  const r = SP.parseStatement(rows);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.lines.length, 2);
  assert.equal(r.balances.PEN.closing, 25); // a credit in the person's favour
});

test("SIP scanned layout: a summary row that does not add up is still not taken for SIP", () => {
  const rows = scannedSip("10.00", [["12/10/2026", "SHOP ONE", "15.00"]], ["10.00", "15.00", "50.00", "- 99.00"]);
  assert.equal(SP.detectKind(rows), null);
});
