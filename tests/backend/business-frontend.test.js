// Business pack — the parts of the front end a backend test cannot see (source guards; the screens themselves were
// clicked through on the test app in English and Spanish). See specs/business.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const app = read("docs", "app.js");
const html = read("docs", "index.html");
const api = read("backend", "Api.gs");

test("the three business screens are remembered by the More tab (tab memory)", () => {
  const line = app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1];
  for (const name of ["business", "business-detail", "business-features"]) {
    assert.ok(line.includes(`"${name}"`), name + " is in MORE_SUBSCREENS");
    assert.ok(html.includes(`id="screen-${name}"`), name + " exists in index.html");
  }
});

test("creating a company or a project is protected against a resend, in the app and in the backend", () => {
  for (const action of ["addCompany", "addProject"]) {
    assert.match(app.match(/const ONCE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1], new RegExp(`"${action}"`), action + " in app.js");
    assert.match(api.match(/var ONCE_ACTIONS_ = \{([\s\S]*?)\};/)[1], new RegExp(`\\b${action}: 1`), action + " in Api.gs");
  }
});

test("the More card is hidden in the page itself, so a copy that never opts in never sees it", () => {
  assert.match(html, /id="more-business-btn" hidden/);
  assert.match(html, /id="business-field" hidden/);
});

test("the entry form sends the business link only through businessLinkFields_ (nothing while the pack is off)", () => {
  const fn = app.match(/function businessLinkFields_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!businessOn\(\)[^\n]*return \{\};/);
  // all three save paths spread it (new entry, edit, confirm-from-review)
  assert.equal((app.match(/\.\.\.businessLink\b/g) || []).length, 3);
});

test("the owner's own copy is switched on once, and only when nothing was ever chosen (friends' copies never)", () => {
  const fn = app.match(/function maybeEnableBusinessForOwner_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /!perfIsOwnerCopy_\(\)\) return;/, "owner's copy only");
  assert.match(fn, /saved !== undefined && saved !== ""\) return;/, "a choice already on record is respected");
  assert.match(fn, /callApi\("enableBusinessForOwnerOnce"/, "the server decides (a stale phone copy must not undo a later 'no')");
  assert.match(app, /function refreshExtrasRow_\(\) \{\s*maybeEnableBusinessForOwner_\(\);/, "runs after the app's data has loaded");
});

test("the period of every Companies & projects screen has a Custom… choice that opens the calendar and can be cancelled", () => {
  assert.match(app, /\["custom", "business\.period\.custom"\]/, "the choice is in the list the three screens share");
  assert.match(app, /if \(businessPeriod_ === "custom"\) return \{ startDate: businessCustom_\.start \|\| null, endDate: businessCustom_\.end \|\| null \};/);
  const handler = app.match(/if \(sel\.value === "custom"\) \{[\s\S]*?return;\n  \}/)[0];
  assert.match(handler, /sel\.value = businessPeriod_;/, "closing the calendar without Done leaves the period as it was");
  assert.match(handler, /openDateRangePicker_\(/);
  assert.ok(html.includes('id="business-custom-start"') && html.includes('id="business-custom-end"'));
});

test("Close / Reopen project says what it is doing while it waits, and goes back to its label if it fails", () => {
  const handler = app.match(/if \(statusBtn\) statusBtn\.addEventListener\("click", async \(\) => \{[\s\S]*?\n  \}\);/)[0];
  assert.match(handler, /statusBtn\.textContent = tr\(closing \? "business\.closingProject" : "business\.reopeningProject"\);/);
  assert.match(handler, /catch \(err\)[\s\S]*statusBtn\.textContent = tr\(closing \? "business\.closeProject" : "business\.reopenProject"\);/);
});

test("the project budget button says 'Add a budget' in both languages", () => {
  const strings = read("docs", "strings.js");
  assert.match(strings, /"business\.addBudget": \{ en: "\+ Add a budget", es: "\+ Agregar un presupuesto" \}/);
});

test("step 2: People is a remembered More screen; business people hide from ordinary pickers while the pack is off", () => {
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"business-people"'));
  assert.ok(html.includes('id="screen-business-people"'));
  assert.match(app, /function plainFriends_\(\) \{ return meta\.friends\.filter\(\(f\) => !isGroupFriend_\(f\) && \(!isBusinessPerson_\(f\) \|\| businessOn\(\)\)\); \}/);
  assert.match(app, /\(!isGroupFriend_\(f\) && \(!isBusinessPerson_\(f\) \|\| businessOn\(\)\)\) \|\| \(tripId/, "the split list follows the same rule");
});

test("step 2: a repayment from a project sheet carries the project; the Loans tab never does", () => {
  assert.match(app, /project_id: repaymentProjectId_ \|\| undefined/);
  assert.match(app, /openLoanDetail\(r\.friend_id, r\.friend_name, ""\)/, "the Loans tab asks for every debt of the person");
  assert.match(app, /openLoanDetail\(row\.dataset\.friend, row\.dataset\.name, d\.project\.id\)/, "the project's Owed rows ask for that project only");
});

test("step 2: the cash-loan form and the Entries-tab Repayment / New loan send a project only while the pack is on", () => {
  assert.match(app, /if \(businessOn\(\)\) fields\.project_id = document\.getElementById\("loan-project"\)\.value;/);
  assert.match(app, /if \(businessOn\(\)\) fields\.project_id = businessPickProjectId_\(\);/);
});

test("a future date with a company or project is refused instead of becoming a Programmed item", () => {
  assert.match(app, /business\.futureNotYet/);
});

// ---- Step 3A: expected payments, the Home card, "Choose which loans this pays" ----

test("step 3A: creating an expected payment is protected against a resend, in the app and in the backend", () => {
  assert.match(app.match(/const ONCE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1], /"addExpectedPayment"/);
  assert.match(api.match(/var ONCE_ACTIONS_ = \{([\s\S]*?)\};/)[1], /\baddExpectedPayment: 1/);
});

test("step 3A: the expected-payment picker, the Home card and the 'choose loans' block are hidden in the page itself", () => {
  assert.match(html, /id="expected-field" hidden/);
  assert.match(html, /id="business-expected-card" hidden/);
  assert.match(html, /id="settlement-choose" hidden/);
  assert.match(html, /id="expected-modal-backdrop" class="[^"]*" hidden/);
});

test("step 3A: the Home business card is a separate card that follows every Programmed-this-month refresh, and hides while the pack is off", () => {
  assert.match(app, /async function refreshExpectedRecurring\(prefetchedGroups\) \{\s*refreshBusinessHomeCard_\(\);/);
  const fn = app.match(/async function refreshBusinessHomeCard_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(!businessOn\(\)\) \{ card\.hidden = true; return; \}/);
  assert.match(fn, /scope: "home"/);
  assert.ok(html.indexOf('id="expected-recurring-card"') < html.indexOf('id="business-expected-card"'), "directly under Programmed this month");
});

test("step 3A: the income form sends the expected payment only for an income on a project, and its state is declared before selectCurrency can use it", () => {
  const fn = app.match(/function businessLinkFields_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /expected_payment_id: selectedType === "income" \? expectedPick_ : ""/);
  assert.ok(app.indexOf("let expectedPick_") < app.indexOf("function selectCurrency("), "declared first (a let used before its line throws)");
  assert.match(app, /function syncExpectedField_\(\)|async function syncExpectedField_\(\)/);
});

test("step 3A: the repayment sends the chosen loans only when the panel was opened, never while fixing a recorded repayment", () => {
  assert.match(app, /const allocations = !editingSettlementId && !document\.getElementById\("settlement-choose-panel"\)\.hidden \? settlementAssignments_\(\) : \[\];/);
  assert.match(app, /allocations: allocations\.length \? allocations : undefined/);
  assert.match(app, /wrap\.hidden = !!editingSettlementId \|\| settlementChoosableLoans_\(\)\.length < 2;/);
});

test("step 3A: the loan picker shows only while fixing a recorded repayment, and its choice is sent as loan_id", () => {
  const html = read("docs", "index.html");
  assert.match(html, /<div id="settlement-loan-field" hidden>/);
  assert.match(app, /document\.getElementById\("settlement-loan-field"\)\.hidden = true;/);   // closed again whenever the sheet is reset
  assert.match(app, /const newLoanId = editingSettlementId && !document\.getElementById\("settlement-loan-field"\)\.hidden/);
  assert.match(app, /loan_id: newLoanId \|\| undefined/);
  assert.match(app, /openRepaymentModal\(friendId, friendName, netByCurrency, projectId, outstanding, loans\)/);
  const strings = read("docs", "strings.js");
  for (const key of ["settle.loanLabel", "settle.loanHint", "settle.loanOption", "settle.loanCurrent", "settle.loanTooMuch"]) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "[^"]+", es: "[^"]+"`), key);
  }
  assert.match(read("backend", "Strings.gs"), /"repay\.moveBad": \{ en: "[^"]+", es: "[^"]+"/);
});

test("step 3B: the IGV screen is remembered by the More tab, listed for beta usage, and its year picker is not a period picker", () => {
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"business-igv"'));
  assert.ok(html.includes('id="screen-business-igv"'));
  assert.match(read("backend", "BetaEvents.gs"), /business_igv: 1/);
  // fillBusinessPeriodSelects_ fills every .business-period-select: the year picker must not carry that class
  assert.match(html, /<select id="igv-year" class="igv-year-select">/);
  assert.ok(api.match(/var ONCE_ACTIONS_ = \{([\s\S]*?)\};/)[1].includes("addIgvPayment: 1"));
});

test("step 3B: the IGV switch is hidden in the page itself, its state is declared before it is used, and it travels with the link", () => {
  assert.match(html, /<div id="igv-field" hidden>/);
  assert.match(html, /<div id="igv-detail" hidden>/);
  assert.ok(app.indexOf("let igvTouched_") < app.indexOf("function setBusinessPick_("), "declared first (a let used before its line throws)");
  const fn = app.match(/function businessLinkFields_\(\) \{[\s\S]*?\n\}/)[0];
  assert.equal((fn.match(/igv_amount:/g) || []).length, 3, "every branch sends igv_amount, blank when there is none (that is what clears it on an edit)");
  assert.match(app, /if \(Number\(businessLink\.igv_amount\) >= amount\) throw new Error\(tr\("business\.errIgv"\)\);/);
  // a saved draft, an edit and the "Received" button all carry it
  assert.match(app, /igvOn: document\.getElementById\("igv-toggle"\)\.checked,/);
  assert.match(app, /setIgvState_\(d\.igvOn, d\.igvAmount, d\.igvTouched\);/);
  assert.match(app, /setIgvState_\(Number\(entry\.igv_amount\) > 0, entry\.igv_amount, true\);/);
  assert.match(app, /igvOn: !!x\.igv_included/);
  // the company list the phone keeps must not drop the IGV fields (the entry form reads them)
  assert.match(app, /meta\.companies = companies\.map\(\(c\) => \(\{ id: c\.id, name: c\.name, emoji: c\.emoji, igv_enabled: c\.igv_enabled \|\| "", tax_id: c\.tax_id \|\| "" \}\)\);/);
});

test("step 3B: every igv.* text the app uses exists in English and Spanish", () => {
  const strings = read("docs", "strings.js");
  const used = new Set([...app.matchAll(/tr\("(igv\.[A-Za-z.]+|business\.errIgv)"/g)].map((m) => m[1]));
  for (const key of html.matchAll(/data-i18n="(igv\.[A-Za-z.]+)"/g)) used.add(key[1]);   // the texts written in the page itself
  assert.ok(used.size > 25, "found " + used.size);
  for (const key of used) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "[^"]+", es: "[^"]+"`), key);
  }
  for (const key of ["business.errIgv", "business.igvPaymentNotFound", "export.h.igv"]) {
    assert.match(read("backend", "Strings.gs"), new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "[^"]+", es: "[^"]+"`), key);
  }
});

test("step 3B: the receipt reader button is hidden in the page itself, shown only while the pack is on for an expense or income, and nothing is uploaded", () => {
  assert.match(html, /<div id="receipt-read-field" hidden>/);
  assert.match(html, /<script src="receipt-fields\.js\?v=[^"]+"><\/script>/, "the pure reader is loaded (ship.sh bumps its ?v= like the others)");
  assert.match(app, /field\.hidden = !\(businessOn\(\) && \(selectedType === "expense" \|\| selectedType === "income"\)\);/);
  assert.match(app, /syncReceiptField_\(\);\n\}/, "re-evaluated whenever the type changes (populateBusinessOptions_)");
  const block = app.slice(app.indexOf("async function readReceiptPhoto_"), app.indexOf("document.getElementById(\"receipt-read-btn\")"));
  assert.ok(!/callApi\(/.test(block), "the photo never leaves the phone");
  assert.match(app, /ReceiptFields\.parse\(text, \{ today: todayLocalISO\(\) \}\)/);
  const strings = read("docs", "strings.js");
  const used = new Set([...app.matchAll(/tr\("(receipt\.[A-Za-z.]+)"/g)].map((m) => m[1]));
  for (const key of html.matchAll(/data-i18n="(receipt\.[A-Za-z.]+)"/g)) used.add(key[1]);
  for (const key of ["receipt.f.amount", "receipt.f.date", "receipt.f.business", "receipt.f.payer", "receipt.f.invoice", "receipt.f.igv"]) used.add(key);   // built from a list in the code
  assert.ok(used.size >= 12, "found " + used.size);
  for (const key of used) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "[^"]+", es: "[^"]+"`), key);
  }
});

test("step 3A: every xp.* / bx.* / settle.choose* text the app uses exists in English and Spanish", () => {
  const strings = read("docs", "strings.js");
  const used = new Set([...app.matchAll(/tr\("((?:xp|bx)\.[A-Za-z.]+|settle\.choose[A-Za-z]*|field\.expected)"/g)].map((m) => m[1]));
  used.delete("xp.state.");
  ["xp.state.settled", "xp.state.covered"].forEach((k) => used.add(k));   // built from a prefix in the code
  assert.ok(used.size > 20);
  for (const key of used) {
    assert.match(strings, new RegExp(`"${key.replace(/\./g, "\\.")}": \\{ en: "[^"]+", es: "[^"]+"`), key);
  }
});
