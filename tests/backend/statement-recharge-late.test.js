// Card statements (owner, 2026-11-10): (A) a line in another currency than a purchase in the app (an e-mail in soles, a card that bills
// dollars) is that purchase: it takes the charge and keeps what was paid; (B) card purchases from the last 3 days before the closing are
// "probably on the next statement", not unexplained. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Visa Prueba", type: "credit", currencies: ["PEN", "USD"], last_4: "2468" });
  for (const m of ["2019-03", "2019-04"]) rt.api("setExchangeRate", { currency: "USD", month: m, rate: 3.4 });
  const friend = rt.api("addFriend", { name: "Ana Lo " + Math.random().toString(36).slice(2, 6) });
  const add = (date, amount, description, currency, splits) => rt.api("saveEntryAll", { kind: "create", fields: { type: "expense", date, amount,
    currency: currency || "PEN", description, paid_by: "me", payment_method_id: card.id }, splits }).id;
  const stmt = (lines, end) => ({ key: "2468", kind: "visa", verified: true, period: { start: "2019-03-01", end: end || "2019-03-31" }, balances: {}, file_name: "v.pdf", lines });
  return { rt, card, friend, add, stmt };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);
const save = (rt, statements, actions) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "v", statements, actions })})`);
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("A: a USD charge for a purchase recorded in PEN takes the charge, keeps what was paid, and Undo puts it back", () => {
  const { rt, add, stmt } = setup();
  const sp = add("2019-03-15", 20.90, "Spotify");
  const s = stmt([{ date: "2019-03-15", description: "Spotify P48099FD25", amount: -6.27, currency: "USD" }]);
  const p = plan(rt, [s]);
  assert.equal(p.summary.recharges.length, 1);
  assert.ok(p.summary.recharges[0].clear);
  assert.deepEqual(p.actions.map((a) => a.type), ["use_bank_charge"], "never added as a second purchase");
  const res = save(rt, [s], p.actions);
  assert.equal(res.recharges, 1);
  const e = row(rt, sp);
  assert.equal(e.currency, "USD");
  assert.equal(Number(e.amount), 6.27);
  assert.equal(Number(e.paid_amount), 20.9);
  assert.equal(e.paid_currency, "PEN");
  assert.ok(!e.charge_pending);
  assert.equal(plan(rt, [s]).summary.recharges.length, 0, "read again: handled");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  const u = row(rt, sp);
  assert.equal(u.currency, "PEN");
  assert.equal(Number(u.amount), 20.9);
  assert.ok(!u.paid_amount && !u.charge_pending, "back exactly as it was, not left as a charge to fill in");
});

test("A: no pair when the rate does not fit, the dates are 4 days apart, or no shop word is shared", () => {
  const { rt, add, stmt } = setup();
  add("2019-03-10", 50.00, "Apple TV");                 // 50 / 3.4 = 14.7, the line says 7.44: off
  add("2019-03-12", 12.90, "iCloud");                   // 4 days before the line
  add("2019-03-20", 34.00, "Tienda");                   // fits the rate but shares no word
  const p = plan(rt, [stmt([
    { date: "2019-03-10", description: "Apple.com/bill", amount: -7.44, currency: "USD" },
    { date: "2019-03-16", description: "iCloud Apple", amount: -3.87, currency: "USD" },
    { date: "2019-03-20", description: "Amazon Prime", amount: -10.00, currency: "USD" }
  ])]);
  assert.equal(p.summary.recharges.length, 0);
});

test("A: a shared purchase's split follows the charge, and Undo restores it", () => {
  const { rt, add, friend, stmt } = setup();
  const id = add("2019-03-15", 34.00, "Netflix", "PEN", [{ friend_id: friend.id, amount: 17 }]);
  const s = stmt([{ date: "2019-03-15", description: "NETFLIX.COM", amount: -10.00, currency: "USD" }]);
  const res = save(rt, [s], plan(rt, [s]).actions);
  assert.equal(Number(row(rt, id).amount), 10);
  assert.equal(Number(rt.rows("Entry Splits").find((x) => x.entry_id === id).amount), 5);
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(Number(row(rt, id).amount), 34);
  assert.equal(Number(rt.rows("Entry Splits").find((x) => x.entry_id === id).amount), 17);
});

function check(rt, card, confirmed, lines, end) {
  const args = { pm: { id: card.id, nickname: "Visa Prueba", type: "credit" }, currency: "PEN", closing: 0, start: "2019-03-01", end: end || "2019-03-31", lines,
    openings: [{ currency: "PEN", amount: 0, date: "2019-02-28" }], confirmed, inboundIds: {}, entryById: Object.fromEntries(confirmed.map((e) => [e.id, e])) };
  return run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")");
}

test("B: card purchases from the last 3 days before the closing are 'probably on the next statement'", () => {
  const { rt, card } = setup();
  const e = (id, date, amount) => ({ id, date, type: "expense", amount, currency: "PEN", payment_method_id: card.id, status: "confirmed", description: id });
  const c = check(rt, card, [e("early", "2019-03-20", 40), e("late1", "2019-03-28", 30), e("late2", "2019-03-31", 20)], []);
  assert.deepEqual(c.late && c.late.items.map((i) => i.id), ["late1", "late2"]);
  assert.equal(c.late.net, 50);
  assert.equal(c.unexplained, 40, "only the earlier purchase is still unexplained");
  assert.deepEqual(c.appOnly.items.map((i) => i.id), ["early"]);
});

test("B: a savings account never gets the 'next statement' label", () => {
  const { rt, card } = setup();
  const e = { id: "x", date: "2019-03-31", type: "expense", amount: 20, currency: "PEN", payment_method_id: card.id, status: "confirmed", description: "x" };
  const args = { pm: { id: card.id, nickname: "Ahorro", type: "debit" }, currency: "PEN", closing: 0, start: "2019-03-01", end: "2019-03-31", lines: [],
    openings: [{ currency: "PEN", amount: 0, date: "2019-02-28" }], confirmed: [e], inboundIds: {}, entryById: { x: e } };
  const c = run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")");
  assert.equal(c.late, undefined);
  assert.equal(c.unexplained, 20);
});

test("A in the balance check: both halves of a charge in another currency are named, not unexplained", () => {
  const { rt, card } = setup();
  const sp = { id: "sp", date: "2019-03-15", type: "expense", amount: 20.9, currency: "PEN", payment_method_id: card.id, status: "confirmed", description: "Spotify" };
  const line = { date: "2019-03-15", description: "SPOTIFY", amount: -6.27, currency: "USD", status: "recharge", recharge: { clear: true, entryId: "sp" } };
  const pen = check(rt, card, [sp], [line], "2019-03-20");
  assert.deepEqual(pen.otherCurrency, { net: 20.9, lines: 1 });
  assert.equal(pen.unexplained, 0);
  const usdArgs = { pm: { id: card.id, nickname: "Visa Prueba", type: "credit" }, currency: "USD", closing: -6.27, start: "2019-03-01", end: "2019-03-20", lines: [line],
    openings: [{ currency: "USD", amount: 0, date: "2019-02-28" }], confirmed: [sp], inboundIds: {}, entryById: { sp } };
  const usd = run(rt, "stmtBalanceCheck_(" + JSON.stringify(usdArgs) + ")");
  assert.deepEqual(usd.otherCurrency, { net: -6.27, lines: 1 });
  assert.equal(usd.unexplained, 0);
});

test("A: one company under several names: an iCloud or App Store purchase pairs with the card's Apple charge (owner, 2026-11-11)", () => {
  const { rt, add, stmt } = setup();
  const ic = add("2019-03-21", 12.90, "iCloud");
  const as = add("2019-03-24", 25.30, "App Store");
  const p = plan(rt, [stmt([
    { date: "2019-03-21", description: "Apple", amount: -3.87, currency: "USD" },
    { date: "2019-03-24", description: "APPLE.COM/BILL", amount: -7.44, currency: "USD" }
  ])]);
  assert.equal(p.summary.recharges.length, 2);
  assert.deepEqual(p.summary.recharges.map((r) => r.entryId || (r.options && r.options[0] && r.options[0].entryId)).sort(), [ic, as].sort());
});
