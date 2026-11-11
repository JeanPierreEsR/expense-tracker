// The first statement after a starting balance checks it (owner's plan, 2026-11-11, step 3). (a) What is left unexplained equals, to the
// cent, recent entries the balance took as already in the bank: offered as a correction ("count them after it"), saved with the
// statement, undone with it. (b) A purchase inside the balance that the card charged differently: taking the bank's amount also moves the
// starting balance by the difference. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta Prueba", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const add = (date, amount, description, merchant) => {
    const id = rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date, amount, currency: "PEN", description, paid_by: "me", payment_method_id: card.id } }).id;
    if (merchant) rt.run(`updateRowFields_('Entries', ${JSON.stringify(id)}, { merchant: ${JSON.stringify(merchant)} })`);
    return id;
  };
  const stmt = (closing, lines) => ({ key: "8765", kind: "sip", verified: true, period: { start: "2019-03-01", end: "2019-03-31" },
    balances: { PEN: { closing } }, file_name: "c.pdf", lines });
  return { rt, card, add, stmt };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "c", statements, actions })})`);
const opening = (rt, pmId) => run(rt, `buildOpeningsByPm_(getAllRows('Payment Methods'))[${JSON.stringify(pmId)}][0]`);

test("an entry the starting balance wrongly took as inside is offered as the correction, and saving it closes the gap; Undo puts it back", () => {
  const { rt, card, add, stmt } = setup();
  add("2019-03-08", 10.00, "Cafe Uno");
  const pay = add("2019-03-10", 42.50, "Tienda Dos");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  // the bank: −100 typed, but the 42.50 had not posted yet → −142.50 at the end
  const s = stmt(-142.50, [{ date: "2019-03-10", description: "TIENDA DOS", amount: -42.50, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.unexplained, -42.5);
  assert.ok(c.startFix, "a correction is offered");
  assert.deepEqual(c.startFix.items.map((i) => i.id), [pay]);
  const res = save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: [pay] }]));
  assert.equal(res.startFixes, 1);
  assert.deepEqual(opening(rt, card.id).not_yet, [pay]);
  assert.equal(plan(rt, [s]).balance_checks[0].diff, 0, "read again: the app now agrees with the statement");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.deepEqual(opening(rt, card.id).not_yet, []);
});

test("two entries that would both fit: nothing is offered", () => {
  const { rt, card, add, stmt } = setup();
  add("2019-03-09", 42.50, "Tienda Dos");
  add("2019-03-10", 42.50, "Tienda Tres");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  const c = plan(rt, [stmt(-142.50, [])]).balance_checks[0];
  assert.equal(c.unexplained, -42.5);
  assert.equal(c.startFix, undefined);
});

test("a purchase inside the starting balance charged less: the bank's amount also moves the starting balance", () => {
  const { rt, card, add, stmt } = setup();
  const pv = add("2019-03-09", 50.00, "PV", "agora shop");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  // the balance was typed with the 50.00 in it; the card charged 45.00 → the real debt is 95.00
  const s = stmt(-95, [{ date: "2019-03-09", description: "AGORA SHOP COMPANIA FO", amount: -45.00, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.deepEqual(c.startShift, { net: 5, lines: 1 });
  assert.equal(c.unexplained, 0);
  assert.ok(p.actions.some((a) => a.type === "use_bank_amount"));
  const res = save(rt, [s], p.actions);
  assert.equal(Number(rt.rows("Entries").find((e) => e.id === pv).amount), 45);
  assert.equal(opening(rt, card.id).amount, -95);
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(opening(rt, card.id).amount, -100);
  assert.equal(Number(rt.rows("Entries").find((e) => e.id === pv).amount), 50);
});

test("a picked suggestion on a purchase inside the starting balance is marked for the screen", () => {
  const { rt, card, add, stmt } = setup();
  const pv = add("2019-03-09", 50.00, "PV", "agora shop");   // 41.50 is 17% lower: a suggestion
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  const p = plan(rt, [stmt(-91.5, [{ date: "2019-03-09", description: "AGORA SHOP COMPANIA FO", amount: -41.50, currency: "PEN" }])]);
  const d = p.summary.discounts[0];
  assert.equal(d.clear, false);
  assert.equal(d.options.find((o) => o.id === pv).insideStart, true);
  assert.equal(p.balance_checks[0].startFix, undefined, "the purchase is not offered as 'not yet': it is a charged-less pair");
});
