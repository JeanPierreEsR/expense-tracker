// Real tutorials (owner's plan, 2026-11-09): the person does the real thing and it is kept. Reads the app's source; the walkthroughs
// themselves were driven end to end on the test server (first item, Exit, someone who already uses it, an older phone, a new type, transfers).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));

test("the Needs review practice is hidden for good: nothing offers it", () => {
  assert.ok(!/offerTip_\("review"/.test(app));
});

test("the four paused bubbles stay switched off, the live ones do not", () => {
  const list = app.match(/const POP_PAUSED_ = \[([^\]]*)\]/)[1];
  for (const k of ["paidBy", "bankOpening", "forgive", "overpay"]) assert.ok(list.includes(`"${k}"`), k);
  for (const k of ["annual", "tripPick", "loanOpening"]) assert.ok(!list.includes(`"${k}"`), k);
});

test("a real tutorial never runs on the owner's copy, during a practice, or over an open form or sheet", () => {
  const fn = section("function realScreenFree_()", "// Needs review: on the first real item");
  for (const part of [/perfIsOwnerCopy_\(\)/, /Spotlight\.isRunning\(\)/, /editModeOn_\(\)/, /newEntrySheetOpen_/, /currency-modal-backdrop:not\(\[hidden\]\)/]) assert.match(fn, part);
});

test("only a practice done to the end counts as taught", () => {
  assert.match(app, /if \(how === "done" && tipRunningKey_\) markTaught_\(tipRunningKey_, "practice"\)/);
});

test("practice cards answered before this count as taught, once", () => {
  assert.match(app, /if \(popGet_\(TAUGHT_OLD_KEY_, null\) === null\) popSet_\(TAUGHT_OLD_KEY_, popGet_\("tipsSeen", \[\]\)\)/);
});

test("someone who already uses the feature is not interrupted, unless they asked through Practice tips", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /!realAgain_\(\) && \(lastRenderedEntries_ \|\| \[\]\)\.some\(\(e\) => e\.source === "email"/);
  assert.match(section("function offerTransferGuide_()", "function transferNoteSaved_()"), /!realAgain_\(\)/);
});

test("Needs review skips rows it cannot teach on and rows hidden behind Show more", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /!e\.link && !e\.charge_match/);
  assert.match(fn, /reviewRowShowing_\(e\.id\)/);
  assert.match(app, /function reviewRowShowing_\(id\) \{[^\n]*getClientRects\(\)\.length > 0/);
});

test("a look is not a use: the transfer tab only asks, with up to 3 chances", () => {
  const fn = section("function offerTransferGuide_()", "function transferNoteSaved_()");
  assert.match(fn, /popTipShow_\(\{ key: "offer-transfer", text: tr\("rt\.transfer\.offer"\), offer: startTransferReal_ \}/);
  assert.match(fn, /realChanceLeft_\("transfer"\)/);
  assert.ok(!/Spotlight\.run/.test(fn), "the offer itself starts nothing");
  assert.match(app, /const REAL_CHANCES_ = 3;/);
});

test("an offer does not use up the pop-up tips' seen list", () => {
  assert.match(app, /if \(!tip\.offer\) popSet_\(POP_SEEN_KEY_/);
});

test("Practice tips brings the real tutorials back too", () => {
  const fn = section('document.getElementById("tour-choice-tips")', "// ---- Guided practice: the first new entry");
  assert.match(fn, /realTutorialsReset_\(\)/);
});

test("what these tutorials save is kept: their finish removes nothing", () => {
  const fn = section("function startReviewReal_()", "// ---- First-use practice: Needs review ----");
  assert.ok(!/callApi\(|deleteEntry|practiceRemove_|removePractice/.test(fn));
});
