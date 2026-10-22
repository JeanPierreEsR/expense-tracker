// Undoing a statement upload on a REAL Google Sheet stopped half-way (found 2026-10-22 on the spare account): the entries were
// deleted one row at a time (a round trip to Google each, minutes in all), longer than the app waits, and the bookkeeping that
// lists the upload was removed first — so the entries stayed and there was no Undo button left. Lines below are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function bigUpload(n) {
  const { rt, data } = freshApp({ entries: 60 });
  const savings = data.pms.find((p) => p.type === "debit");
  const stmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1 } }, file_name: "big.pdf",
    lines: Array.from({ length: n }, (_, i) => ({ date: "2019-03-" + String(1 + (i % 28)).padStart(2, "0"), description: "COMPRA TIENDA " + i, amount: -(10 + i + 0.37), currency: "PEN" }))
  };
  const plan = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  const res = run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "big", statements: [stmt], actions: plan.actions })})`);
  return { rt, stmt, res };
}
const batchEntries = (rt, id) => run(rt, `getAllRows('Entries').filter(function (e) { return e.import_batch_id === ${JSON.stringify(id)}; }).length`);

test("undoing a 180-entry upload takes a handful of sheet calls, not one per row", () => {
  const { rt, res } = bigUpload(180);
  assert.equal(batchEntries(rt, res.batchId), 180);
  rt.resetStats();
  const undone = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(undone.deletedEntries, 180);
  assert.equal(batchEntries(rt, res.batchId), 0);
  assert.ok(rt.stats.rowDeletes <= 10, `row-delete calls: ${rt.stats.rowDeletes} (was one per row: 180+)`);
});

test("an Undo that is cut short can be tapped again: the upload stays listed until everything is done", () => {
  const { rt, res } = bigUpload(40);
  // Make the bookkeeping step fail, as a timeout would.
  rt.run(`var __orig = deleteRowsWhere_; deleteRowsWhere_ = function (name, p) { if (name === 'Statement Lines') throw new Error('timed out'); return __orig(name, p); };`);
  assert.throws(() => rt.run(`undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`), /timed out/);
  assert.equal(batchEntries(rt, res.batchId), 0, "the entries went first");
  const listed = run(rt, "listStatementBatches()");
  assert.equal(listed.filter((b) => b.batchId === res.batchId).length, 1, "the upload is still in Recent uploads");
  // Try again with the sheet behaving.
  rt.run("deleteRowsWhere_ = __orig;");
  run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(run(rt, "listStatementBatches()").length, 0, "now it is gone");
  assert.equal(run(rt, "getAllRows('Statement Lines').length"), 0);
});

test("undoing the FIRST import (every row on the sheets) works: Google refuses to delete all non-frozen rows", () => {
  // Found on the owner's spare account 2026-10-22: "No se pueden eliminar todas las filas que no estén inmovilizadas" left one
  // entry behind. The fake Sheet now enforces the same rule on sheets that have no spare blank rows.
  const { rt, data } = freshApp({ entries: 60 });
  rt.run("deleteRowsWhere_('Entries', function () { return true; })");   // a brand-new account has no entries
  const savings = data.pms.find((p) => p.type === "debit");
  const stmt = {
    key: savings.last_4, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { closing: 1 } }, file_name: "first.pdf",
    lines: Array.from({ length: 12 }, (_, i) => ({ date: "2019-03-" + String(1 + i).padStart(2, "0"), description: "COMPRA TIENDA " + i, amount: -(10 + i + 0.37), currency: "PEN" }))
  };
  const plan = run(rt, `planStatementHistory(${JSON.stringify({ statements: [stmt] })})`);
  const res = run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "first", statements: [stmt], actions: plan.actions })})`);
  assert.equal(batchEntries(rt, res.batchId), 12);
  ["Entries", "Statement Lines", "Statement Uploads", "Import Batches", "Statement Changes"].forEach((name) => { rt.run(`getSheet('${name}')`).tightRows = true; });
  const undone = run(rt, `undoStatementBatch(${JSON.stringify({ batchId: res.batchId })})`);
  assert.equal(undone.deletedEntries, 12);
  assert.equal(run(rt, "getAllRows('Entries').length"), 0, "every entry is gone, including the last row");
  assert.equal(run(rt, "listStatementBatches()").length, 0);
  assert.equal(run(rt, "getAllRows('Statement Lines').length"), 0);
});

test("deleting the ONLY entry of an account works on a sheet with no spare rows", () => {
  const { rt } = freshApp({ entries: 60 });
  const keep = run(rt, "getAllRows('Entries')[0].id");
  rt.run(`var __keep = ${JSON.stringify(keep)}; deleteRowsWhere_('Entries', function (r) { return r.id !== __keep; });`);
  assert.equal(run(rt, "getAllRows('Entries').length"), 1);
  const sheet = rt.run("getSheet('Entries')");
  sheet.frozen = 1;
  sheet.tightRows = true;
  rt.run(`deleteEntry_(${JSON.stringify(keep)})`);
  assert.equal(run(rt, "getAllRows('Entries').length"), 0, "Google would have refused to delete the last row without the guard");
});

test("deleting scattered and contiguous rows removes exactly the right ones and keeps the order", () => {
  const { rt } = freshApp({ entries: 60 });
  const ids = run(rt, "getAllRows('Entries').map(function (e) { return e.id; })");
  const kill = new Set([ids[0], ids[1], ids[2], ids[10], ids[20], ids[21], ids[ids.length - 1], ids[ids.length - 2]]);
  const before = ids.length;
  rt.run(`var __kill = ${JSON.stringify(Array.from(kill))}; deleteRowsWhere_('Entries', function (r) { return __kill.indexOf(r.id) !== -1; });`);
  const after = run(rt, "getAllRows('Entries').map(function (e) { return e.id; })");
  assert.equal(after.length, before - kill.size);
  assert.deepEqual(after, ids.filter((id) => !kill.has(id)), "same rows, same order");
});
