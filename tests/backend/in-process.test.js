// Bank-app movements text -> the payments still "En proceso" (docs/in-process.js). Made-up lists only.
const test = require("node:test");
const assert = require("node:assert");
const { parseInProcess, mergeItems, mergeReads, sumsByCurrency } = require("../../docs/in-process.js");

// How the lines come out when the amount and the name share a line (the usual read).
const MERGED = [
  "Movimientos",
  "Todos En cuotas",
  "Tienda Uno -S/ 25.88 >",
  "Dom 01 Nov | 7:03pm En proceso",
  "Cafe Dos -S/ 264.00 >",
  "Sáb 31 Oct | 3:59pm En proceso",
  "Pag*Taxi -S/ 14.40 >",
  "Sáb 31 Oct | 8:45am En proceso",
  "Pago Tarj Web App +S/ 173.99 >",
  "Dom 01 Nov | 8:22am",
  "Pago Tarj Web App +US$ 5.36 >",
  "Dom 01 Nov | 8:22am",
  "Grifo Tres -US$ 10.50 >",
  "Vie 30 Oct | 8:33am En proceso"
].join("\n");

test("only the rows marked En proceso are returned, with their amounts and currency", () => {
  const r = parseInProcess(MERGED);
  assert.deepStrictEqual(r.items.map((i) => [i.name, i.amount, i.currency]), [
    ["Tienda Uno", -25.88, "PEN"], ["Cafe Dos", -264, "PEN"], ["Pag*Taxi", -14.4, "PEN"], ["Grifo Tres", -10.5, "USD"]
  ]);
  assert.strictEqual(r.posted, 2);
  assert.strictEqual(r.items[0].when, "01 Nov 7:03pm");
});

test("a read that splits the columns (amount and status on their own lines) gives the same answer", () => {
  const split = ["Tienda Uno", "-S/ 25.88", "Dom 01 Nov | 7:03pm", "En proceso", "Cafe Dos", "-S/ 264.00", "Sáb 31 Oct | 3:59pm", "En proceso", "Pago Tarj Web App", "+S/ 173.99", "Dom 01 Nov | 8:22am"].join("\n");
  const r = parseInProcess(split);
  assert.deepStrictEqual(r.items.map((i) => [i.name, i.amount]), [["Tienda Uno", -25.88], ["Cafe Dos", -264]]);
  assert.strictEqual(r.posted, 1);
});

test("OCR slips in the currency mark and a thousands comma are tolerated", () => {
  const r = parseInProcess("Tienda Cuatro -5/ 1,245.60 >\nLun 02 Nov | 9:00am En proceso\nTienda Cinco -USS 3.10 >\nLun 02 Nov | 9:05am En proceso");
  assert.deepStrictEqual(r.items.map((i) => [i.amount, i.currency]), [[-1245.6, "PEN"], [-3.1, "USD"]]);
});

test("nothing marked, or no amounts at all, gives an empty list", () => {
  assert.deepStrictEqual(parseInProcess("Tienda Uno -S/ 25.88\nDom 01 Nov | 7:03pm").items, []);
  assert.deepStrictEqual(parseInProcess("Movimientos\nTodos").items, []);
  assert.deepStrictEqual(parseInProcess("").items, []);
});

test("a read that drops a row is completed by another read of the same screenshot, without doubling the rest", () => {
  const big = parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:03pm En proceso\nCafe Dos -S/ 5.00 >\nSáb 31 Oct | 6:00pm En proceso").items;
  const small = parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:O3pm En proceso\nCafe Dos -S/ 5.00 >\nSáb 31 Oct | 6:00pm En proceso\nGrifo Tres -S/ 12.29 >\nJue 29 Oct | 7:09pm En proceso").items;
  assert.strictEqual(mergeReads([big, small]).length, 3);
  assert.deepStrictEqual(sumsByCurrency(mergeReads([big, small])), { PEN: -2729 });
});

test("En proceso is recognised through common OCR slips", () => {
  ["Fn proceso", "En praceso", "En proceso", "EN PROCESO"].forEach((status) => {
    assert.strictEqual(parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:03pm " + status).items.length, 1, status);
  });
  assert.strictEqual(parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:03pm").items.length, 0);
});

test("a misread time does not split one payment in two; two identical rows in one screenshot stay two", () => {
  const a = parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:03pm En proceso\nTienda Uno -S/ 10.00 >\nDom 01 Nov | 7:09pm En proceso").items;
  const b = parseInProcess("Tienda Uno -S/ 10.00 >\nDom 01 Nov | 7:O3pm En proceso").items;
  assert.strictEqual(mergeItems([a, b]).length, 2);
});

test("the same payment in two overlapping screenshots counts once; sums are exact per currency", () => {
  const a = parseInProcess(MERGED).items;
  const b = parseInProcess("Pag*Taxi -S/ 14.40 >\nSáb 31 Oct | 8:45am En proceso\nOtra Tienda -S/ 0.10 >\nVie 30 Oct | 7:00am En proceso").items;
  const all = mergeItems([a, b]);
  assert.strictEqual(all.length, 5);
  assert.deepStrictEqual(sumsByCurrency(all), { PEN: -(2588 + 26400 + 1440 + 10), USD: -1050 });
});
