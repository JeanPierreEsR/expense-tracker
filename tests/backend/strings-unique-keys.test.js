// A text key written twice in docs/strings.js silently lets the later one win (JavaScript keeps the last): two practices once both used the
// prefix "spot.i." and would have overwritten each other's texts without any error. This fails the moment a key appears twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("no text key appears twice in docs/strings.js", () => {
  const text = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");
  const seen = new Map(), dupes = [];
  text.split("\n").forEach((line, i) => {
    const m = line.match(/^\s{4}"([A-Za-z0-9_.\-]+)":\s*\{/);
    if (!m) return;
    if (seen.has(m[1])) dupes.push(`${m[1]} (lines ${seen.get(m[1])} and ${i + 1})`);
    else seen.set(m[1], i + 1);
  });
  assert.deepEqual(dupes, []);
  assert.ok(seen.size > 1000, "the check really read the texts");
});
