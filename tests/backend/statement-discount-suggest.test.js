// Discount suggestions (owner, 2026-11-11): a card charge more than 15% and up to 30% lower than a purchase in the app is only SUGGESTED
// (never ticked), and only after every other matching method. Up to 15% stays pre-filled; over 30% is nothing. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta Prueba", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const add = (date, amount, merchant, opts) => {
    const id = rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "expense", date, amount, currency: "PEN", description: "PV", paid_by: "me",
      payment_method_id: card.id }, opts || {}) }).id;
    rt.run(`updateRowFields_('Entries', ${JSON.stringify(id)}, { merchant: ${JSON.stringify(merchant)} })`);
    return id;
  };
  const stmt = (lines) => ({ key: "8765", kind: "sip", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "c.pdf", lines });
  return { rt, card, add, stmt };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "c", statements, actions })})`);

test("16.5% lower is suggested, not ticked; picking it saves the bank's amount", () => {
  const { rt, add, stmt } = setup();
  const pv = add("2019-03-06", 134.58, "agora shop");
  const s = stmt([{ date: "2019-03-06", description: "AGORA SHOP COMPANIA FO", amount: -112.33, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.discounts.length, 1);
  const d = p.summary.discounts[0];
  assert.equal(d.suggested, true);
  assert.equal(d.clear, false);
  assert.equal(d.entryId, "", "never pre-filled");
  assert.deepEqual(d.options.map((o) => o.id), [pv]);
  assert.ok(!p.actions.some((a) => a.type === "use_bank_amount" || a.type === "add_history_expense"), "nothing happens until the person picks");
  const res = save(rt, [s], [{ type: "use_bank_amount", stmt: 0, line: 0, entryId: pv }]);
  assert.equal(res.discounts, 1);
  assert.equal(Number(rt.rows("Entries").find((e) => e.id === pv).amount), 112.33);
});

test("up to 15% stays pre-filled, and over 30% is not suggested at all", () => {
  const { rt, add, stmt } = setup();
  add("2019-03-10", 100, "agora shop");   // 10% lower: pre-filled
  add("2019-03-20", 100, "agora shop");   // 35% lower: nothing
  const p = plan(rt, [stmt([
    { date: "2019-03-10", description: "AGORA SHOP COMPANIA FO", amount: -90, currency: "PEN" },
    { date: "2019-03-20", description: "AGORA SHOP COMPANIA FO", amount: -65, currency: "PEN" }
  ])]);
  assert.equal(p.summary.discounts.length, 1);
  assert.equal(p.summary.discounts[0].clear, true);
  assert.ok(!p.summary.discounts[0].suggested);
});

test("a suggestion never takes a purchase another method already explained", () => {
  const { rt, add, stmt } = setup();
  const pv = add("2019-03-06", 120, "agora shop");
  // the exact line takes the purchase; the other, 20% lower, is NOT suggested against it
  const p = plan(rt, [stmt([
    { date: "2019-03-06", description: "AGORA SHOP COMPANIA FO", amount: -120, currency: "PEN" },
    { date: "2019-03-07", description: "AGORA SHOP COMPANIA FO", amount: -96, currency: "PEN" }
  ])]);
  assert.equal(p.summary.discounts.length, 0);
  assert.ok(p.actions.some((a) => a.entryId === pv), "the exact match keeps it");
});
