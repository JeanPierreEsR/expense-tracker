// Statements by month: accounts as rows, months as columns; a month between two statements with none is a hole. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("one column per month, a count where a statement ends, holes between first and last", () => {
  const { rt } = freshApp({ small: true });
  const row = (key, label, end, extra) => Object.assign({ account_key: key, account_label: label, kind: "visa", period_start: end.slice(0, 8) + "01", period_end: end, file_name: "f.pdf", processed_at: "2026-10-01", lines_total: 3, verified: true }, extra || {});
  rt.api("admin_seedStatementUploads", { rows: [
    row("1111", "Card A", "2026-05-20"),
    row("1111", "Card A", "2026-07-20"),
    row("2222", "Card B", "2026-06-28"),
    row("2222", "Card B", "2026-07-28"),
  ] });
  const m = rt.api("getStatementMonthMatrix", {});
  assert.deepEqual(m.months, ["2026-05", "2026-06", "2026-07"]);
  const a = m.accounts.find((x) => x.key === "1111");
  assert.equal(a.cells["2026-05"], 1);
  assert.equal(a.cells["2026-06"], undefined, "June is the hole");
  assert.equal(a.first, "2026-05");
  assert.equal(a.last, "2026-07");
  const b = m.accounts.find((x) => x.key === "2222");
  assert.equal(b.cells["2026-06"], 1);
  assert.equal(b.cells["2026-07"], 1);
});

test("nothing added yet gives an empty table", () => {
  const { rt } = freshApp({ small: true });
  const m = rt.api("getStatementMonthMatrix", {});
  assert.deepEqual(m.months, []);
  assert.deepEqual(m.accounts, []);
});
