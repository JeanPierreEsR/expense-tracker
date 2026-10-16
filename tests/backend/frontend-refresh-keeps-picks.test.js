// Reloading the lists (pull-down refresh runs loadMeta) while an edit screen is
// open used to reset "Paid by" and the payment method to their first option — a
// pending card entry showed another bank's account. loadMeta must put back what
// was chosen. (Checked in a real browser on the test app; this guards the code.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const loadMeta = /async function loadMeta[\s\S]*?\n}\n/.exec(src)[0];

test("loadMeta remembers paid by + payment method before rebuilding the pickers, and restores them", () => {
  const remember = loadMeta.indexOf('["paid_by", "payment_method"].map');
  const rebuild = loadMeta.indexOf("populatePaymentMethodOptions()");
  const restore = loadMeta.indexOf("sel.value = keptPicks[k]");
  assert.ok(remember > 0 && rebuild > remember && restore > rebuild, "remember → rebuild → restore, in that order");
});
