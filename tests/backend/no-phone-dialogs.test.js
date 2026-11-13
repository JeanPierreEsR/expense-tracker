// The app asks in its own window (askConfirmApp_), never with the phone's yes/no dialog: that one speaks the phone's language, not the
// app's, its buttons cannot say what happens, and a practice cannot work with it (owner, 2026-11-08).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("no screen uses the phone's own yes/no dialog", () => {
  const docs = path.join(__dirname, "..", "..", "docs");
  for (const f of fs.readdirSync(docs).filter((n) => n.endsWith(".js"))) {
    fs.readFileSync(path.join(docs, f), "utf8").split("\n").forEach((line, i) => {
      assert.ok(!/(^|[^\w.$"'`-])(window\.)?confirm\(/.test(line), `${f}:${i + 1} uses confirm(): use askConfirmApp_`);
      // The same for messages (design review 2026-11-12): the app's own window, showAppMessage_.
      assert.ok(!/(^|[^\w.$"'`-])(window\.)?alert\(/.test(line), `${f}:${i + 1} uses alert(): use showAppMessage_`);
    });
  }
});
