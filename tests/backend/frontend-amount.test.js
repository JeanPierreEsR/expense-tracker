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
