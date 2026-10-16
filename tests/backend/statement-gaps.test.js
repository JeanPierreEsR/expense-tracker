// Statement gap notes: setting a balance from a statement saves whatever
// difference the review could not explain as a NOTE (own sheet, never an entry).
// Every non-zero amount is kept — even a cent — and nothing here may touch
// entries, totals or balances.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const D = "2026-08-31";

function setup() {
  const { rt, data } = freshApp({ entries: 100 });
  const pm = data.pms[3];
  const stmt = (closing = 1000) => ({
    key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-08-01", end: D },
    balances: { PEN: { closing } }, file_name: "x.pdf", lines: []
  });
  const apply = (extra, closing) => JSON.parse(rt.run(`JSON.stringify(applyStatementDecisions(${JSON.stringify({
    dryRun: false, filename: "x", statements: [stmt(closing)],
    actions: [{ type: "set_balance", stmt: 0, currency: "PEN", ...extra }]
  })}))`));
  const gaps = () => rt.api("listStatementGaps");
  return { rt, data, pm, apply, gaps };
}

test("a leftover difference is saved as an open gap note", () => {
  const { rt, pm, apply, gaps } = setup();
  const entriesBefore = rt.rows("Entries").length;
  const res = apply({ gap: -12.4, app_balance: 1012.4 });
  assert.equal(res.gapsRecorded.length, 1);
  const g = gaps().gaps;
  assert.equal(g.length, 1);
  assert.equal(g[0].gap, -12.4);
  assert.equal(g[0].status, "open");
  assert.equal(g[0].currency, "PEN");
  assert.equal(g[0].period_end, D);
  assert.equal(g[0].closing, 1000);
  assert.equal(g[0].app_balance, 1012.4);
  assert.equal(g[0].account_label, pm.nickname);
  assert.equal(gaps().open, 1);
  assert.equal(rt.rows("Entries").length, entriesBefore, "a gap is never an entry");
});

test("any amount is kept, even a cent; zero and a missing figure make no note", () => {
  const a = setup(); a.apply({ gap: 0.01 });
  assert.equal(a.gaps().gaps.length, 1);
  assert.equal(a.gaps().gaps[0].gap, 0.01);
  const b = setup(); b.apply({ gap: 0 });
  assert.equal(b.gaps().gaps.length, 0);
  const c = setup(); c.apply({});
  assert.equal(c.gaps().gaps.length, 0);
  const d = setup(); d.apply({ gap: 0.004 });   // rounds to zero
  assert.equal(d.gaps().gaps.length, 0);
});

test("a gap note does not change the balance the app shows", () => {
  const { pm, rt, apply } = setup();
  apply({ gap: 55.5, app_balance: 944.5 });
  const bal = rt.api("listPaymentMethodBalances").find((b) => b.id === pm.id).balances.find((x) => x.currency === "PEN").amount;
  assert.equal(bal, 1000);
});

test("a dry run saves nothing but reports the gap it would note", () => {
  const { rt, pm, gaps } = setup();
  const res = JSON.parse(rt.run(`JSON.stringify(applyStatementDecisions(${JSON.stringify({
    dryRun: true, statements: [{ key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-08-01", end: D }, balances: { PEN: { closing: 1000 } }, lines: [] }],
    actions: [{ type: "set_balance", stmt: 0, currency: "PEN", gap: 3 }]
  })}))`));
  assert.equal(res.gapsRecorded.length, 1);
  assert.equal(gaps().gaps.length, 0);
});

test("resolving and reopening a gap; open ones sort first", () => {
  const { rt, pm, gaps } = setup();
  const statement = (end) => ({ key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-01-01", end }, balances: { PEN: { closing: 500 } }, lines: [] });
  const apply = (end, gap) => rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, statements: [statement(end)], actions: [{ type: "set_balance", stmt: 0, currency: "PEN", gap }] })})`);
  apply("2026-06-30", 5);
  apply("2026-07-31", -7);
  const first = gaps().gaps;
  assert.deepEqual(first.map((g) => g.period_end), ["2026-07-31", "2026-06-30"], "newest statement first");
  rt.api("resolveStatementGap", { id: first[0].id, note: "forgot a taxi" });
  const after = gaps();
  assert.equal(after.open, 1);
  assert.equal(after.gaps[0].period_end, "2026-06-30", "the open one is now first");
  const done = after.gaps[1];
  assert.equal(done.status, "resolved");
  assert.equal(done.note, "forgot a taxi");
  assert.ok(done.resolved_at);
  rt.api("resolveStatementGap", { id: done.id, resolved: false });
  assert.equal(gaps().open, 2);
  assert.equal(gaps().gaps.find((g) => g.id === done.id).resolved_at, "");
  assert.throws(() => rt.api("resolveStatementGap", { id: "nope" }), /not found/i);
});

test("the coverage list counts open gaps per account", () => {
  const { rt, pm, apply } = setup();
  apply({ gap: 2 });
  const cov = rt.api("listStatementCoverage");
  const row = cov.accounts.find((a) => a.key === String(pm.last_4).padStart(4, "0"));
  assert.equal(row.open_gaps, 1);
  rt.api("resolveStatementGap", { id: rt.api("listStatementGaps").gaps[0].id });
  assert.equal(rt.api("listStatementCoverage").accounts.find((a) => a.key === row.key).open_gaps, 0);
});

test("undoing the upload removes the gap notes it created", () => {
  const { rt, apply, gaps } = setup();
  const res = apply({ gap: 9 });
  assert.equal(gaps().gaps.length, 1);
  rt.run(`undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(gaps().gaps.length, 0);
});
