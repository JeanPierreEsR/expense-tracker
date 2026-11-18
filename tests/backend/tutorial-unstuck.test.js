// Two real tutorials that waited forever (journeys run, 2026-11-17), reproduced with real taps on the test copy and fixed:
// the budget tutorial looked for the new budget only by name ("Saving…" for 30 s, then the person tapped Exit), and the statements
// tutorial waited on "One moment…" for the new-account box that "Add the account and continue" removes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");

test("the budget tutorial finds the new budget as the row that was not there at Save", () => {
  const fn = app.slice(app.indexOf("function budgetGuideSteps_("), app.indexOf("function programmedGuideSteps_("));
  assert.match(fn, /before = new Set\(rowIds\(\)\)/);
  assert.match(fn, /rows\.find\(\(r\) => r\.dataset\.budgetId && !before\.has\(r\.dataset\.budgetId\)\)/);
});

test("the statements tutorial's new-account step ends once the account was added", () => {
  const at = stm.indexOf('tr("rt.stmt.newAccounts")');
  const step = stm.slice(stm.lastIndexOf("{ target:", at), stm.indexOf("},", stm.indexOf("before:", at)));
  assert.match(step, /until: \(\) => addedAccounts\.length > 0 && !\$\("statement-history"\)\.querySelector\("\.stmt-new-accounts"\)/);
});
