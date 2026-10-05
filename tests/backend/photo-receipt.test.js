// Receipt-photo text reading: Tesseract (Mac Mini) output variants. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const parse = (rt, text) => rt.run("parsePhotoReceipt_(" + JSON.stringify(text) + ")");

// Tesseract dropped the big "S/" completely: the amount is a bare "12.50 u".
const PLIN_NO_PREFIX = [
  "Pl interbank", "", "¡Plineaste!", "", "Ana Lo* C", "", "... 0...", "",
  "334 - Yape", "", "12.50 u", "", "05 Oct 2026 | 10:30 AM", "",
  "Código de operación: 01234567", "", "Solo con Interbank paga a Plin"
].join("\n");

test("plin photo: amount line with the S/ lost ('12.50 u') is still read", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, PLIN_NO_PREFIX);
  assert.equal(r.amount, 12.5);
  assert.equal(r.currency, "PEN");
  assert.equal(r.externalId, "01234567");
});

test("plin photo: masked card line, date and code are never taken as the amount", () => {
  const { rt } = freshApp({ small: true });
  const text = PLIN_NO_PREFIX.replace("12.50 u", "");
  assert.equal(parse(rt, text).error, "amount");
});
