// A big spreadsheet against a big Sheet (the owner's Spendee export: ~6,900 lines, ~7,000 entries) took 43 s of computing in the
// matcher because every line was compared with every entry. A line can only match entries within a few days of it, so entries are now
// bucketed by day. Counts comparisons instead of timing them, so the test cannot be flaky. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

// One entry per day, however big the Sheet: the density a real Sheet has does not grow with its size.
function matchWork(nLines, nEntries) {
  const { rt } = freshApp({ entries: 5 });
  const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
  const entries = Array.from({ length: nEntries }, (_, i) => ({ id: "e" + i, type: "expense", date: day(i % nEntries), amount: 10 + (i % 90), currency: "PEN", description: "Shop " + i, merchant: "", payment_method_id: "pmA", to_payment_method_id: "", external_id: "" }));
  const lines = Array.from({ length: nLines }, (_, i) => ({ date: day((i * 7) % nEntries), description: "Line " + i, amount: -(10 + (i % 90)), currency: "PEN" }));
  rt.run(`var __work = 0; var __eff = stmtEntryEffects_; stmtEntryEffects_ = function () { __work++; return __eff.apply(null, arguments); };`);
  rt.run(`matchStatements_([{ key: 's', pmId: 'pmA', kind: 'csv', lines: ${JSON.stringify(lines)} }], ${JSON.stringify(entries)}, {});`);
  return rt.run("__work");
}

test("a line is compared only with the entries near its date, not with every entry", () => {
  const work = Number(matchWork(2000, 2000));
  assert.ok(work < 2000 * 40, `entry comparisons: ${work} (every-line-against-every-entry would be ${2000 * 2000})`);
});

test("doubling the file roughly doubles the work (it does not quadruple it)", () => {
  const small = Number(matchWork(1000, 1000)), big = Number(matchWork(2000, 2000));
  assert.ok(big < small * 3, `1,000 -> ${small}, 2,000 -> ${big}`);
});
