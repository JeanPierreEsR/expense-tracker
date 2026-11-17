// "Is this you?" never offers a statement's own all-capitals heading as a person's name (journeys run, 2026-11-17: Valeria was
// offered "DETALLE DE PAGO DEL MES"). Made-up names only.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../docs/statement-parsers.js");
const rows = (a) => a.map((t) => ({ text: t, cells: [{ str: t }] }));

test("a heading above the holder's line is skipped; the name below it is found", () => {
  assert.equal(P.holderOf("visa", rows(["DETALLE DE PAGO DEL MES", "ROSA PRUEBA QUISPE"])), "ROSA PRUEBA QUISPE");
});
test("a name with DE / LA in it is still a name", () => {
  assert.equal(P.holderOf("visa", rows(["MARIA DE LA CRUZ PRUEBA"])), "MARIA DE LA CRUZ PRUEBA");
});
test("only headings: no name is offered at all", () => {
  assert.equal(P.holderOf("visa", rows(["ESTADO DE CUENTA", "RESUMEN DEL MES"])), "");
});
