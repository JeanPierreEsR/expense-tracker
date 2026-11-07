// The one currency screen (owner, 2026-11-06): every currency has a country in both languages, and every box that chooses a currency opens it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const docs = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "docs", f), "utf8");
const STRINGS = require(path.join(__dirname, "..", "..", "docs", "strings.js"));

test("every currency has a country in both languages, and the extra search words exist", () => {
  const app = docs("app.js");
  const codes = [...app.slice(app.indexOf("const CURRENCIES = ["), app.indexOf("const DEFAULT_RECENT_CURRENCIES")).matchAll(/code: "([A-Z]{3})"/g)].map((m) => m[1]);
  assert.equal(codes.length, 40);
  const all = STRINGS.strings || STRINGS.STRINGS || STRINGS;
  for (const c of codes) {
    const s = all["currency.country." + c];
    assert.ok(s && s.en && s.es, "country of " + c);
  }
  for (const c of /CURRENCY_ALSO_WHERE_ = \[([^\]]*)\]/.exec(app)[1].match(/[A-Z]{3}/g)) {
    assert.ok(all["currency.where." + c].en && all["currency.where." + c].es, "search words of " + c);
  }
});

test("the boxes that choose a currency open the screen, and More… in a list with several choices does too", () => {
  const app = docs("app.js"), statements = docs("statements.js");
  for (const id of ["bank-currency", "exchange-out-currency", "exchange-in-currency", "welcome-main-select", "igv-payment-currency", "expected-currency"]) {
    assert.match(app, new RegExp(`\\[[^\\]]*"${id}"[^\\]]*\\]\\s*\\.forEach\\(\\(id\\) => currencyPickOn_`), id);
  }
  assert.match(app, /currencyPickOn_\(el\.querySelector\("\.balance-row-currency-select"\)\)/);
  assert.match(statements, /currencyPickOn_\(\$q\("fixed"\)\)/);
  assert.match(app, /more\.addEventListener\("click", \(\) => openCurrencyScreen_\(\{ many: true, selected, onDone/);
  assert.match(app, /openCurrencyScreen_\(\{ many: true, selected: \[welcome_\.home/);
  assert.match(app, /openCurrencyModal\("main-change"\)/);
});
