// Guards against request-time regressions. The fake is in-memory, so the thing
// that predicts real slowness is the NUMBER OF SHEET READS a request makes
// (each is a round trip to Google on the real sheet), not milliseconds.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function reads(rt, action, payload = {}) {
  rt.resetStats();
  rt.api(action, payload);
  return rt.stats.reads;
}

test("Overview summary does not read the sheet once per foreign-currency entry", () => {
  const { rt } = freshApp();
  const n = reads(rt, "getPeriodSummary");
  assert.ok(n < 60, `getPeriodSummary made ${n} sheet reads (was ~714 before the rate lookup was shared)`);
});

test("summary read count does not grow with the number of foreign entries", () => {
  const small = freshApp({ entries: 1000 });
  const big = freshApp({ entries: 7000 });
  const a = reads(small.rt, "getPeriodSummary");
  const b = reads(big.rt, "getPeriodSummary");
  assert.ok(b <= a + 5, `reads grew from ${a} to ${b} with 7x the entries`);
});

test("rate changes are still picked up after the shared lookup (no stale rates)", () => {
  const { rt } = freshApp();
  const month = new Date().toISOString().slice(0, 7);
  rt.api("setExchangeRate", { currency: "USD", month, rate: 3.5 });
  assert.equal(rt.api("getLatestRateOnOrBefore", { currency: "USD", month }).rate, 3.5);
  rt.api("setExchangeRate", { currency: "USD", month, rate: 4.2 });
  assert.equal(rt.api("getLatestRateOnOrBefore", { currency: "USD", month }).rate, 4.2);
});

test("app-open bundle reads far fewer cells, and returns exactly the same data as before", () => {
  const { rt } = freshApp();
  // reference: same request with the read cache forced off
  rt.run("var __origBundle = getStartupBundle; var __noMemo = function (p) { return { meta: getMeta(), entries: listEntries({ limit: 20 }), pending: listPendingEntries(), expectedRecurring: listExpectedRecurringItems() }; };");
  rt.resetStats();
  const plain = JSON.parse(rt.run("JSON.stringify(__noMemo({}))"));
  const plainCells = rt.stats.cellsRead, plainReads = rt.stats.reads;

  rt.resetStats();
  const cached = rt.api("getStartupBundle", {});
  assert.deepEqual(JSON.parse(JSON.stringify(cached)), plain, "cache must not change what the app receives");
  assert.ok(rt.stats.cellsRead < plainCells * 0.7, `cells read ${rt.stats.cellsRead} vs ${plainCells} uncached`);
  assert.ok(rt.stats.reads < plainReads * 0.7, `reads ${rt.stats.reads} vs ${plainReads} uncached`);
  assert.equal(rt.run("ROWS_MEMO_"), null, "cache is switched off again afterwards");
});

test("the read cache never leaks into later requests", () => {
  const { rt, data } = freshApp();
  rt.api("getStartupBundle", {});
  const f = rt.api("addFriend", { name: "After Bundle" });
  assert.ok(rt.api("getMeta").friends.some((x) => x.id === f.id));
});
