// The currency block (owner, 2026-11-13; private spec specs/design-system.md § Currency block): one row with the main
// currency, USD, the most recent other one and "More…", drawn by renderCurrencyChips(NAME) into #NAME-currency-chips, with the
// chosen code in #NAME-currency. This checks that every block on the page is wired that way, so a new form can copy it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DOCS = path.join(__dirname, "..", "..", "docs");
const html = fs.readFileSync(path.join(DOCS, "index.html"), "utf8");
const app = fs.readFileSync(path.join(DOCS, "app.js"), "utf8");

test("every currency block has its hidden box and is drawn by renderCurrencyChips", () => {
  const names = [...html.matchAll(/id="([\w-]*?)-?currency-chips"/g)].map((m) => m[1]);
  assert.ok(names.includes("") && names.includes("loan"), "found the blocks: " + names.join(", "));
  const bad = [];
  for (const name of names) {
    if (name === "settlement") continue;   // the repayment form lists only the currencies owed: not a currency block
    const input = name ? `${name}-currency` : "currency";
    const target = name || "entry";
    if (!new RegExp(`<input type="hidden" id="${input}"`).test(html)) bad.push(`${name || "+ form"}: no <input type="hidden" id="${input}">`);
    if (!app.includes(`renderCurrencyChips("${target}")`)) bad.push(`${name || "+ form"}: nothing calls renderCurrencyChips("${target}")`);
  }
  assert.deepEqual(bad, []);
});

test("the block always shows one row of three plus More…", () => {
  const fn = app.slice(app.indexOf("function renderCurrencyChips("), app.indexOf("function openCurrencyModal("));
  assert.match(fn, /recent\.slice\(0, 3 - base\.length\)/);
  assert.match(fn, /classList\.add\("currency-row3"\)/);
  assert.doesNotMatch(fn, /target === "entry"/, "every form gets the same row, not only the + form");
});
