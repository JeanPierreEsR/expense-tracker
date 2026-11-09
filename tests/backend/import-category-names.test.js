// Import data: a category that already holds entries keeps ITS name by default, an empty one takes the file's name; names that
// differ from a category in use are announced (owner, 2026-11-04, replacing "the file's name wins" of 2026-10-24). Reads the app's source; driven on the test
// server with a made-up Spendee file ("Food & Drink" into an existing "Restaurants").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");

test("default name: the app's when the category already holds entries, else the file's", () => {
  const fn = src.slice(src.indexOf("function defaultNameFor("), src.indexOf("async function loadCategories()"));
  assert.match(fn, /if \(info\.protected \|\| info\.entries > 0\) return info\.name;/);
  assert.match(fn, /\? info\.name : it\.name;/);
});

test("names that differ are listed above the categories, and a chosen rename asks before going on", () => {
  assert.match(src, /function nameConflicts\(\)/);
  assert.match(src, /tm-cat-conflict-box/);
  assert.match(src, /const renames = nameConflicts\(\)\.filter\(\(c\) => c\.renamed\);\s*if \(renames\.length && !practiceNoConfirm_\(true\) && !await askConfirmApp_\(tr\("table\.conflictConfirm"/);
});
