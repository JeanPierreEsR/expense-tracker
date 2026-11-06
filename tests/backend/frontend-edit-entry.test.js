// Opening an entry to edit (docs/app.js, startEditEntry): nothing can be saved until its splits and tags have arrived, and a saved
// equal split reopens as Equal. Clicked through in a real browser on the test app; this guards the code.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const start = /async function startEditEntry[\s\S]*?\n}\n/.exec(src)[0];

test("the form says Loading until splits and tags are in, and the trip is set only after", () => {
  const loading = start.indexOf('setEntryLoading_(!Array.isArray(entry.tagIds)');
  const wait = start.indexOf("await Promise.all([splitsPromise || [], tagsPromise])");
  const ready = start.indexOf('setEntryLoading_("");');
  const trip = start.indexOf("setTripPick_(entry.trip_id)");
  assert.ok(loading > 0 && wait > loading && ready > wait && trip > ready, "loading → wait → form → trip");
  assert.match(start, /catch \(err\) \{\s*if \(loadSeq === entryLoadSeq_\) setEntryLoading_\("failed"\);\s*return;/, "a failed load keeps the form closed");
  assert.match(start, /if \(loadSeq !== entryLoadSeq_\) return;/, "an answer for a closed entry is ignored");
  assert.match(src, /classList\.contains\("entry-loading"\)\) \{ e\.preventDefault\(\); return; \}/, "Save refuses while loading");
});

test("amounts that are exactly an equal split reopen as Equal; anything else as Custom", () => {
  assert.match(start, /computeEqualShares\(Number\(entry\.amount\), splits\.map/);
  assert.match(start, /splitMode = splits\.every\(.*\) \? "equal" : "custom"/);
});

test("turning an automatic split off forgets its friend, and the next payer is always in", () => {
  const fn = /function applyPaidByDefaultSplit_[\s\S]*?\n}\n/.exec(src)[0];
  assert.match(fn, /splitFriendIds\.size === 1 && splitFriendIds\.has\(paidByAutoSplit_\)\) splitFriendIds\.delete\(paidByAutoSplit_\)/);
  assert.match(fn, /splitFriendIds\.add\(paidBy\);\s*\/\/ whoever paid/);
});

test("the Transfer form's overpayment category starts on Decide later, and a conversion may leave it there", () => {
  const app = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "docs", "app.js"), "utf8");
  const block = /const overpaySel = [\s\S]*?overpaySel\.value = "";/.exec(app)[0];
  assert.ok(block.includes('tr("reassign.limitLater")') && block.includes("overpaySel.prepend(overpayLater)"));
  assert.ok(app.includes("overpay_pending_ok: !overpayCategoryId"), "without it the server refuses a conversion with no category");
});
