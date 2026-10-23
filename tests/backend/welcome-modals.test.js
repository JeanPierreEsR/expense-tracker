// A pop-up opened while the welcome screens are up must appear ABOVE them. Incident 2026-10-23: two friends finished the welcome questions, the
// "bank e-mails" pop-up opened at z-index 251 BEHIND the welcome overlay (300), and they were left on a blank screen.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../../docs/style.css"), "utf8");

test("the app knows the welcome overlay's real z-index (kept in step with style.css)", () => {
  const fromCss = Number(/\.welcome-overlay \{[^}]*z-index:\s*(\d+)/.exec(css)[1]);
  const fromApp = Number(/const WELCOME_OVERLAY_Z_ = (\d+);/.exec(app)[1]);
  assert.equal(fromApp, fromCss);
});

test("every pop-up is brought to the front through a function that lifts it above the welcome overlay while that is open", () => {
  const fn = /function bringModalToFront_\(backdropEl\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.match(fn, /getElementById\("welcome-overlay"\)/);
  assert.match(fn, /topModalZIndex = WELCOME_OVERLAY_Z_ \+ 100/);
});

test("the pop-ups the welcome flow opens all go through that function", () => {
  for (const name of ["openBankMailModal_", "openBankSampleModal_", "openPerfShareModal_"]) {
    const body = new RegExp("function " + name + "\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}").exec(app)[1];
    assert.match(body, /bringModalToFront_\(/, name);
  }
});
