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
  assert.match(STRINGS["spot.j.intro"].en, /Nothing changes in the app\.$/);
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

test("loan form: a new loan starts on the top account, no account is a named last choice, the hint no longer says Optional", () => {
  const pop = app.slice(app.indexOf("function populateLoanPaymentMethodOptions()"), app.indexOf("function updateLoanOpeningUi_("));
  assert.match(pop, /tr\(accounts\.length \? "loanModal\.noAccount" : "form\.noneAccount"\)/);
  assert.ok(pop.indexOf("accounts.forEach") < pop.indexOf("noneOpt"), "the named choice comes last");
  assert.match(app, /loanPmSelect\.value = loan \? \(loan\.payment_method_id \|\| ""\) : \(loanPmSelect\.options\.length \? loanPmSelect\.options\[0\]\.value : ""\)/);
  assert.ok(!/^Optional|^Opcional/.test(STRINGS["loanModal.pmHint"].en) && !/^Opcional/.test(STRINGS["loanModal.pmHint"].es));
  assert.ok(STRINGS["loanModal.noAccount"].en && STRINGS["loanModal.noAccount"].es);
});

test("Budgets practice: 7 steps, ends on the new budget's row and deletes it by itself, its row saying Deleting…", () => {
  const steps = app.slice(app.indexOf("function practiceBSteps_()"), app.indexOf("function startBudgetPractice_()"));
  assert.ok(!/spot\.b\.(s4b|s5|s8|s9|s10|gotIt)/.test(steps + app), "the Annual, alerts, detail and delete steps are gone");
  assert.match(steps, /target: practiceBRow_, text: \(\) => tr\("spot\.b\.s7"\), button: \(\) => tr\("spot\.b\.finish"\)/);
  assert.equal((steps.match(/^    \{ (key|target)/gm) || []).length, 7, "intro, +, category, amount, period, save, row");
  assert.ok(/Practice \(budget\|/.test(app) && /\(Presupuesto\|/.test(app), "the usual Deleting… sweep knows the budget's name in both languages");
  for (const k of ["s4b", "s5", "s8", "s9", "s10", "gotIt"]) assert.ok(!STRINGS[`spot.b.${k}`], k);
});

test("Needs review practice: 5 steps, the look-only ones merged, ending on the confirmed entry", () => {
  const steps = app.slice(app.indexOf("function practiceNSteps_()"), app.indexOf("function startReviewPractice_()"));
  assert.equal((steps.match(/^    \{ (look: true, )?(key|target)/gm) || []).length, 5, "intro, category, confirm, discard, done");
  assert.ok(steps.indexOf('key: "discard"') < steps.indexOf('target: practiceNEntryRow_'), "the last step lights the confirmed entry");
  assert.match(steps, /target: practiceNEntryRow_, text: \(\) => tr\("spot\.n\.s8"\), button: \(\) => tr\("spot\.n\.finish"\)/);
  for (const k of ["s1", "s2", "s4", "s6", "gotIt"]) { assert.ok(!STRINGS[`spot.n.${k}`], k); assert.ok(!app.includes(`spot.n.${k}"`), k); }
});

test("Needs review practice: Paid from is filled with the top account before Confirm", () => {
  const steps = app.slice(app.indexOf("function practiceNSteps_()"), app.indexOf("function startReviewPractice_()"));
  assert.match(steps, /pm\.type !== "investment" && !pmHidden_\(pm\)/);
  assert.match(steps, /key: "confirm", target: \(\) => \{ fillAccount\(\);/);
});

test("Import practice: Practice rides starts on create and the person sends it into a category; the preview step leaves out the save button", () => {
  const stm = fs.readFileSync(path.join(DOCS, "statements.js"), "utf8");
  const steps = stm.slice(stm.indexOf("function practiceISteps_()"), stm.indexOf("// The Bank statements practice:"));
  assert.match(steps, /sel\.value !== "create"/, "it always starts on create");
  assert.match(steps, /option\[value\^="ren:"\]/, "the rename choices are taken away: the practice never renames a real category");
  assert.match(steps, /\^\(transport\|transporte\)\$/i);
  assert.ok(steps.indexOf("transport|transporte") < steps.indexOf("taxis?") && steps.indexOf("taxis?") < steps.indexOf("other|others"), "fallback order");
  assert.match(steps, /return !!rideInto\(\);/, "with no category to pick the step is skipped");
  assert.match(stm, /filter\(\(c\) => c\.id !== "statement-history-save"\)/);
  assert.match(steps, /target: preview, text: \(\) => tr\("spot\.f\.s7"\)/);
  for (const k of ["s4", "s4other"]) { assert.match(STRINGS[`spot.f.${k}`].en, /\{category\}/); assert.match(STRINGS[`spot.f.${k}`].es, /\{category\}/); }
});

test("the preview offers Currency exchange only when two lines can really be linked", () => {
  const StatementTable = require(path.join(DOCS, "statement-table.js"));
  const out = (currency) => ({ amount: -10, currency }), inn = (currency) => ({ amount: 10, currency });
  assert.equal(StatementTable.canLinkExchange([]), false);
  assert.equal(StatementTable.canLinkExchange([out("PEN"), out("PEN"), out("PEN")]), false, "the practice file: three expenses");
  assert.equal(StatementTable.canLinkExchange([out("PEN"), inn("PEN")]), false, "one currency");
  assert.equal(StatementTable.canLinkExchange([out("PEN"), out("USD")]), false, "two currencies, nothing arriving");
  assert.equal(StatementTable.canLinkExchange([out("PEN"), inn("USD")]), true);
  assert.equal(StatementTable.canLinkExchange([inn("PEN"), out("USD")]), true);
  const stm = fs.readFileSync(path.join(DOCS, "statements.js"), "utf8");
  assert.match(stm, /StatementTable\.canLinkExchange\(summary\.candidates\) \? exchangeHtml\(\)/);
});

test("Bank statements practice: 11 steps, the Inbox closed so the card's heading shows, and the preview step leaves out the save button", () => {
  const stm = fs.readFileSync(path.join(DOCS, "statements.js"), "utf8");
  const steps = stm.slice(stm.indexOf("function practiceBSteps_()"), stm.indexOf("// Adds the empty Practice account"));
  assert.equal((steps.match(/^      \{ (key|look|target)/gm) || []).length, 11);
  assert.match(steps, /inboxOpen = false; setInboxOpen\(false\);/);
  assert.match(steps, /target: preview, text: \(\) => tr\("spot\.s\.s7"\)/);
  assert.match(stm, /c\.id !== "statement-history-save"/);
  assert.ok(!STRINGS["spot.s.s2"], "the two first looks are one step now");
});

test("Export practice: 5 steps, and while the file is being prepared the step says so instead of Tap", () => {
  const steps = app.slice(app.indexOf("function practiceESteps_()"), app.indexOf("function startExportPractice_()"));
  assert.equal((steps.match(/^    \{ (key|target|text)/gm) || []).length, 5);
  assert.match(steps, /el\("export-get-btn"\)\.disabled \? tr\("export\.preparing"\)/);
  assert.ok(!STRINGS["spot.e.s1"]);
  assert.ok(STRINGS["export.preparing"].en && STRINGS["export.preparing"].es);
});

test("Tidy my history: 5 steps, the button says the same word as the group's count, the row on two lines", () => {
  const steps = app.slice(app.indexOf("function practiceYSteps_()"), app.indexOf("// Adds the three practice entries"));
  assert.equal((steps.match(/^    \{ (key|target|text)/gm) || []).length, 5);
  assert.equal(STRINGS["tidy.showLines"].en, "Show the entries");
  assert.equal(STRINGS["tidy.showLines"].es, "Ver los movimientos");
  assert.ok(STRINGS["spot.y.s2"].en.includes("“Show the entries”") && STRINGS["spot.y.s2"].es.includes("“Ver los movimientos”"));
  const css = fs.readFileSync(path.join(DOCS, "style.css"), "utf8");
  assert.match(css, /\.tidy-group-row \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/);
  for (const k of ["s1", "gotIt"]) assert.ok(!STRINGS[`spot.y.${k}`], k);
});

test("Projections practice: offered only with 6 complete months of data, 7 steps, it never saves a method", () => {
  assert.match(app, /const PROJECTIONS_MIN_MONTHS_ = 6;/);
  assert.match(app, /await Promise\.all\(\[refreshProjections\(\), refreshProjectionCategories\(\)\]\);\s*offerProjectionsTip_\(\);/);
  assert.match(html, /id="projections-tip-invite"/);
  const offer = app.slice(app.indexOf("async function offerProjectionsTip_()"), app.indexOf("function practiceJSteps_()"));
  assert.match(offer, /months >= PROJECTIONS_MIN_MONTHS_/);
  const code = app.slice(app.indexOf("function practiceJSteps_()"), app.indexOf("// Draws actual cumulative spend for the category"));
  assert.equal((code.match(/^    \{ (key|look|target)/gm) || []).length, 7);
  for (const off of ["pmm-save", "pmm-apply-all", "pmm-apply-best", "pmm-compare-cats"]) assert.ok(!code.includes(off), off + " is never lit");
  assert.ok(!/callApi\(/.test(code), "the practice itself makes no server call");
  assert.match(code, /closeProjectionMethodModal_\(\);/);
  for (const k of new Set([...code.matchAll(/tr\("(spot\.j\.[A-Za-z0-9]+)"/g)].map((m) => m[1]))) assert.ok(STRINGS[k] && STRINGS[k].en && STRINGS[k].es, k);
});

test("exchange form: same currency said at once, an account's known currency sets its side, a mismatch only warns, and neither runs in the practice", () => {
  const code = app.slice(app.indexOf("let exchangeCurTouched_"), app.indexOf('// "Currency exchange" is the last choice of Type of transfer'));
  assert.match(code, /errorEl\.textContent = tr\("xch\.sameCurrency"\)/);
  assert.match(code, /Spotlight\.isRunning\(\) \? \[\]/);
  assert.match(code, /!exchangeCurTouched_\[side\] && !Spotlight\.isRunning\(\)/);
  assert.match(html, /id="exchange-account-note"/);
  assert.match(code, /there\.value === here\.value && exchangeCurPrev_\[side\]/, "picking the other side's currency swaps them");
  const save = app.slice(app.indexOf('document.getElementById("exchange-save-btn").addEventListener'), app.indexOf("// ---- New-entry sheet + the round"));
  assert.match(save, /if \(out\.currency === inn\.currency\) \{ errorEl\.textContent = tr\("xch\.sameCurrency"\); return; \}/);
  assert.ok(!/accountMismatch/.test(save), "a mismatch never blocks Save");
  assert.ok(STRINGS["xch.accountMismatch"].en && STRINGS["xch.accountMismatch"].es);
});
