// A tab whose first load failed says so (owner, 2026-11-07): with no connection Overview showed zeros, and Budgets and Loans looked empty, with no word about why.
// Clicked through with the server cut off on the test copy; these lines keep the wiring from being lost.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const docs = path.join(__dirname, "..", "..", "docs");
const app = fs.readFileSync(path.join(docs, "app.js"), "utf8");
const css = fs.readFileSync(path.join(docs, "style.css"), "utf8");
const strings = fs.readFileSync(path.join(docs, "strings.js"), "utf8");

test("Overview, Budgets and Loans show the message on a failed first load and drop it on success", () => {
  for (const name of ["overview", "budgets", "loans"]) {
    assert.ok(app.includes(`setLoadFailed_("${name}", err)`), name + " shows it");
    assert.ok(app.includes(`setLoadFailed_("${name}", null)`), name + " clears it");
  }
});

test("Overview's zeros and Budgets' old rows are hidden under the message, the period picker stays", () => {
  assert.match(css, /#screen-overview\.load-failed > \.card:not\(#period-selector-card\)/);
  assert.match(css, /#screen-budgets\.load-failed > \.card:not\(#period-selector-card\)/);
});

test("the open screen tries again when the connection returns", () => {
  assert.match(app, /addEventListener\("online", \(\) => \{\s*const open = document\.querySelector\("\.screen\.load-failed:not\(\[hidden\]\)"\)/);
});

test("Home: the summary card leads with What's left of the month it shows; no '% vs last month' (owner, 2026-11-12)", () => {
  // Spending pace compares with last month; the card's headline is What's left, named by its month.
  const card = /function homeMainCard_\(g\) \{([\s\S]*?)\n\}/.exec(app)[1];
  assert.ok(card.includes('tr("home.leftThisMonth")') && card.includes('tr("home.leftIn"'));
  assert.ok(!card.includes("home.vsSameDay") && !card.includes("home.vsLast"));
  assert.match(strings, /"home\.leftThisMonth": \{ en: "Result this month", es: "Resultado del mes" \}/);   // renamed from "What's left" (owner, 2026-11-13)
});
