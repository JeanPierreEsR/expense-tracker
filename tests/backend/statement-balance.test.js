// Statement balance timing: a balance set from a statement closing on day D is a
// snapshot of everything the statement covers. An entry dated D that the
// statement itself covers (matched to one of its lines, or recorded from one)
// must not be subtracted again just because it was logged after the snapshot's
// moment (persona finding A10, 2026-10-05).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const D = "2026-08-31";
const J = (rt, code) => JSON.parse(rt.run(`JSON.stringify(${code})`));

function setup() {
  const { rt, data } = freshApp({ entries: 200 });
  const pm = data.pms[3];
  const balance = () => rt.api("listPaymentMethodBalances").find((b) => b.id === pm.id).balances.find((x) => x.currency === "PEN").amount;
  const stmt = (lines, closing = 1000) => ({
    key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-08-01", end: D },
    balances: { PEN: { closing } }, file_name: "x.pdf", lines
  });
  const apply = (statements, actions) =>
    rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "x", statements, actions })})`);
  const expense = (date, createdAt, amount = 50) => {
    const e = rt.api("createEntry", { type: "expense", date, amount, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", paid_by: "me", payment_method_id: pm.id });
    rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'created_at', ${JSON.stringify(createdAt)})`);
    return e;
  };
  const snapshot = (amount = 1000) => rt.run(`addOpeningRow_(${JSON.stringify(pm.id)}, 'PEN', ${amount}, '${D}', '${D}T23:59:59')`);
  return { rt, data, pm, balance, stmt, apply, expense, snapshot };
}

test("the real statement import: a fee dated on the closing day is not subtracted again", () => {
  const { balance, stmt, apply } = setup();
  const s = stmt([{ date: D, description: "ITF IMPUESTO ITF", amount: -0.5, currency: "PEN" }]);
  apply([s], [{ type: "record_fee", stmt: 0, line: 0 }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 1000);
});

test("a transfer recorded from a closing-day line is not subtracted again either", () => {
  const { rt, data, pm, balance, stmt, apply } = setup();
  const other = data.pms[5];
  const s = stmt([{ date: D, description: "TRANSFER OUT", amount: -200, currency: "PEN" }]);
  const s2 = { ...stmt([{ date: D, description: "TRANSFER IN", amount: 200, currency: "PEN" }]), key: other.last_4 };
  apply([s, s2], [{ type: "record_transfer", out: { stmt: 0, line: 0 }, in: { stmt: 1, line: 0 } }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 1000);
});

test("an existing entry dated on the closing day, logged later, then matched to a statement line, is not counted again", () => {
  const { balance, stmt, apply, expense } = setup();
  const e = expense(D, "2026-09-02T10:00:00", 50);
  const s = stmt([{ date: D, description: "PURCHASE", amount: -50, currency: "PEN" }]);
  apply([s], [{ type: "match", stmt: 0, line: 0, entryId: e.id }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 1000);
});

test("without a statement line covering it, a late-logged entry dated on the closing day still counts (unchanged)", () => {
  const { balance, stmt, apply, expense } = setup();
  const s = stmt([]);
  apply([s], [{ type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 1000);
  expense(D, "2026-09-02T10:00:00", 50);       // not on the statement as far as the app knows
  assert.equal(balance(), 950);
});

test("an entry logged on the day, before the statement closed, is inside the balance (unchanged)", () => {
  const { balance, snapshot, expense } = setup();
  snapshot();
  expense(D, "2026-08-31T20:00:00", 50);
  assert.equal(balance(), 1000);
});

test("entries dated AFTER the closing day always count, even if a line was matched to them", () => {
  const { balance, stmt, apply, expense } = setup();
  const e = expense("2026-09-01", "2026-09-01T09:00:00", 40);
  const s = stmt([{ date: "2026-09-01", description: "NEXT DAY", amount: -40, currency: "PEN" }]);
  apply([s], [{ type: "match", stmt: 0, line: 0, entryId: e.id }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 960);
});

test("an IGNORED statement line does not hide an entry from the balance", () => {
  const { balance, stmt, apply, expense } = setup();
  const e = expense(D, "2026-09-02T10:00:00", 50);
  const s = stmt([{ date: D, description: "SOMETHING", amount: -50, currency: "PEN" }]);
  apply([s], [{ type: "ignore", stmt: 0, line: 0 }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  assert.equal(balance(), 950, "ignored = not matched to this entry, so it is not known to be inside the statement");
});

test("the balance check at the statement's end agrees with the displayed balance", () => {
  const { rt, pm, stmt, apply, expense } = setup();
  const e = expense(D, "2026-09-02T10:00:00", 50);
  const s = stmt([{ date: D, description: "PURCHASE", amount: -50, currency: "PEN" }]);
  apply([s], [{ type: "match", stmt: 0, line: 0, entryId: e.id }, { type: "set_balance", stmt: 0, currency: "PEN" }]);
  const at = J(rt, `(function () {
    var openings = buildOpeningsByPm_(getAllRows('Payment Methods'))[${JSON.stringify(pm.id)}];
    var op = openingForCurrency_(openings, 'PEN');
    var confirmed = getAllRows('Entries').filter(function (x) { return x.status === 'confirmed'; });
    return stmtBalanceAt_(${JSON.stringify(pm.id)}, 'PEN', '${D}', op, confirmed, buildInboundTransferIds_());
  })()`);
  assert.equal(at, 1000);
});
