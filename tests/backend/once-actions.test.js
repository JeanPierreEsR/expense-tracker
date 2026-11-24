// Every save that creates something is protected against a repeat on BOTH sides (CLAUDE.md § Saving standard): the phone keeps one
// request id across its retries (ONCE_ACTIONS, docs/app.js) and the server answers a repeat from memory (ONCE_ACTIONS_, Api.gs).
// Testers 2.68.2 found seven actions protected on the server only: a "Try again" made a second sale stage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("the phone's and the server's lists of once-only actions are the same", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  const api = fs.readFileSync(path.join(__dirname, "../../backend/Api.gs"), "utf8");
  const phone = new Set([...app.match(/const ONCE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].replace(/\/\/.*$/gm, "").matchAll(/"(\w+)"/g)].map((m) => m[1]));
  const server = new Set([...api.match(/var ONCE_ACTIONS_ = \{([\s\S]*?)\n\};/)[1].replace(/\/\/.*$/gm, "").matchAll(/(\w+):\s*1/g)].map((m) => m[1]));
  assert.deepEqual([...server].filter((a) => !phone.has(a)).sort(), [], "protected on the server only");
  assert.deepEqual([...phone].filter((a) => !server.has(a)).sort(), [], "protected on the phone only");
});
