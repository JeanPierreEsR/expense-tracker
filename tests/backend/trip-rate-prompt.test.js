// Choosing a trip's currency that has no exchange rate on file asks for one (2026-10-19). Checked in a real
// browser on the test app (USD has a rate → silent; ARS has none → the rate pop-up opens, "Skip for now" keeps a
// warning with a "Set one" link; saving a rate clears it). This guards that the pieces stay wired.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");

test("picking a currency in the trip form checks its rate and prompts when missing", () => {
  const selectCurrency = /function selectCurrency[\s\S]*?\n}\n/.exec(src)[0];
  assert.match(selectCurrency, /resolvedTarget === "trip"[\s\S]*refreshTripRateWarning_\(true\)/, "choosing the currency prompts");
  const check = /async function refreshTripRateWarning_[\s\S]*?\n}\n/.exec(src)[0];
  assert.match(check, /currency === homeCur\(\)/, "the main currency never needs a rate");
  assert.match(check, /getLatestRateOnOrBefore/, "it asks the server whether any rate covers the trip's start month");
  assert.match(check, /if \(promptIfMissing\) await setTripCurrencyRate_/, "the pop-up opens only when the person just chose the currency");
  assert.match(/async function setTripCurrencyRate_[\s\S]*?\n}\n/.exec(src)[0], /openRateModal\(currency, month, \/\* required \*\/ false\)/, "and it can be skipped");
});

test("the form keeps a warning with a 'Set one' link, and re-checks when the dates or the trip change", () => {
  assert.ok(html.includes('id="trip-rate-warning"') && html.includes('id="trip-rate-warning-link"'));
  assert.match(src, /openTripModal_[\s\S]*?refreshTripRateWarning_\(false\)/, "opening an existing trip shows the warning without prompting");
  assert.match(src, /getElementById\("trip-start"\)\.addEventListener\("change", \(\) => refreshTripRateWarning_\(false\)\)/);
});
