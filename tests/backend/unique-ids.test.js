// Every id in the app's page is used once (testers 2.68.2: the change log's window took the repayment history's id, so
// "Repayment history" opened an empty "This entry's changes"). getElementById returns the first, silently.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

test("docs/index.html has no repeated id", () => {
  const html = fs.readFileSync(path.join(__dirname, "../../docs/index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} ×${n}`);
  assert.deepStrictEqual(twice, [], "repeated ids: " + twice.join(", "));
});
