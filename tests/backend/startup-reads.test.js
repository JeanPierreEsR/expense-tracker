// Opening the app reads each sheet from Google once (2026-11-19). The start-up bundle's getMeta ran outside the per-request read
// memory and read Entries three times (last income per person, paused and Annual programmed items), then the list a fourth: on
// the owner's real Sheet the start took 34-53 s, past the app's 25 s limit, so the app kept showing its saved copy (and missed
// a newly deployed card). Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { freshApp } = require("./helpers");
const { stats, resetStats } = require(path.join(__dirname, "..", "harness", "fake-google.js"));

function counting() {
  const { rt } = freshApp({});
  rt.run("getMeta()");   // first-run repairs out of the way
  rt.run(`var __reads = {}; var __ga = getAllRows; getAllRows = function (n) {
    if (!(ROWS_MEMO_ && ROWS_MEMO_[n])) __reads[n] = (__reads[n] || 0) + 1; return __ga.apply(this, arguments); };`);
  return rt;
}

test("the start-up bundle reads Entries once, and every sheet at most once unless it was changed", () => {
  const rt = counting();
  resetStats();
  const b = rt.api("getStartupBundle", { entriesLimit: 21 });
  assert.ok(b.meta && b.meta.capabilities && Array.isArray(b.entries), "the bundle still has everything");
  const reads = JSON.parse(rt.run("JSON.stringify(__reads)"));
  assert.equal(reads.Entries, 1, "Entries read once: " + JSON.stringify(reads));
  assert.ok(stats.reads <= 25, "about 20 sheet reads, was 41: " + stats.reads);
});

test("getMeta on its own (the app's fallback) reads Entries once too", () => {
  const rt = counting();
  rt.api("getMeta", {});
  const reads = JSON.parse(rt.run("JSON.stringify(__reads)"));
  assert.equal(reads.Entries, 1, JSON.stringify(reads));
});

test("start-up answers the same with the read memory as without it", () => {
  const { rt } = freshApp({});
  const strip = (m) => JSON.parse(JSON.stringify(m));
  rt.run("getMeta()");   // the first one records first_use_date, so it differs from any later one
  const plain = strip(rt.run("getMeta()"));
  const memo = strip(rt.run("ROWS_MEMO_ = {}; var __m = getMeta(); ROWS_MEMO_ = null; __m"));
  assert.deepEqual(memo, plain);
});
