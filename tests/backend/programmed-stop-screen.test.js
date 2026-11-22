// Programmed items screen rules from the owner's first hands-on test (2026-11-02): when a stopped item counts as ended, the sentence about
// skipped months, and the wording that keeps "delete the programmed item" apart from "delete the entries". The pure rules are pulled out of
// docs/app.js; the screens were checked in a real browser on the test app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "app.js"), "utf8");
const strings = fs.readFileSync(path.join(__dirname, "..", "..", "docs", "strings.js"), "utf8");
const grab = (name) => new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`).exec(src)[0];
const pad2 = (n) => String(n).padStart(2, "0");
const rules = new Function("pad2", "todayLocalISO", `${grab("nextOccurrenceDate_")}${grab("recurringHasEnded_")}${grab("recurringIsPast_")}; return { next: nextOccurrenceDate_, ended: recurringHasEnded_, past: recurringIsPast_ };`)(pad2, () => "2026-11-02");

const rent = { frequency: "monthly", day: 1, active: true };

test("a monthly item stopped on a day with no payment left before it is ended at once, not tomorrow", () => {
  // the 1st has passed, so the next payment (1 Dec) is after the last day (2 Nov): nothing more is due
  assert.equal(rules.past({ ...rent, end_date: "2026-11-02" }, "2026-11-02"), true);
  assert.equal(rules.ended({ ...rent, end_date: "2026-11-01" }, "2026-11-02"), true);
});

test("an end date that still has a payment due before it keeps the item running", () => {
  assert.equal(rules.past({ ...rent, end_date: "2026-12-01" }, "2026-11-02"), false);   // 1 Dec is still to come
  assert.equal(rules.past({ ...rent, day: 2, end_date: "2026-11-02" }, "2026-11-02"), false);   // due today, end date today
  assert.equal(rules.past({ ...rent, day: 20, end_date: "2026-11-25" }, "2026-11-02"), false);
});

test("yearly items follow the same rule; items without an end date never end; one-time items keep their own rule", () => {
  const insurance = { frequency: "yearly", day: 2, month: 4, active: true };
  assert.equal(rules.past({ ...insurance, end_date: "2026-11-10" }, "2026-11-02"), true);   // the next one, 2 Apr 2027, is after the last day
  assert.equal(rules.past({ ...insurance, end_date: "2027-04-02" }, "2026-11-02"), false);   // 2 Apr 2027 is still due
  assert.equal(rules.past(rent, "2026-11-02"), false);
  assert.equal(rules.past({ frequency: "once", date: "2026-10-01", paid: true }, "2026-11-02"), true);
  assert.equal(rules.past({ frequency: "once", date: "2026-10-01", paid: false }, "2026-11-02"), false);
});

test("the next payment rolls over the year end and clamps a 31st to the end of a short month", () => {
  assert.equal(rules.next("monthly", 5, 0, "2026-12-20"), "2027-01-05");
  assert.equal(rules.next("monthly", 31, 0, "2026-02-10"), "2026-02-28");
  assert.equal(rules.next("yearly", 2, 4, "2026-04-03"), "2027-04-02");
});

test("the delete questions say the entries are not deleted, and the skipped-months sentence is conditional", () => {
  assert.match(strings, /"recModal\.confirmDelete":[^\n]*Only the item goes: the entries you recorded are not deleted\.\{skipped\}/);
  assert.match(strings, /"recBulk\.confirmMany":[^\n]*\{skipped\}/);
  assert.ok(!/"recModal\.confirmDelete":[^\n]*Its skipped months go with it/.test(strings), "no fixed skipped-months claim");
  assert.match(src, /const skippedGoneText_ = \(items\) =>/);
});

test("stopping and deleting show a status until the work is done, and say who was affected", () => {
  assert.match(src, /busy: "common\.deletingToast"/);
  assert.match(src, /busy: "common\.stoppingToast"/);
  assert.match(strings, /"common\.deletingToast"/);
  assert.match(strings, /"common\.stoppingToast"/);
  assert.match(strings, /"friends\.resultDeleted":[^\n]*\{names\}/);
});
