// Home's numbers after a change, saves with no connection, double taps (docs/app.js). Clicked through in a real browser with the test app, a lost
// connection included; this guards the wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const between = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));

test("deleting one entry, a plain Confirm and a new rate each ask for fresh numbers", () => {
  assert.match(between("async function confirmAndDiscardEntry_", 'document.getElementById("delete-entry-btn")'), /refreshHomeGlance_\(true\);\s*\/\/[^\n]*\n\s*return true;/);
  assert.match(between('confirmBtn.addEventListener("click"', 'discardBtn.addEventListener("click"'), /applyReviewAction_[\s\S]*refreshHomeGlance_\(true\)/);
  assert.match(between('callApi("setExchangeRate", usd ? { currency, month, per_usd: rate } : { currency, month, rate })', "catch (err)"), /refreshHomeGlance_\(true\)/);
});

test("a forced refresh during one on its way runs again when that one lands", () => {
  const fn = between("function refreshHomeGlance_(force)", 'document.addEventListener("visibilitychange"');
  assert.match(fn, /if \(homeGlanceBusy_\) \{ if \(force && apiWriteGen_ !== homeGlanceGen_\) homeGlanceAgain_ = true; return homeGlanceBusy_; \}/);
  assert.match(fn, /if \(homeGlanceAgain_\) \{ homeGlanceAgain_ = false; refreshHomeGlance_\(true\); \}/);
});

test("a lost connection keeps a save waiting; a refusal still fails; a practice still stops", () => {
  assert.match(between("async function flushEntryEdit_", "function flushAllQueuedEdits_"), /if \(saveMayWait_\(err\)\) \{\s*markQueuedEditStatus_\(id, "saving", null, true\);[\s\S]*?else \{\s*markQueuedEditStatus_\(id, "failed", err\.message\);/);
  assert.match(between("async function flushMoneyQueue_", "Tapping the banner"), /if \(saveMayWait_\(err\)\) \{ noteSaveWaiting_\(\); break; \}[^\n]*\s*setMoneyItemStatus_\(item\.id, "failed"/);
  assert.match(app, /function saveMayWait_\(err\) \{ return isUnreachable_\(err\) && !Spotlight\.isRunning\(\); \}/);
});

test("a save waiting for a connection can still be opened, changed or deleted", () => {
  assert.match(between("function blockedWhileSavingEdit_", "Overlays any queued"), /q\.status === "saving" && !q\.waitingNet/);
  assert.match(between("async function confirmAndDiscardEntry_", "A repayment's transfer entry"), /e\.status === "failed" \|\| e\.waitingNet/);
});

test("a tap that removes a row or closes a sheet holds real taps for a moment, not the app's own clicks", () => {
  assert.match(app, /if \(e\.isTrusted && Date\.now\(\) < tapHoldUntil_\)/);
  assert.match(between("function saveBehindScreen_", "(async () =>"), /holdTaps_\(\)/);
  assert.match(between('confirmBtn.addEventListener("click"', 'discardBtn.addEventListener("click"'), /holdTaps_\(\);\s*item\.remove\(\)/);
  assert.match(app, /holdTaps_\(\); dismissNotices_/);
});
