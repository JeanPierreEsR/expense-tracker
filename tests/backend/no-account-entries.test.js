// Entries saved with no account (owner, 2026-11-11): Tidy my history lists them so each gets one (saving fills only empty accounts,
// Undo empties only what it filled), and a statement shows the lines that ARE such an entry as "in the app with no account" instead
// of "not in the app". Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Visa Prueba", type: "credit", currencies: ["PEN"], last_4: "4545" });
  const friend = rt.api("addFriend", { name: "Ana Lo " + Math.random().toString(36).slice(2, 6) });
  const add = (fields) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "expense", currency: "PEN", paid_by: "me" }, fields) }).id;
  return { rt, card, friend, add };
}
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("Tidy: lists the person's entries with no account, newest first, and leaves out what a friend paid", () => {
  const { rt, card, friend, add } = setup();
  const a = add({ date: "2026-10-23", amount: 170, description: "Masajes prueba" });
  const b = add({ date: "2026-10-03", amount: 79, description: "Bar prueba" });
  const withAcct = add({ date: "2026-10-05", amount: 10, description: "Con cuenta", payment_method_id: card.id });
  const byFriend = add({ date: "2026-10-06", amount: 60, description: "Pagó Ana", paid_by: friend.id });
  const list = rt.api("listNoAccountEntries", {});
  const ids = list.entries.map((e) => e.id);
  assert.ok(ids.indexOf(a) !== -1 && ids.indexOf(b) !== -1);
  assert.ok(ids.indexOf(a) < ids.indexOf(b), "newest first");
  assert.equal(ids.indexOf(withAcct), -1);
  assert.equal(ids.indexOf(byFriend), -1, "what a friend paid never touched the person's accounts");
});

test("Tidy: saving fills only empty accounts, and Undo empties only what it filled", () => {
  const { rt, card, add } = setup();
  const other = rt.api("savePaymentMethod", { nickname: "Ahorro Prueba", type: "debit", currencies: ["PEN"], last_4: "6767" });
  const a = add({ date: "2026-10-23", amount: 170, description: "Masajes prueba" });
  const b = add({ date: "2026-10-03", amount: 79, description: "Bar prueba" });
  const res = rt.api("assignEntryAccounts", { items: [{ id: a, payment_method_id: card.id }, { id: b, payment_method_id: card.id }] });
  assert.equal(res.count, 2);
  assert.equal(row(rt, a).payment_method_id, card.id);
  assert.equal(rt.api("assignEntryAccounts", { items: [{ id: a, payment_method_id: other.id }] }).count, 0, "never overwrites a chosen account");
  rt.api("updateEntry", { id: b, fields: { payment_method_id: other.id } });   // the person changes one by hand afterwards
  const undo = rt.api("undoEntryAccounts", { changes: res.changes });
  assert.equal(undo.reverted, 1);
  assert.equal(row(rt, a).payment_method_id, "");
  assert.equal(row(rt, b).payment_method_id, other.id, "a later change by hand is kept");
});

test("Statement: a line that IS an entry with no account is listed apart and counted as 'no account', not 'not in the app'", () => {
  const { rt, card, add } = setup();
  const a = add({ date: "2019-03-23", amount: 170, description: "Masajes prueba" });
  const s = { key: "4545", kind: "visa", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { opening: 0, closing: -170 } }, file_name: "v.pdf",
    lines: [{ date: "2019-03-23", description: "PLIN.PRUEBA", amount: -170, currency: "PEN" }] };
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: 0, date: "2019-02-28" }] });
  const p = run(rt, `planStatementHistory(${JSON.stringify({ statements: [s] })})`);
  assert.equal(p.summary.noAccount.length, 1);
  assert.equal(p.summary.noAccount[0].entry.id, a);
  assert.ok(p.actions.some((x) => x.type === "assign_account" && x.entryId === a), "ticked by default");
  const c = p.balance_checks.find((x) => x.currency === "PEN");
  assert.deepEqual(c.noAccount, { net: -170, lines: 1 });
  assert.equal(c.notInApp.lines, 0);
  assert.equal(c.unexplained, 0);
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "v", statements: [s], actions: p.actions })})`);
  assert.equal(row(rt, a).payment_method_id, card.id, "it got the card");
});

test("Tidy and statements: what forgiving a debt booked is left out (no money moved, so it needs no account)", () => {
  const { rt, card, friend, add } = setup();
  const cat = rt.rows("Categories").find((c) => c.type === "expense");
  const whole = rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 80, currency: "PEN", date: "2019-03-01", payment_method_id: card.id });
  const part = rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2019-03-02", payment_method_id: card.id });
  const w = rt.api("forgiveLoan", { id: whole.id, category_id: cat.id, date: "2019-03-23" }).entry;
  const p = rt.api("forgiveLoan", { id: part.id, amount: 50, category_id: cat.id, date: "2019-03-24" }).entry;
  const plain = add({ date: "2019-03-25", amount: 12, description: "Sin cuenta prueba" });
  const ids = rt.api("listNoAccountEntries", {}).entries.map((e) => e.id);
  assert.equal(ids.indexOf(w.id), -1, "a whole forgiveness is left out");
  assert.equal(ids.indexOf(p.id), -1, "a forgiven part is left out");
  assert.notEqual(ids.indexOf(plain), -1, "a real entry with no account is still listed");
  const s = { key: "4545", kind: "visa", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: { PEN: { opening: 0, closing: -80 } }, file_name: "v.pdf",
    lines: [{ date: "2019-03-23", description: "COMPRA PRUEBA", amount: -80, currency: "PEN" }] };
  const plan = run(rt, `planStatementHistory(${JSON.stringify({ statements: [s] })})`);
  assert.ok(!plan.actions.some((x) => x.entryId === w.id), "a bank line never pairs with a forgiveness entry");
});
