// Rules for every first-use practice (owner's English walk, 2026-11-05): two-sentence intros, no "Skip this step" beside a step's own
// button, Home's search cleared when a practice starts, at most two yellow cards a day, and the loan / bank-loan practices offered by one
// line on Loans instead of following the Loans card one after the other.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DOCS = path.join(__dirname, "../../docs");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");
const engine = fs.readFileSync(path.join(DOCS, "spotlight.js"), "utf8");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const STRINGS = require(path.join(DOCS, "strings.js"));

const PRACTICES = ["p", "b", "i", "t", "r", "l", "k", "a", "x", "y", "d", "f", "s"];

test("every practice intro is two short sentences: what you will do, then that everything is deleted", () => {
  for (const k of PRACTICES) {
    const t = STRINGS[`spot.${k}.intro`];
    assert.match(t.en, /^You will [^.]+\. Everything from the practice is deleted at the end\.$/, k + " en");
    assert.match(t.es, /^[^.]+\. Todo lo de la práctica se elimina al final\.$/, k + " es");
  }
  // the exceptions, as the owner approved them
  assert.match(STRINGS["spot.n.intro"].en, /^“Needs review” is where purchases from your bank emails wait\. Nothing counts in your totals until you confirm it\. When you finish, or tap Exit, everything is deleted\.$/);
  assert.match(STRINGS["spot.e.intro"].en, /Nothing is recorded in the app\.$/);
  for (const k of PRACTICES.concat(["n", "e"])) {
    const t = STRINGS[`spot.${k}.intro`];
    assert.ok(!/real buttons|botones (reales|de verdad)|never touched|nunca se tocan/.test(t.en + t.es), k + ": the old long wording is gone");
  }
});

test("'Skip this step' never shows on a step that has its own button", () => {
  const can = engine.slice(engine.indexOf("function canSkip()"), engine.indexOf("function canSkip()") + 200);
  assert.match(can, /if \(step\.button\) return false;/);
});

test("a practice starts with Home's search box empty", () => {
  const run = app.slice(app.indexOf("function runTip_("), app.indexOf("function runTip_(") + 120);
  assert.match(run, /clearHomeSearchForPractice_\(\);/);
});

test("at most two yellow cards a day, lifted for the day by More → Practice tips", () => {
  assert.match(app, /const TIP_CARDS_PER_DAY_ = 2;/);
  const offer = app.slice(app.indexOf("function offerTip_("), app.indexOf("function offerTip_(") + 400);
  assert.match(offer, /if \(!tipDayAllows_\(key\)\) return;/);
  const reset = app.slice(app.indexOf('getElementById("tour-choice-tips").addEventListener'), app.indexOf('getElementById("tour-choice-tips").addEventListener') + 300);
  assert.match(reset, /tipDayOpen_\(\);/);
});

test("Loans: the loan and bank-loan practices are offered by one line, not chained on the yellow card", () => {
  const offer = app.slice(app.indexOf("function offerLoansTip_()"), app.indexOf("function offerLoansMoreLine_()"));
  assert.ok(!/offerTip_\("loans-(standalone|bank)"/.test(offer), "no chained yellow card");
  assert.match(offer, /offerTip_\("loans", "loans-tip-invite", tr\("spot\.p\.invite"\), startPractice_, offerLoansMoreLine_\)/);
  assert.match(html, /id="loans-more-practice"/);
  for (const k of ["spot.lm.title", "spot.lm.loan", "spot.lm.bank", "spot.lm.hide"]) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
});

test("practice rows drawn after the cleanup started still say Deleting… (the Loans repayment too)", () => {
  assert.match(app, /if \(isPracticeCleanupEntry_\(entry\)\) deletingEntryIds_\.add\(entry\.id\);/);
  const pred = app.slice(app.indexOf("function isPracticeCleanupEntry_("), app.indexOf("function markPracticeDeleting_()"));
  assert.match(pred, /e\.link\.kind === "repayment"/);
});
