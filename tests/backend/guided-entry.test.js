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
