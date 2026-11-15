// Every sheet opens at its top (owner, 2026-11-14): one rule for all of them, in the observer that already watches every sheet open.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("a sheet that was left scrolled opens again at its top", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  assert.match(app, /if \(c\.oldValue !== null\) sheetBackToTop_\(b\);/);
  assert.match(app, /attributeFilter: \["hidden"\], attributeOldValue: true/);
  assert.match(app, /function sheetBackToTop_\(backdrop\)/);
});
