// Import data: one of the person's categories keeps ITS name by default; the file's name is only used when chosen, and names that
// differ are announced (owner, 2026-11-04, replacing "the file's name wins" of 2026-10-24). Reads the app's source; driven on the test
// server with a made-up Spendee file ("Food & Drink" into an existing "Restaurants").
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const src = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");

test("a matched category keeps the app's name by default", () => {
  const fn = src.slice(src.indexOf("function defaultNameFor("), src.indexOf("async function loadCategories()"));
  assert.match(fn, /return info\.name;\s*\}\s*$/);
  assert.ok(!/: it\.name;\s*\}\s*$/.test(fn), "no longer falls back to the file's name for an existing category");
});

test("names that differ are listed above the categories, and a chosen rename asks before going on", () => {
  assert.match(src, /function nameConflicts\(\)/);
  assert.match(src, /tm-cat-conflict-box/);
  assert.match(src, /const renames = nameConflicts\(\)\.filter\(\(c\) => c\.renamed\);\s*if \(renames\.length && !practiceNoConfirm_\(true\) && !confirm\(tr\("table\.conflictConfirm"/);
});
