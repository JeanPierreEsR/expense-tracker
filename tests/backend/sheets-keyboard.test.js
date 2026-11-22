// With the iPhone keyboard open, the strip under a lifted sheet must be solid: the bar above the keyboard is see-through.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("the strip under a sheet lifted above the keyboard is painted like the sheet", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "style.css"), "utf8");
  const rule = css.split("\n").find((l) => l.startsWith("html.kb-open .currency-modal-backdrop {"));
  assert.ok(rule, "the keyboard rule for sheets is gone");
  assert.match(rule, /padding-bottom: calc\(var\(--kb-gap, 0px\) - var\(--kb-peek\)\)/);
  assert.match(rule, /background-image: linear-gradient\(to top, var\(--card\)/);
});
