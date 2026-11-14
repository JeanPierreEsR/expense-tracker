// Small traps of the new-entry form and the first tour card (docs/app.js). Clicked through in a real browser with the test app; this guards the wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");

test("only an earlier date carries to the next entry", () => {
  assert.match(app, /recentEntryDate_ = isNewEntry && date && date < todayLocalISO\(\)/);
});

test("a transfer's automatic description alone is no draft", () => {
  assert.match(app, /if \(!amount && \(!description \|\| description === lastAutoDescription\.trim\(\)\)\) return null;/);
});

test("the next entry after a Programmed item starts clean", () => {
  assert.match(app, /entryFormLeftOpen_ = true;/);
  assert.match(app, /if \(entryFormLeftOpen_\) \{[\s\S]*?showCategoryPicker\(\);/);
});

test("cancelling never makes No account the default", () => {
  const reset = /function resetEntryFormFields_\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.ok(reset.includes("pickDefaultAccount_()") && !reset.includes('getElementById("payment_method").value = ""'));
  assert.match(app, /picked here once it is saved\.\s*pickDefaultAccount_\(\);/);
});

test("a refused save can be opened or thrown away, even if it no longer exists", () => {
  const banner = /getElementById\("save-failed-banner"\)\.addEventListener[\s\S]*?\n\}\);/.exec(app)[0];
  assert.ok(banner.includes("money.failedOpen") && banner.includes("entry.notInListFailed") && banner.includes("money.failedDiscard") && banner.includes("unqueueEntryEdit_"));
});

test("a friend added inside a split can be chosen in Paid by at once", () => {
  assert.match(/getElementById\("split-add-friend-btn"\)\.addEventListener[\s\S]*?\n\}\);/.exec(app)[0], /populatePaidByOptions\(\)/);
});

test("the first tour card nudges with no limit, without waiting for the animation's last step, and the hint moves too", () => {
  // first nudge once the card has been read and its animation watched once (measured, owner 2026-11-14), not a fixed wait
  assert.match(app, /tourNudgeLater_\(read \+ anim\)/);
  assert.match(app, /TourScenes\.length\(/);
  assert.match(app, /tourNudge_\(\);\s*tourNudgeLater_\(8000\);/);
  assert.match(/function tourNudge_\(\) \{[\s\S]*?\n\}/.exec(app)[0], /welcomeEl_\("tour-hint"\)/);
});

test("a tour animation restarting never makes its card shorter (the page would jump back up; owner, 2026-11-14)", () => {
  const scenes = fs.readFileSync(path.join(__dirname, "../../docs/tour-scenes.js"), "utf8");
  assert.match(scenes, /function holdHeight\(stage, key\)/);
  assert.match(/function play\(key, stage, ctx\) \{[\s\S]*?\n  \}/.exec(scenes)[0], /holdHeight\(stage, key\);/);
});
