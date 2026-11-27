// Spanish singular and plural for texts that hold a number (owner, 2026-11-17: "1 podrían pasarse con lo programado"
// was found by the testers on more than one run). A Spanish text whose words agree with a count — "{n} podrían…",
// "{n} cuotas pendientes", "las {n} líneas" — reads wrong when the count is 1. Such a text must be written with both
// forms, { one: "…", other: "…" } (the app and the server pick "one" when n is 1), or have a separate singular text
// next to it (same key ending in "One", or "…Many" with a "…One"), or be listed in NEVER_ONE_ below with the reason
// the number can never be 1.
//
// What counts as "agreeing with the number": the word right after the count is a Spanish plural (ends in -s, or a
// plural verb ending in -n), or a plural word comes right before it ("los / las / estos / estas / sus / tus {n}").
// Count placeholders are those in COUNT_ below; a new placeholder that holds a number gets added there.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const APP = require(path.join(ROOT, "docs", "strings.js"));
const SERVER = (() => {
  const ctx = vm.createContext({ Logger: { log() {} } });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "backend", "Strings.gs"), "utf8"), ctx);
  return vm.runInContext("BACKEND_STRINGS_", ctx);
})();

// Placeholders that hold a count of things.
const COUNT_ = ["n", "k", "count", "days", "months", "weeks", "done", "saving", "shown", "used", "created", "renamed"];
// Words after a count that are the same in singular and plural, or not about the count.
const NEUTRAL_ = new Set(["más", "de", "en", "con", "por", "min", "h", "d", "y", "o", "a", "del", "al", "que", "para", "sin", "es", "pdf"]);
const PLURAL_BEFORE_ = /(?:^|[\s¿¡(])(los|las|estos|estas|sus|tus|nuestros|nuestras)\s+$/i;

// Texts whose count is never 1, with why. Keep this short: a one/other form is almost always the better fix.
const NEVER_ONE_ = {
  "tagsScreen.deleteManyUnused": "k is 2 or more: one tag uses tagsScreen.deleteAskUnused",
  "review.confirmReady": "the button shows only when 2 or more items are ready",
  "pace.greyAvg": "average of 2 or more earlier months (pace needs at least 2)",
  "pace.avgName": "same as pace.greyAvg",
  "pace.avgNameStart": "same as pace.greyAvg",
  "pace.avgBare": "same as pace.greyAvg",
  "search.minChars": "a fixed minimum of 2 or more letters",
  "entriesBulk.limit": "a fixed limit (hundreds)",
  "bulk.tooMany": "a fixed limit (hundreds)",
  "err.tooLong": "a fixed limit (2,000 characters)",
  "xlink.tooFar": "a fixed limit (10 days)",
  "pmm.notEnough": "a fixed minimum of several months",
  "pmm.compareHint": "a fixed number of months",
  "table.bigFile": "only shown for big files (thousands of lines)",
  "projMethod.customLabelNoSeason": "the months are 3, 6, 12 or 24",
  "entriesBulk.catMerge": "only when the entries come from 2 or more categories, so 2 or more entries",
  "catBulk.mergeAlert": "only with 2 or more categories",
  "catBulk.introOne": "{n} is how many were chosen: more than the one in use",
  "catBulk.confirmMany": "one category uses categories.confirmDelete",
  "budgets.confirmEndMany": "one budget uses its own question (budgetEndQuestion_)",
  "bank.nLeft": "one installment uses bank.oneLeft",
  "bank.earlyEffectShorten": "one installment fewer uses bank.earlyEffectShorten1",
  "deleted.empty": "the days are the 30-day keep time",
  "prof.tabsCount": "Home and More are always in the bar: 2 or more",
  "mailHealth.catchUp": "only shown when it is more than 3 days",
  "firstSteps.firstMailLate": "only shown after 3 days or more",
  "stmt.openAll": "only shown with 2 or more waiting",
  "bal.setAll": "only shown with 2 or more balances",
  "noacct.more": "{shown} is the page size, shown only when more exist",
  "tidy.more": "{shown} is the page size, shown only when more exist",
  "charges.telegramOne": "the days are the reminder wait (45)",
  "bankSample.demandMany": "only when more than 1 phone (1 uses bankSample.demandFirst)",
  "statementSample.demandMany": "only when more than 1 phone (1 uses statementSample.demandFirst)",
  "bot.repayKept": "only when there are 2 or more open loans (RepayIntent.gs: a real choice)",
  "bot.repayPickLoanMany": "only when there are more than 8 loans (REPAY_LIST_MAX_)",
  "bot.repayPickLoanManyTg": "only when there are more than 8 loans (REPAY_LIST_MAX_)",
};

function pluralAgreement(es) {
  const hits = [];
  for (const m of es.matchAll(/\{(\w+)\}/g)) {
    if (!COUNT_.includes(m[1])) continue;
    const before = es.slice(0, m.index);
    const after = es.slice(m.index + m[0].length).match(/^\s+([a-záéíóúñü]+)/i);
    const word = after && after[1].toLowerCase();
    const pluralAfter = word && !NEUTRAL_.has(word) && /(s|n)$/.test(word) && word.length > 2;
    const pluralBefore = PLURAL_BEFORE_.test(before);
    if (pluralAfter || pluralBefore) hits.push(`{${m[1]}}${pluralAfter ? " " + word : ""}`);
  }
  return hits;
}

function check(dict, label) {
  const keys = Object.keys(dict), bad = [];
  for (const key of keys) {
    const es = dict[key] && dict[key].es;
    if (typeof es !== "string") continue;             // already { one, other } (or English only)
    const hits = pluralAgreement(es);
    if (!hits.length) continue;
    const base = key.replace(/\.co$/, ""), co = key === base ? "" : ".co";   // a company copy's own wording ("<key>.co") pairs like its text
    const singular = [base + "One" + co, base.replace(/Many$/, "One") + co, base.replace(/Many$/, "") + co].filter((k) => k !== key);
    if (singular.some((k) => dict[k])) continue;
    if (NEVER_ONE_[key]) continue;
    bad.push(`${label} ${key}: ${hits.join(", ")} — "${es.slice(0, 70).replace(/\n/g, " ")}"`);
  }
  return bad;
}

test("Spanish texts that agree with a number have a form for 1", () => {
  const bad = [...check(APP, "docs/strings.js"), ...check(SERVER, "backend/Strings.gs")];
  assert.deepEqual(bad, [], "write these as { one, other } in both languages, add a singular text, or list them in NEVER_ONE_ with the reason:\n" + bad.join("\n"));
});

test("the check catches the cases it is for", () => {
  assert.ok(pluralAgreement("{n} podrían pasarse con lo programado").length, "a plural verb after the count");
  assert.ok(pluralAgreement("{n} cuotas pendientes").length, "a plural noun after the count");
  assert.ok(pluralAgreement("Ver las {n} personas").length, "a plural article before the count");
  assert.equal(pluralAgreement("hace {n} min").length, 0, "a unit that does not change");
  assert.equal(pluralAgreement("Paso {n} de {total}").length, 0, "x of y");
  assert.equal(pluralAgreement("Otros: {n}").length, 0, "a label");
  assert.equal(pluralAgreement("{amount} pendientes").length, 0, "an amount is not a count");
});

test("every text listed as never 1 still exists and still needs the exception", () => {
  for (const key of Object.keys(NEVER_ONE_)) {
    const entry = APP[key] || SERVER[key];
    assert.ok(entry, `${key} is listed in NEVER_ONE_ but no longer exists: remove it from the list`);
    assert.ok(typeof entry.es === "string" && pluralAgreement(entry.es).length, `${key} no longer needs the exception: remove it from NEVER_ONE_`);
  }
});
