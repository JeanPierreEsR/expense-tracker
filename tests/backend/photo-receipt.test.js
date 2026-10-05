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

// Received Yape ("¡Te Yapearon!"): same lost-"S/" reading, plus an ad line below.
const YAPE_NO_PREFIX = [
  "¡Te Yapearon!", "", "18.00 a", "", "Ana Lo*", "05 Oct 2026 | 09:15 a.m.",
  "Código de operación: 00765432", "", "*$150 y gana con tu Yape", "Compartir"
].join("\n");

test("yape received: amount line with the S/ lost is read, ad line ignored", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPE_NO_PREFIX);
  assert.equal(r.kind, "yape_received");
  assert.equal(r.type, "income");
  assert.equal(r.amount, 18);
  assert.equal(r.counterparty, "Ana Lo*");
  assert.equal(r.externalId, "00765432");
});

test("yape received: normal 'S/ 18.00' reading still wins", () => {
  const { rt } = freshApp({ small: true });
  const r = parse(rt, YAPE_NO_PREFIX.replace("18.00 a", "S/ 18.00"));
  assert.equal(r.amount, 18);
});
