// A card statement charged LESS than the purchase in the app (owner, 2026-11-10): the bank's e-mail shows the price, the card applies
// a discount (SIP at Plaza Vea / Agora Shop). Card statements only, 3 days apart at most, at most 15% lower, a distinctive shop word in
// common; clear pairs take the bank's amount by default, else the person picks. Never added as a second purchase. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta Prueba", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const friend = rt.api("addFriend", { name: "Ana Lo " + Math.random().toString(36).slice(2, 6) });
  const add0 = (date, amount, description, opts) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "expense", date, amount,
    currency: "PEN", description, paid_by: "me", payment_method_id: card.id }, (opts && opts.fields) || {}), splits: opts && opts.splits }).id;
  const addM = (date, amount, description, merchant, opts) => {   // the shop's name as a bank e-mail stores it (Entries.merchant)
    const id = add0(date, amount, description, opts);
    rt.run(`updateRowFields_('Entries', ${JSON.stringify(id)}, { merchant: ${JSON.stringify(merchant)} })`);
    return id;
  };
  const stmt = (lines) => ({ key: "8765", kind: "sip", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "c.pdf", lines });
  return { rt, card, friend, add: addM, stmt };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "c", statements, actions })})`);
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("a clear discounted pair takes the bank's amount by default; Undo puts it back", () => {
  const { rt, add, stmt } = setup();
  const pv = add("2019-03-16", 194.30, "PV", "agora shop");
  const s = stmt([{ date: "2019-03-16", description: "AGORA SHOP COMPANIA FO", amount: -193.29, currency: "PEN" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.discounts.length, 1);
  assert.ok(p.summary.discounts[0].clear);
  assert.deepEqual(p.actions.map((a) => a.type), ["use_bank_amount"], "never added as a second purchase");
  const res = save(rt, [s], p.actions, false);
  assert.equal(res.discounts, 1);
  assert.equal(Number(row(rt, pv).amount), 193.29);
  assert.equal(plan(rt, [s]).summary.discounts.length, 0, "read again: the line is already handled");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(Number(row(rt, pv).amount), 194.30);
});

test("limits: more than 15% lower, more than 3 days apart, a higher charge, or only common words do not pair", () => {
  const { rt, add, stmt } = setup();
  add("2019-03-06", 134.58, "PV", "agora shop");          // 112.33 is 16.5% lower
  add("2019-03-10", 50.00, "Primax", "primax alegria");     // 4 days before
  add("2019-03-20", 20.00, "Tambo", "tambo");               // charged MORE
  add("2019-03-25", 40.00, "Shop", "shop lima");            // only common words
  const s = stmt([
    { date: "2019-03-06", description: "AGORA SHOP COMPANIA FO", amount: -112.33, currency: "PEN" },
    { date: "2019-03-14", description: "ESTACION PRIMAX ALEGRIA", amount: -48.00, currency: "PEN" },
    { date: "2019-03-20", description: "TAMBO", amount: -21.00, currency: "PEN" },
    { date: "2019-03-25", description: "SHOP LIMA PERU", amount: -39.00, currency: "PEN" }
  ]);
  const p = plan(rt, [s]);
  // Since 2026-11-11 the 16.5% lower one and the 5% HIGHER one (Tambo) are SUGGESTIONS (never ticked); the others still give nothing.
  assert.deepEqual(p.summary.discounts.map((d) => [d.description, d.suggested, d.clear, !!d.higher]),
    [["AGORA SHOP COMPANIA FO", true, false, false], ["TAMBO", true, false, true]]);
  assert.ok(!p.actions.some((a) => a.type === "use_bank_amount"));
});

test("an exact match always wins, and two possible purchases are left for the person to pick", () => {
  const { rt, add, stmt } = setup();
  const exact = add("2019-03-12", 81.63, "PV", "agora shop");
  const a = add("2019-03-20", 91.80, "PV", "agora shop");
  const b = add("2019-03-21", 92.10, "PV", "agora shop");
  const s = stmt([
    { date: "2019-03-12", description: "AGORA SHOP COMPANIA FO", amount: -81.63, currency: "PEN" },
    { date: "2019-03-20", description: "AGORA SHOP COMPANIA FO", amount: -90.11, currency: "PEN" }
  ]);
  const p = plan(rt, [s]);
  assert.ok(p.actions.some((x) => x.entryId === exact && x.type !== "use_bank_amount"), "the exact one is a plain match");
  assert.equal(p.summary.discounts.length, 1);
  const d = p.summary.discounts[0];
  assert.equal(d.clear, false);
  assert.deepEqual(d.options.map((o) => o.id).sort(), [a, b].sort());
  assert.ok(!p.actions.some((x) => x.type === "use_bank_amount"), "nothing ticked by itself");
  assert.ok(!p.actions.some((x) => x.type === "add_history_expense"), "and not added as a purchase either");
});

test("savings statements, other cards and purchases a friend paid are never paired", () => {
  const { rt, add, stmt } = setup();
  const savings = rt.api("savePaymentMethod", { nickname: "Ahorro Prueba", type: "debit", currencies: ["PEN"], last_4: "1357" });
  add("2019-03-16", 194.30, "PV", "agora shop", { fields: { paid_by: "" } });
  const onSavings = { key: "1357", kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "s.pdf",
    lines: [{ date: "2019-03-16", description: "AGORA SHOP COMPANIA FO", amount: -193.29, currency: "PEN" }] };
  assert.equal(plan(rt, [onSavings]).summary.discounts.length, 0, "only card statements");
  assert.ok(savings.id);
});

test("a shared purchase's split shrinks in the same proportion, and Undo restores it", () => {
  const { rt, add, friend, stmt } = setup();
  const pv = add("2019-03-16", 200.00, "PV", "agora shop", { splits: [{ friend_id: friend.id, amount: 100 }] });
  const s = stmt([{ date: "2019-03-16", description: "AGORA SHOP COMPANIA FO", amount: -180.00, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const res = save(rt, [s], p.actions, false);
  assert.equal(Number(row(rt, pv).amount), 180);
  assert.equal(Number(rt.rows("Entry Splits").find((x) => x.entry_id === pv).amount), 90);
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(Number(row(rt, pv).amount), 200);
  assert.equal(Number(rt.rows("Entry Splits").find((x) => x.entry_id === pv).amount), 100);
});

test("the balance check counts a clear discount as 'charged less', not as a missing line", () => {
  const { rt, add, card } = setup();
  const pv = add("2019-03-16", 194.30, "PV", "agora shop");
  const e = row(rt, pv);
  const args = { pm: { id: card.id, nickname: "Tarjeta Prueba" }, currency: "PEN", closing: -193.29, start: "2019-03-01", end: "2019-03-31",
    lines: [{ date: "2019-03-16", description: "AGORA SHOP", amount: -193.29, currency: "PEN", status: "discount", discount: { clear: true, entryId: pv } }],
    openings: [{ currency: "PEN", amount: 0, date: "2019-02-28" }], confirmed: [Object.assign({}, e, { amount: 194.30 })], inboundIds: {}, entryById: { [pv]: Object.assign({}, e, { amount: 194.30 }) } };
  const c = run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")");
  assert.equal(c.diff, 1.01);
  assert.deepEqual(c.discounted, { net: 1.01, lines: 1 });
  assert.equal(c.notInApp.lines, 0);
  assert.equal(c.unexplained, 0);
});
