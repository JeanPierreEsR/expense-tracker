// Dates reach the person in words, never as 2026-11-06 (docs/app.js). Clicked through in a real browser with the test app; this guards the wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");

test("a date passed straight to a text is a mistake", () => {
  const raw = app.match(/tr\("[^"]+", \{[^}]*\bdate: [a-zA-Z_]+\.[a-z_]*date\b[^}]*\}\)/g) || [];
  assert.deepEqual(raw, []);
});

test("the delete and discard questions show the date in words", () => {
  assert.match(app, /\[amountText, listDate_\(extra\)\]/);
});

test("the text about learning a category says twice, as the code does", () => {
  const strings = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "strings.js"), "utf8");
  const guess = fs.readFileSync(path.join(__dirname, "..", "..", "backend", "CategoryGuess.gs"), "utf8");
  assert.match(guess, /MERCHANT_MIN_ENTRIES = 2/);
  assert.match(strings, /"review\.learns": \{ en: "Confirm the same category twice/);
});

test("a date inside an alert from the server is shown in words", () => {
  assert.match(app, /String\(n\.text\)\.replace\(\/\\b\\d\{4\}-\\d\{2\}-\\d\{2\}\\b\/g, listDate_\)/);
});

test("Needs review: the practice waits for something waiting, and a long list shows 20 at a time", () => {
  assert.match(/function offerReviewTip_\(\) \{[\s\S]*?\n\}/.exec(app)[0], /if \(!reviewEntries_\.length\) return;/);
  const limit = /function applyReviewLimit_\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(limit, /reviewEditing_ \|\| Spotlight\.isRunning\(\)/);
  assert.match(app, /new MutationObserver\(applyReviewLimit_\)/);
});
