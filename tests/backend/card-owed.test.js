// What a card owed at its last statement (owner's plan, 2026-11-17, after the journeys run: Marta never saw what her cards owed).
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("a card with no starting balance shows what its newest statement says it owed, marked as a statement figure", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-card-x', nickname: 'Visa Prueba', type: 'credit', bank_id: '', last_4: '0007', currency: 'PEN' });`);
  rt.run(`ensureStatementUploadsSheet_();`);
  for (const [end, pen] of [["2026-09-26", -800], ["2026-10-26", -1234.5]]) {
    rt.run(`appendRowObject('Statement Uploads', { id: 'su-${end}', account_key: '0007', account_label: 'Visa', payment_method_id: 'pm-card-x', kind: 'visa', period_start: '', period_end: '${end}', closing_json: ${JSON.stringify(JSON.stringify({ PEN: { opening: 0, closing: pen }, USD: { opening: 0, closing: -40 } }))}, source: 'upload' });`);
  }
  const row = rt.api("listPaymentMethodBalances", {}).find((r) => r.id === "pm-card-x");
  assert.equal(row.statement_closed, "2026-10-26");
  assert.deepEqual(row.balances, [{ currency: "PEN", amount: -1234.5 }, { currency: "USD", amount: -40 }]);
});

test("a card that has its own starting balance is not repeated from its statements", () => {
  const { rt } = freshApp({ entries: 10 });
  const rows = rt.api("listPaymentMethodBalances", {});
  assert.ok(rows.every((r) => !r.statement_closed || !(r.openings && r.openings.length)));
});
