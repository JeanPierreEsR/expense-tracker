// The guided practice of the first new entry (owner's design, 2026-11-04) and the app's own "ask for a name" window. Reads the app's
// source; the walkthrough itself was driven end to end on the test server for all four entry types.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "../../docs", f), "utf8");
const app = read("app.js");
const html = read("index.html");

// (Every tr() key existing in both languages is checked for the whole app by i18n.test.js.)
test("the guided practice has its own texts", () => {
  const keys = new Set(app.match(/tr\("spot\.g\.[a-zA-Z0-9]+"/g) || []);
  assert.ok(keys.size >= 25);
});

test("it starts by itself only on a new person's first +, never on the owner's copy, during another practice or Mark as paid", () => {
  const fn = app.slice(app.indexOf("function guidedEntryWanted_()"), app.indexOf("function guidedSplit_()"));
  assert.match(fn, /perfIsOwnerCopy_\(\)/);
  assert.match(fn, /Spotlight\.isRunning\(\)/);
  assert.match(fn, /tipSeen_\(GUIDED_ENTRY_KEY_\)/);
  assert.match(fn, /lastRenderedEntries_/, "people who already have entries are not interrupted");
  assert.match(app, /if \(!payingRecurringId_ && guidedEntryWanted_\(\)\) setTimeout\(startGuidedEntry_/);
});

test("what the guided practice saves is kept: its finish removes nothing", () => {
  const fn = app.slice(app.indexOf("function startGuidedEntry_()"), app.indexOf("function guidedEntrySteps_()"));
  assert.ok(!/callApi\(|deleteEntry|practiceRemove_|removePractice/.test(fn));
});

test("the Loans tip after a guided split only looks: it records and deletes nothing", () => {
  const fn = app.slice(app.indexOf("function startGuidedLoansLook_()"), app.indexOf("// ---- First-use practice: Needs review ----"));
  assert.ok(!/callApi\(|delete|record-repayment-btn", text: \(\) => tr\("spot\.p\.s13"\), tap/.test(fn.replace(/localStorage\.removeItem/g, "")));
  assert.match(fn, /look: true, target: "#record-repayment-btn"/);
});

test("names are asked in the app's own window, never the phone's prompt box", () => {
  const prompts = app.match(/[^.\w]prompt\(/g) || [];
  assert.equal(prompts.length, 0, "no plain prompt() left (window.prompt only remains as a copy fallback for a link)");
  assert.match(html, /id="name-ask-backdrop"/);
  assert.match(app, /backdrop\.style\.zIndex = 100002/);
});

// 1.76.1 (testers round before the promote): a tutorial cut off by closing the app is offered again; it counts once finished or exited.
test("a tutorial counts as seen only once it is finished or exited, never on Start", () => {
  assert.ok(!/key: "intro", text: \(\) => tr\("spot\.g\.intro"\)[^\n]*after: guidedAnswered_/.test(app), "the first-entry Start does not mark it seen");
  const mark = app.slice(app.indexOf("function markTaught_("), app.indexOf("function realAgain_()"));
  assert.match(mark, /if \(how === "real"\) \{ taughtPending_\[feature\] = how; return; \}/);
  assert.match(mark, /ctx\.onFinish = \(how\) => \{ keepTaughtPending_\(\);/, "every walkthrough's end keeps what it taught");
});

test("a file picked while Bank statements still says Loading… waits for it instead of being dropped", () => {
  const st = read("statements.js");
  assert.match(st, /screenLoaded = Promise\.allSettled\(loaded\);/);
  const fn = st.slice(st.indexOf("async function handleStatementFiles(files)"), st.indexOf("// ---- review (read-only) ----"));
  assert.ok(fn.indexOf("const picked = Array.from(files);") < fn.indexOf("await"), "the picked files are copied before any wait (the box is emptied right after the pick)");
  assert.match(fn, /for \(const f of picked\)/);
});

test("the step counter never jumps, and a real tutorial says 'this is real' on every step, in green (owner, 2026-11-12)", () => {
  const sp = read("spotlight.js");
  assert.match(sp, /function stepNumber\(i\) \{ return Math\.max\(1, seen\.filter/);
  assert.match(sp, /\$\("\.spot-note"\)\.setAttribute\("data-mode", L\.mode \|\| ""\)/);
  assert.match(app, /function realLabels_\(\) \{ return \{ note: tr\("spot\.g\.note"\), noteOnce: false, mode: "real",/);
});
