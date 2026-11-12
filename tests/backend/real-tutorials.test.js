// Real tutorials (owner's plan, 2026-11-09): the person does the real thing and it is kept. Reads the app's source; the walkthroughs
// themselves were driven end to end on the test server (first item, Exit, someone who already uses it, an older phone, a new type, transfers).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const section = (from, to) => app.slice(app.indexOf(from), app.indexOf(to));
const stringsText = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");

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

test("Needs review uses an unusual item only when nothing else is waiting, and never a row hidden behind Show more", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /const entry = entries\[0\] \|\| specials\[0\]/);
  assert.match(fn, /reviewRowShowing_\(e\.id\)/);
  const showing = section("function reviewRowShowing_(", "function startReviewReal_()");
  assert.match(showing, /r\.hidden/, "a row behind Show more");
  assert.match(showing, /!reviewOpen_ \|\| r\.getClientRects\(\)\.length > 0/, "the closed row can be opened; an open one must really show");
});

test("the debt guides end on what really happened", () => {
  const fn = section("function startConvDebt_(", "function startConvExchange_(");
  assert.match(fn, /convDebtOutcome_ === "refused" \? "rt\.conv\.refused"/);
  assert.match(fn, /convDebtOutcome_ === "over" \? "rt\.conv\.repayOver"/);
  assert.match(app, /if \(!convDebtOutcome_\) convDebtOutcome_ = "refused"/);
});

test("a window opened during these guides goes above the dim", () => {
  assert.match(section("function convRun_(", "function startConvDebt_("), /guided_ = \{ savedId: "", split: null \}/);
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
  assert.match(watch, /if \(!tip\.help && !tip\.own && !tip\.cont\) \{/);
  assert.match(watch, /popDaysUsed_\(\) < \(POP_LEVEL_DAYS_\[tip\.level \|\| "super"\]/);
  assert.match(watch, /!popGet_\(POP_AGAIN_KEY_, false\) && \(popGet_\(POP_VISITS_KEY_/);
  assert.match(app, /if \(!tip\.help && !tip\.own && !tip\.cont && !popDayAllows_\(tip\.key\)\)/);
  assert.match(section("function watchReviewHint_(", "// ---- First-use practice: Needs review ----"), /help: true/);
});

test("bubble rules (owner, 2026-11-11): waits by level, kind A on the first visit, series that continue; batch A", () => {
  assert.match(app, /const POP_LEVEL_DAYS_ = \{ basic: 0, medium: 7, advanced: 14, super: POP_SUPER_DAYS_ \}/);
  assert.match(app, /POP_SUPER_DAYS_ = 30/);
  // a series: Got it shows the next part, progress is kept, Practice tips starts every series again
  assert.match(app, /tip\.steps && tip\.at \+ 1 < tip\.steps\.length\) popTipWatch_\(Object\.assign\(\{\}, tip, \{ at: tip\.at \+ 1, cont: true \}\)\)/);
  assert.match(section('document.getElementById("tour-choice-tips")', "realTutorialsReset_();"), /popSet_\(POP_SERIES_KEY_, \{\}\)/);
  const a = section("// ---- Bubbles, batch A", "// The loan form (a new loan)");
  assert.match(a, /key: "ovTotals", place: "overview", level: "basic"/);
  assert.match(a, /key: "homeEdit", place: "home", level: "medium"/);
  assert.match(a, /lastRenderedEntries_ \|\| \[\]\)\.length < 10/);
  assert.match(a, /key: "profile", place: "myProfile", own: true/);
  assert.match(a, /key: "theseDays", place: "myProfile", own: true/);
  assert.match(a, /key: "pace", place: "paceScreen", own: true/);
  // These days… only from My profile's What fits me (never the welcome); the pace bubbles only on its own screen
  assert.match(app, /if \(opening\) watchTheseDaysTip_\(\)/);
  assert.match(section("async function renderPaceScreen_()", "function fillPaceControls_("), /watchPaceTip_\(\)/);
  for (const k of ["pop.ov.flows", "pop.ov.invLoans", "pop.ov.pendingHere", "pop.ov.pending", "pop.homeEdit", "pop.prof.names", "pop.prof.fits", "pop.prof.dates", "pop.prof.devices", "pop.theseDays.change", "pop.theseDays.choose", "pop.pace.blue", "pop.pace.grey", "pop.pace.cats", "pop.pace.kept"]) {
    assert.match(stringsText, new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: "[^"]+", es: "[^"]+" \\}'), k);
  }
});

test("Change type: picking Income, Investment or Transfer offers its own guide, and the form is left as it was on Exit", () => {
  const fn = section("const CONV_TYPES_ =", '// When the app already suspects it');
  for (const k of ["rt.conv.typeIncome", "rt.conv.typeInvestment", "rt.conv.typeTransfer", "rt.conv.incomeDone", "rt.conv.investDone"]) assert.ok(fn.includes(k), k);
  assert.match(fn, /offerConvGuide_\("conv-type-" \+ type/);
  assert.match(fn, /ok: \(\) => submitted \|\| !!el\("to_payment_method"\)\.value/, "a save empties the form: it must not send the guide back");
  assert.ok(!/callApi\(|deleteEntry|removePractice/.test(fn));
});

test("an item that leaves partway ends the guide cleanly instead of waiting for it", () => {
  const fn = section("function startReviewReal_()", "function startReviewTopUp_(");
  assert.match(fn, /const whileRow = /);
  assert.match(fn, /realSteps_\(steps\.map\(whileRow\)\)/);
});

test("the conversion guides stop to check what the bank filled in before saving", () => {
  assert.match(section("function startConvDebt_(", "function startConvExchange_("), /tr\(arrived \? "rt\.conv\.checkIn" : "rt\.conv\.checkOut"\)/);
  assert.match(section("function startConvExchange_(", "// Change type opens the full form"), /tr\("rt\.review\.check"\)/);
  assert.match(section("function startSplitReal_(", "// When the app already suspects it"), /if \(confirmingPendingId\) steps\.push\(\{ target: [^\n]*rt\.review\.check/);
});

test("a dedicated + starts with Start / Exit; saving without the guide ends the offer", () => {
  const fn = section("function startFormGuide_(", "const realShown_ =");
  assert.match(fn, /key: "intro", text: \(\) => tr\(introKey\), button: \(\) => tr\("spot\.g\.start"\)/);
  assert.match(fn, /if \(!started\) spendRealChance_\(feature\)/);
  assert.match(app, /if \(REAL_SAVE_\[b\.id\]\)/);
});

test("a refused Save lights up the whole form, so nothing the person must fix is dimmed", () => {
  assert.match(section("function realSaveTarget_(", "function realSaveSteps_("), /closest\("\.currency-modal"\)/);
});

test("windows opened during a real tutorial sit above its dim, the calendar included", () => {
  assert.match(section("function openDateRangePicker_(", "function attachDateRange_("), /guidedLift_\(dom\.backdrop\)/);
});

test("where a real tutorial exists the practice waits for the two-week nudge on Home, or for Practice tips", () => {
  assert.match(app, /function realHoldsPractice_\(key\) \{ return popGet_\(TAUGHT_KEY_, \{\}\)\[key\] === "real" \|\| \(REAL_FIRST_\.includes\(key\) && !realAgain_\(\) && nudgeKey_ !== key\); \}/);
  assert.match(app, /const NUDGE_DAYS_ = 14, NUDGE_EVERY_ = 3/);
  assert.match(section("function offerTip_(", "// ---- Pop-up tips"), /if \(realHoldsPractice_\(key\)\) return;/);
});

test("the closed Needs review row: the first tutorial opens it, the small extras wait for the person to open it", () => {
  assert.match(section("function startReviewTopUp_(", "const TRANSFER_FEATURE_"), /!reviewOpen_\) return;/);
  assert.match(app, /setReviewOpen_\(!reviewOpen_\); if \(reviewOpen_\) offerReviewTip_\(\);/);
});

test("typing steps hand the screen to the keyboard, in the home-screen app as much as in Safari", () => {
  for (const id of ["budget-name", "recurring-description", "trip-budget", "pm-last4"]) assert.match(app, new RegExp(`target: "#${id}", text: \\(\\) => tr\\("[a-z.A-Z0-9]+"\\), blurTap: true`), id);
});

test("a tutorial ends on what it just saved, and says so while it is saving", () => {
  const fn = section("function realWhereSteps_(", "const realEntryRow_ =");
  assert.match(fn, /look: true, target: find/);
  assert.match(fn, /waitText: \(\) => tr\("rt\.saving"\)/);
  assert.match(fn, /before: async \(\) => !shown/, "if it never appears, the same words, centred");
});

test("Split a bill starts with the photo, cannot go on while it does not add up, and saves the expense", () => {
  const fn = section("function billGuideSteps_(", 'document.addEventListener("click", (e) => {\n  if (!e.target.closest) return;\n  const b = e.target.closest("#add-budget-btn');
  assert.match(fn, /key: "photo"/);
  assert.match(fn, /ok: \(\) => ctx\.saving\(\) \|\| !applyOff\(\)/);
  assert.match(fn, /until: \(\) => billApplied && !ctx\.open\(\)/);
  assert.match(fn, /key: "entrySave"/);
});

test("the focus window stops at the sheet's edges", () => {
  const engine = fs.readFileSync(path.join(__dirname, "../../docs/spotlight.js"), "utf8");
  assert.match(engine, /e\.closest\("\.currency-modal"\)/);
});

test("Needs review's tutorial waits for the person to open the closed row", () => {
  const fn = /function offerReviewTip_\(\) \{[\s\S]*?\n\}/.exec(app)[0];
  assert.match(fn, /if \(!reviewOpen_\) return;/);
  assert.ok(fn.indexOf("!reviewOpen_") < fn.indexOf("startReviewReal_"));
});

test("step 5: bank loan, statements and import tutorials, the idle offer, Export without a card", () => {
  assert.match(app, /startFormGuide_\("loans-bank", bankLoanHeld_, "bank-loan-modal-backdrop", "bank-save", "rt\.bank\.intro", bankGuideSteps_\)/);
  assert.match(app, /const IDLE_SECONDS_ = 20/);
  assert.match(app, /function idleTick_[\s\S]*?document\.hidden \|\| idleChooser_ \|\| perfInflight_ > 0/);
  const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");
  const strs = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");
  assert.match(stm, /realStmtFileChosen_\(\);\n    const body = card\.querySelector\("\.stmt-result-body"\)/);
  for (const k of [...(app + stm).matchAll(/"(rt\.(?:bank|stmt|imp|idle)\.[A-Za-z]+)"/g)].map((m) => m[1])) assert.match(strs, new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: ".+", es: ".+" \\}'), k);
});

test("step 5b: no tutorial says Saved for a refused save or a window closed without saving; Tidy follows an upload", () => {
  const where = section("function realWhereSteps_(", "function realNoteFailed_(");
  assert.match(where, /giveUp: \(\) => realSaveFailed_\(\) \|\| unsaved\(\)/);
  assert.match(where, /realSaveFailed_\(\) \? tr\("rt\.notSaved"\) : unsaved\(\) \? tr\("rt\.closedNoSave"\)/);
  assert.match(section("function saveBehindScreen_(", "function afterNewEntrySaved_("), /realNoteFailed_\(\);/);
  assert.match(fs.readFileSync(path.join(__dirname, "../../docs/spotlight.js"), "utf8"), /if \(step\.giveUp && step\.giveUp\(\)\) return "gaveUp";/);
  const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");
  assert.ok(!stm.includes('getElementById("more-tidy-btn")'), "the Tidy button after an upload must open Tidy (more-tidy-btn no longer exists)");
  assert.match(stm, /markTidyFromUpload_\(\); showTidyScreen\(\);/);
  assert.match(app, /offerTidyReal_\(\);/);
  const strs = fs.readFileSync(path.join(__dirname, "../../docs/strings.js"), "utf8");
  for (const k of [...(app + stm).matchAll(/"(rt\.(?:tidy|form|entry|notSaved|closedNoSave)[A-Za-z.]*)"/g)].map((m) => m[1])) assert.match(strs, new RegExp('"' + k.replace(/\./g, "\\.") + '": \\{ en: ".+", es: ".+" \\}'), k);
});
