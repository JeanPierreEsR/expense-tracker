// Business pack, step 4 on the phone (specs/business.md § Step 4): the statement screen, the two pop-ups and how they are wired.
// Source-reading guards, like business-frontend.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", ...p), "utf8");
const html = read("docs", "index.html");
const app = read("docs", "app.js");
const api = read("backend", "Api.gs");
const beta = read("backend", "BetaEvents.gs");

test("the statement screen and both pop-ups are in the page, closed, and the screen is remembered by the More tab and listed for beta usage", () => {
  assert.match(html, /<div id="screen-business-statement" class="screen" hidden>/);
  assert.match(html, /<div id="opening-modal-backdrop"[^>]*hidden>/);
  assert.match(html, /<div id="accountant-modal-backdrop"[^>]*hidden>/);
  assert.ok(app.match(/const MORE_SUBSCREENS = \[([^\]]*)\]/)[1].includes('"business-statement"'));
  assert.match(beta, /business_statement: 1/);
});

test("the period picker reloads the statement, and the statement is reached only from a project or company screen", () => {
  const fn = app.match(/function refreshBusinessPeriodScreens_\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /screen-business-statement[\s\S]*refreshStatement_\(\)/);
  assert.match(app, /document\.getElementById\("business-detail-statement-btn"\)\.addEventListener\("click", \(\) => showStatementScreen_\(businessDetail_\.kind, businessDetail_\.id\)\)/);
  assert.match(html, /id="statement-period" class="business-period-select"/, "it shares the project screens' period choices");
});

test("every action the statement screen calls is routed on the server", () => {
  for (const action of ["getProjectStatement", "getCompanyStatement", "saveBusinessOpening", "deleteBusinessOpening", "getOpeningImpact", "saveAccountantFigures", "deleteAccountantFigures"]) {
    assert.ok(app.includes(`"${action}"`), `${action} is called by the app`);
    assert.match(api, new RegExp(`case '${action}': return ${action}\\(payload\\)`), `${action} is routed`);
  }
});

test("the CSV comes from the server and is handed to the share sheet from the tap itself", () => {
  const handler = app.match(/document\.getElementById\("statement-csv-btn"\)\.addEventListener\("click", async \(\) => \{[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /statementData_\.csv/);
  assert.match(handler, /navigator\.share\(\{ files: \[file\] \}\)/);
  assert.ok(!/callApi/.test(handler), "no server call between the tap and the share sheet (iOS wants the tap)");
});

test("typing an opening is only possible for today or earlier, and the pop-ups never offer a new date for a saved set", () => {
  assert.match(app, /document\.getElementById\("opening-date"\)\.max = todayLocalISO\(\)/);
  assert.match(app, /document\.getElementById\("accountant-date"\)\.disabled = !!figures/);
  assert.match(app, /document\.getElementById\("opening-currency"\)\.disabled = !!opening/);
});

test("the IGV screen tells the person it still counts every entry when opening figures exist", () => {
  assert.match(app, /d\.hasOpenings \? `<p class="hint">\$\{escapeHtml\(tr\("igv\.openingNote"\)\)\}<\/p>`/);
});
