// The one-calendar start/end picker (2026-10-19): what a tap on a day does, and that every start/end pair
// in the page now uses it. The pure rule is pulled out of docs/app.js and run on its own; the screen
// behaviour was checked in a real browser on the test app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "index.html"), "utf8");
const rangeTap_ = new Function(`${/function rangeTap_[\s\S]*?\n}\n/.exec(src)[0]}; return rangeTap_;`)();

test("the first tap sets the start; a later day sets the end; the same day twice is a one-day range", () => {
  let s = rangeTap_({ start: "", end: "" }, "2026-10-10");
  assert.deepEqual(s, { start: "2026-10-10", end: "" });
  assert.deepEqual(rangeTap_(s, "2026-10-16"), { start: "2026-10-10", end: "2026-10-16" });
  assert.deepEqual(rangeTap_(s, "2026-10-10"), { start: "2026-10-10", end: "2026-10-10" });
});

test("a day BEFORE the start becomes the new start (the end can never precede it)", () => {
  assert.deepEqual(rangeTap_({ start: "2026-10-10", end: "" }, "2026-10-03"), { start: "2026-10-03", end: "" });
});

test("tapping again after a finished range starts over with just a start", () => {
  assert.deepEqual(rangeTap_({ start: "2026-10-10", end: "2026-10-16" }, "2026-10-20"), { start: "2026-10-20", end: "" });
  assert.deepEqual(rangeTap_({ start: "2026-10-10", end: "2026-10-16" }, "2026-10-12"), { start: "2026-10-12", end: "" });
});

test("every start/end pair in the page is one calendar field, not two native date inputs", () => {
  for (const [start, end] of [["custom-start", "custom-end"], ["export-start", "export-end"], ["trip-start", "trip-end"], ["recurring-start-date", "recurring-end-date"]]) {
    assert.ok(src.includes(`startId: "${start}", endId: "${end}"`), `${start}/${end} must be attached to the range picker`);
    assert.ok(!html.includes(`<label for="${start}"`) && !html.includes(`<label for="${end}"`), `${start}/${end} must not keep two separate labels`);
  }
});
