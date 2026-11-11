// Diners-style movements list (owner's sample layout, 2026-11-11): amounts with NO currency mark, soles under a "S/" heading, dollars
// under a "$" heading, "En proceso" as a tag under the row. markColumns uses the word boxes to put the mark back. Made-up rows only;
// positions modelled on a 920-pixel-wide screenshot.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseInProcess, markColumns } = require("../../docs/in-process.js");

const w = (text, x0, x1) => ({ text, x0, x1 });
const line = (...words) => ({ words });
const HEAD = line(w("Fecha", 45, 128), w("Cargo", 160, 242), w("S/", 585, 615), w("$", 775, 790));

test("a soles purchase in process is read with S/, a dollar one with US$; posted rows are left out", () => {
  const lines = [
    line(w("SUS", 100, 160), w("MOVIMIENTOS", 170, 410)),
    HEAD,
    line(w("10", 37, 62), w("Nov", 70, 128), w("TIENDA", 148, 260), w("UNO", 270, 330), w("58.40", 615, 700)),
    line(w("En", 52, 90), w("proceso", 98, 205)),
    line(w("09", 37, 62), w("Nov", 70, 128), w("SEGURO", 157, 275), w("6.50", 820, 882)),
    line(w("08", 37, 62), w("Nov", 70, 128), w("APP", 148, 210), w("DOS", 220, 280), w("12.99", 800, 882)),
    line(w("En", 52, 90), w("proceso", 98, 205)),
    line(w("31", 37, 62), w("Oct", 70, 120), w("CAFE", 140, 220), w("1,250.00", 590, 700))
  ];
  const text = markColumns(lines);
  assert.ok(text, "the heading is found");
  const got = parseInProcess(text);
  assert.deepEqual(got.items.map((i) => [i.name, i.when, i.amount, i.currency]),
    [["TIENDA UNO", "10 Nov", -58.40, "PEN"], ["APP DOS", "08 Nov", -12.99, "USD"]]);
  assert.equal(got.posted, 2);
});

test("a screenshot with no S/ and $ heading is left to the usual reader", () => {
  assert.equal(markColumns([line(w("Tienda", 10, 80), w("-S/", 300, 330), w("25.88", 335, 400))]), null);
});

test("an amount that already has its mark is not marked twice", () => {
  const text = markColumns([HEAD, line(w("12", 37, 62), w("Nov", 70, 128), w("TIENDA", 148, 260), w("S/", 600, 620), w("20.00", 630, 700))]);
  assert.ok(!/S\/ S\//.test(text));
});

test("headings S/ and $ lost by the reader: the place on the screen decides, when the Fecha / Cargo heading is there", () => {
  const lines = [
    line(w("Fecha", 45, 128), w("Cargo", 160, 242)),
    line(w("10", 37, 62), w("Nov", 70, 128), w("TIENDA", 148, 260), w("58.40", 615, 700)),
    line(w("En", 52, 90), w("proceso", 98, 205)),
    line(w("08", 37, 62), w("Nov", 70, 128), w("APP", 148, 210), w("12.99", 800, 882)),
    line(w("En", 52, 90), w("proceso", 98, 205))
  ];
  assert.equal(markColumns(lines), null, "no width: nothing to go by");
  const got = parseInProcess(markColumns(lines, 920));
  assert.deepEqual(got.items.map((i) => [i.amount, i.currency]), [[-58.40, "PEN"], [-12.99, "USD"]]);
  assert.equal(markColumns([line(w("Tienda", 10, 80), w("25.88", 600, 700))], 920), null, "no table heading: left to the usual reader");
});
