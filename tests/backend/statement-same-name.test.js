// Files picked on the Bank statements / Import screen are told apart by their card, never by their name: Interbank's app names every
// statement "account_sumary.pdf", and three accounts picked together counted as one (two were silently left out of the preview).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const stm = fs.readFileSync(path.join(__dirname, "../../docs/statements.js"), "utf8");

test("each picked file gets its own slot, and the ready count, re-reads and Remove use it", () => {
  assert.match(stm, /function readyCount\(\) \{ return new Set\(usable\.map\(slotOf\)\)\.size; \}/);
  assert.match(stm, /function resultCardShell[\s\S]*?const slot = "s" \+ \(\+\+slotSeq\);[\s\S]*?removeResultCard\(card, slot\)[\s\S]*?body\.dataset\.slot = slot;/);
  assert.match(stm, /usable\.push\(\{ file: file\.name, slot, result,/);
  assert.match(stm, /usable\.push\(\{ file: r\.name, group: file\.name, slot, result:/);
  // Nothing matches a reading by its file name any more.
  assert.doesNotMatch(stm, /\(u\.group \|\| u\.file\) [!=]== (file\.name|fileName)/);
});
