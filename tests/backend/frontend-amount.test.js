// The amount-field cleanup lives in the browser code (docs/app.js); pull that one
// function out and test it directly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const fnSrc = /function sanitizeAmountInputValue[\s\S]*?\n}\n/.exec(src)[0];
const sanitize = new Function(fnSrc + "; return sanitizeAmountInputValue;")();

test("amount cleanup", () => {
  const cases = { "1,234.50": "1234.50", "1.234,50": "1234.50", "12,5": "12.5", "12.5": "12.5", "1,234,567.8": "1234567.8", "1234": "1234", "abc12": "12" };
  Object.entries(cases).forEach(([input, expected]) => assert.equal(sanitize(input), expected, input));
});

// The check on Save lives beside it. Boxes are stand-ins with what it reads.
const checkSrc = /function amountProblem_[\s\S]*?\n}\n/.exec(src)[0];
const problem = new Function(fnSrc + checkSrc + "; return amountProblem_;")();
const box = (value, amountKind) => ({ value, dataset: amountKind ? { amountKind } : {} });

test("three digits after one separator are asked about, never guessed", () => {
  ["1,234", "1.234", "12,345", "999.999", "1234.567"].forEach((v) => assert.equal(problem(box(v)).kind, "ambiguous", v));
  ["12,50", "12.5", "1234", "1234.50", "1,234.50", "1.234,50", "0.125", "", "15"].forEach((v) => assert.equal(problem(box(v)), null, v));
});

test("a minus and stray dots are refused, not silently dropped", () => {
  assert.equal(sanitize("-5"), "-5");
  assert.equal(sanitize("12.5.3"), "12.5.3");
  assert.equal(problem(box("-5")).kind, "negative");
  assert.equal(problem(box("−5")).kind, "negative", "the long minus a phone can type");
  assert.equal(problem(box("12.5.3")).kind, "invalid");
  assert.equal(problem(box("1.2.3")).kind, "invalid");
});

test("a number that can only be thousands is read as thousands", () => {
  // Key by key the box holds 1.234.567 and 1.234.50 (the two forms a phone produces while typing).
  [["1.234.567", "1234567"], ["1.234.50", "1234.50"], ["1.234.567.5", "1234567.5"], ["1234.567.89", "1234567.89"]].forEach(([typed, value]) => {
    const p = problem(box(typed));
    assert.equal(p.kind, "grouped", typed);
    assert.equal(p.value, value, typed);
  });
});

test("rates and percentages keep their decimals; balances may be negative", () => {
  assert.equal(problem(box("3.755", "rate")), null);
  assert.equal(problem(box("-3", "rate")).kind, "negative", "a negative rate is refused");
  assert.equal(problem(box("1.2.3", "rate")).kind, "invalid");
  assert.equal(problem(box("-50", "signed")), null);
});

test("the exchange-rate and other non-money boxes are marked, and every save button family is guarded", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
  [["rate-value-input", "rate"], ["main-currency-rate", "rate"], ["bank-gen-rate", "rate"], ["bill-tip-value", "rate"], ["inproc-balance", "signed"]].forEach(([id, kind]) =>
    assert.match(html, new RegExp(`id="${id}" data-amount-kind="${kind}"`), id));
  assert.match(src, /b\.id === "submit-btn"/);
  assert.match(src, /review-confirm-btn/);
});
