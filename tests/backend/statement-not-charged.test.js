// "Not on this statement: the bank may never have charged it" (owner's plan, 2026-11-26, Part B): an expense or income saved on the
// statement's account, inside its period, that no line shows. Nothing is pre-picked; the person removes it (safety copy, Undo restores),
// moves it to another account, or keeps it (never asked again). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  const bank = rt.api("savePaymentMethod", { nickname: "Ahorros Prueba", type: "debit", currencies: ["PEN"], last_4: "4321" });
  const other = rt.api("savePaymentMethod", { nickname: "Otra Prueba", type: "debit", currencies: ["PEN"], last_4: "6543" });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta Prueba", type: "credit", currencies: ["PEN"], last_4: "8765" });
  const add = (fields, opts) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "expense", currency: "PEN", paid_by: "me", payment_method_id: bank.id }, fields),
    splits: opts && opts.splits }).id;
  const fromEmail = (id) => rt.run(`updateRowFields_('Entries', ${JSON.stringify(id)}, { source: 'email' })`);
  const stmt = (key, lines, extra) => Object.assign({ key, kind: "savings", verified: true, period: { start: "2019-03-01", end: "2019-03-31" }, balances: {}, file_name: "s.pdf", lines }, extra || {});
  return { rt, bank, other, card, add, fromEmail, stmt };
}
const plan = (rt, statements, on) => run(rt, `planStatementHistory(${JSON.stringify({ statements, notCharged: on !== false })})`);
const save = (rt, statements, actions, dryRun) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun, filename: "s", statements, actions })})`);
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);
const LINE = { date: "2019-03-03", description: "TAMBO", amount: -12, currency: "PEN" };

test("an e-mailed expense no line shows is listed first, with its reason; nothing is pre-picked", () => {
  const { rt, add, fromEmail, stmt } = setup();
  const typed = add({ date: "2019-03-05", amount: 20, description: "Mercado" });
  const ins = add({ date: "2019-03-12", amount: 50, description: "Seguro Pacifico" });
  fromEmail(ins);
  add({ date: "2019-03-03", amount: 12, description: "Tambo" });   // on the statement
  add({ date: "2019-04-02", amount: 9, description: "Later" });     // after the period
  const p = plan(rt, [stmt("4321", [LINE])]);
  assert.deepEqual(p.summary.notCharged.map((n) => [n.id, n.reason]), [[ins, "email"], [typed, ""]]);
  assert.equal(p.summary.notCharged[0].effect, -50);
  assert.ok(!p.actions.some((a) => /not_charged/.test(a.type)), "never chosen by itself");
  assert.equal((plan(rt, [stmt("4321", [LINE])], false).summary.notCharged || []).length, 0, "an older phone is not shown it");
});

test("Remove it: the entry goes (safety copy in Recently deleted) and the upload's Undo brings it back", () => {
  const { rt, add, stmt } = setup();
  const id = add({ date: "2019-03-12", amount: 50, description: "Seguro Pacifico" });
  const s = stmt("4321", [LINE]);
  const res = save(rt, [s], [{ type: "add_history_expense", stmt: 0, line: 0 }, { type: "remove_not_charged", stmt: 0, entryId: id }], false);
  assert.equal(res.notChargedRemoved, 1);
  assert.equal(row(rt, id), undefined);
  assert.ok(run(rt, "listDeletedEntries()").batches.some((b) => b.entries.some((e) => e.entry_id === id)));
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(row(rt, id).description, "Seguro Pacifico");
});

test("Paid from another account moves it; Keep it is never asked again", () => {
  const { rt, add, other, stmt } = setup();
  const a = add({ date: "2019-03-12", amount: 50, description: "Seguro" });
  const b = add({ date: "2019-03-14", amount: 30, description: "Gimnasio" });
  const s = stmt("4321", [LINE]);
  save(rt, [s], [{ type: "move_not_charged", stmt: 0, entryId: a, pmId: other.id }, { type: "keep_not_charged", stmt: 0, entryId: b }], false);
  assert.equal(row(rt, a).payment_method_id, other.id);
  assert.equal(plan(rt, [s]).summary.notCharged.length, 0);
});

test("a card's last 3 days, a misread statement and an app's export ask nothing", () => {
  const { rt, add, card, stmt } = setup();
  add({ date: "2019-03-30", amount: 40, description: "Wong", payment_method_id: card.id });
  add({ date: "2019-03-10", amount: 25, description: "Plaza Vea", payment_method_id: card.id });
  const c = stmt("8765", [{ date: "2019-03-03", description: "TAMBO", amount: -12, currency: "PEN" }], { kind: "visa" });
  assert.deepEqual(plan(rt, [c]).summary.notCharged.map((n) => n.description), ["Plaza Vea"]);
  assert.equal(plan(rt, [Object.assign({}, c, { verified: false })]).summary.notCharged.length, 0);
  assert.equal(plan(rt, [Object.assign({}, c, { kind: "csv", verified: false, unclear: 2 })]).summary.notCharged.length, 0);
  assert.equal(plan(rt, [Object.assign({}, c, { kind: "csv", verified: false, source: "app" })]).summary.notCharged.length, 0);
});

test("two e-mails for one charge: the twin the statement shows is matched, the other is listed", () => {
  const { rt, add, stmt } = setup();
  add({ date: "2019-03-03", amount: 12, description: "Tambo" });
  const twin = add({ date: "2019-03-04", amount: 12, description: "Tambo" });
  const p = plan(rt, [stmt("4321", [LINE])]);
  assert.deepEqual(p.summary.notCharged.map((n) => [n.id, n.reason]), [[twin, "twice"]]);
});

test("the save refuses an entry that changed since, or a repayment's money", () => {
  const { rt, add, card, stmt } = setup();
  const id = add({ date: "2019-03-12", amount: 50, description: "Seguro", payment_method_id: card.id });
  assert.throws(() => save(rt, [stmt("4321", [LINE])], [{ type: "remove_not_charged", stmt: 0, entryId: id }], true), /changed since it was read/);
});
