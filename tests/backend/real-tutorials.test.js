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
  assert.match(section("function offerTransferGuide_(", "function transferNoteSaved_()"), /!realAgain_\(\)/);
});

test("Needs review skips rows it cannot teach on and rows hidden behind Show more", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /!e\.link && !e\.charge_match/);
  assert.match(fn, /reviewRowShowing_\(e\.id\)/);
  assert.match(app, /function reviewRowShowing_\(id\) \{[^\n]*getClientRects\(\)\.length > 0/);
});

test("a look is not a use: the Transfer tab only asks, with up to 3 chances, and points at the tab", () => {
  const fn = section("function offerTransferGuide_(", "function transferNoteSaved_()");
  assert.match(fn, /popTipShow_\(\{ key: "offer-transfer", text: tr\("rt\.transfer\.offer"\), offer: \(\) => startTransferReal_\(null\) \}, tab\)/);
  assert.match(fn, /realChanceLeft_\("transfer-start"\)/);
  assert.match(fn, /realChanceLeft_\(feature\)/);
  assert.ok(!/Spotlight\.run/.test(fn), "the offer itself starts nothing");
  assert.match(app, /const REAL_CHANCES_ = 3;/);
});

test("one transfer start, a path for each kind, and each check applies only to its own kind", () => {
  const fn = section("function startTransferReal_(", "// ---- First-use practice: Needs review ----");
  for (const k of ["rt.transfer.pick", "rt.transfer.kind", "rt.repay.direction", "rt.loan.direction", "rt.loan.due", "rt.repay.done", "rt.loan.done", "rt.exchange.done"]) assert.ok(fn.includes(k), k);
  assert.match(fn, /ok: \(\) => submitted \|\| !debt\(\) \|\| friendOk\(\)/, "a friend is only needed on a repayment or a loan");
  assert.match(fn, /ok: \(\) => submitted \|\| !is\("between", "repayment", "loan"\)\(\) \|\| amountOk\(\)/, "an exchange has its own amounts");
});

test("the amount is asked for even when already explained: Save needs it", () => {
  const fn = section("function startTransferReal_(", "// ---- First-use practice: Needs review ----");
  assert.ok(!/if \(isNew\("amount"\)\)/.test(fn));
});

test("the Needs review tutorial opens on the whole item it is talking about", () => {
  assert.match(section("function startReviewReal_()", "function startReviewTopUp_("), /key: "intro", look: true, target: row,/);
});

test("an item that came in wrong can be fixed or converted, not only discarded", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /target: part\("\.review-item-fields"\), text: \(\) => tr\("rt\.review\.check"\)/);
  assert.match(fn, /\.review-item-secondary-actions/);
  assert.match(app, /if \(reviewDecideOn_ && e\.target\.closest\("\.review-item-secondary-actions button"\)\) \{ reviewDecideOn_ = false; Spotlight\.stop\("done"\); \}/);
});

test("a conversion offer waits for a slow server, and only in its own window", () => {
  const fn = section("function offerConvGuide_(", "function convRun_(");
  assert.match(fn, /\+\+tries > 150/);
  assert.match(app, /open\("review-transfer-modal-backdrop"\)\(\) && reviewTransferMode === "loan"/);
});

test("the update window never opens over a running tutorial", () => {
  assert.match(section("function promptBackendUpdateOnce_(", "function openInSafari_("), /Spotlight\.isRunning\(\)/);
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

test("conversions: the button does its job, the offer appears inside the window it opened, once saved it ends", () => {
  const fn = section("function offerConvGuide_(", "function convRun_(");
  assert.match(fn, /realChanceLeft_\(feature\)/);
  assert.ok(!/Spotlight\.run/.test(fn), "the offer itself starts nothing");
  assert.match(app, /if \(back\.hidden\) markTaught_\(feature, "used"\)/);
});

test("conversions are not offered to people already using Needs review, nor on the owner's copy", () => {
  assert.match(app, /function convOffersOn_\(\) \{ return !!meta && !perfIsOwnerCopy_\(\) && \(realAgain_\(\) \|\| popGet_\(TAUGHT_KEY_, \{\}\)\.review === "real"\); \}/);
});

test("a help bubble skips the 3 visits, the month and the one-a-day limit; the others keep them", () => {
  const watch = section("function popTipWatch_(", "// The moment the field scrolls into view");
  assert.match(watch, /!tip\.help && tip\.level !== "advanced" && !popMonthPassed_\(\)/);
  assert.match(watch, /!tip\.help && !popGet_\(POP_AGAIN_KEY_, false\)/);
  assert.match(app, /if \(!tip\.help && !popDayAllows_\(tip\.key\)\)/);
  assert.match(section("function watchReviewHint_(", "// ---- First-use practice: Needs review ----"), /help: true/);
});
