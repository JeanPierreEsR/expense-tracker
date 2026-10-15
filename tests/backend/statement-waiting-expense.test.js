// A statement line that looks like a transfer or card payment but has no other side
// is held as "waiting". It can really be an ordinary purchase (a payment-app charge
// such as "MDOPAGO*..."), so the owner can add it as a pending expense instead.
// Lines below are made up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const D = "2026-08-31";

test("a waiting line can be added as a pending expense", () => {
  const { rt, data } = freshApp({ entries: 200 });
  const pm = data.pms[3];
  const stmt = {
    key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-08-01", end: D },
    balances: { PEN: { closing: 1000 } }, file_name: "x.pdf",
    lines: [{ date: "2026-08-14", description: "TRANSFERENCIA A OTRA CUENTA 0001", amount: -154, currency: "PEN" }]
  };
  const analysis = JSON.parse(rt.run(`JSON.stringify(analyzeStatements(${JSON.stringify({ statements: [stmt] })}))`));
  const line = analysis.statements[0].lines[0];
  assert.equal(line.waiting, true, "held as waiting, not a purchase");

  const expenseCat = data.cats.find((c) => c.type === "expense");
  const res = JSON.parse(rt.run(`JSON.stringify(applyStatementDecisions(${JSON.stringify({
    dryRun: false, filename: "x", statements: [stmt],
    actions: [{ type: "add_purchase", stmt: 0, line: 0, category: expenseCat.id }]
  })}))`));
  assert.equal(res.created.purchases, 1);
  const made = JSON.parse(rt.run("JSON.stringify(getAllRows('Entries').filter(function (e) { return String(e.external_id).indexOf('stmt-') === 0; }))"));
  assert.equal(made.length, 1);
  assert.equal(made[0].type, "expense");
  assert.equal(made[0].status, "pending");
  assert.equal(Number(made[0].amount), 154);
});
