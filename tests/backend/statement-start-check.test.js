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
  assert.equal(opening(rt, card.id).amount, -142.5, "the starting number itself is corrected (owner, 2026-11-11)");
  assert.deepEqual(opening(rt, card.id).not_yet, []);
  assert.equal(plan(rt, [s]).balance_checks[0].diff, 0, "read again: the app now agrees with the statement");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(opening(rt, card.id).amount, -100);
});

test("two entries that would both fit: nothing is offered", () => {
  const { rt, card, add, stmt } = setup();
  add("2019-03-09", 42.50, "Tienda Dos");
  add("2019-03-10", 42.50, "Tienda Tres");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  // both posted on the statement, the balance included one of them: either could be the one, so nothing is offered
  const c = plan(rt, [stmt(-142.50, [{ date: "2019-03-09", description: "TIENDA DOS", amount: -42.50, currency: "PEN" },
    { date: "2019-03-10", description: "TIENDA TRES", amount: -42.50, currency: "PEN" }])]).balance_checks[0];
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

test("a purchase both charged less and counted after the balance in the same save: the balance does not move twice (Elena)", () => {
  const { rt, card, add, stmt } = setup();
  const pv = add("2019-03-09", 50.00, "PV", "agora shop");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  // the charge posted AFTER the balance was typed: it was not in it, and the card charged 45.00
  const s = stmt(-145, [{ date: "2019-03-11", description: "AGORA SHOP COMPANIA FO", amount: -45.00, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.deepEqual(c.startFix.items.map((i) => i.id), [pv]);
  assert.deepEqual(c.startShift, { net: 5, lines: 1 }, "its charge posted after the balance, yet taking the bank amount moves the balance");
  save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: [pv] }]));
  assert.equal(opening(rt, card.id).amount, -145, "the number takes both: −50 not posted yet, +5 charged less");
  const bal = rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances.find((b) => b.currency === "PEN").amount;
  assert.equal(bal, -145);
});

test("the correction looks at the whole window of days: five entries that add up to the gap are offered", () => {
  const { rt, card, add, stmt } = setup();
  const ids = [["2019-03-08", 11.11], ["2019-03-09", 22.22], ["2019-03-09", 33.33], ["2019-03-10", 44.44], ["2019-03-10", 55.55]].map(([d, a], k) => add(d, a, "Tienda " + k));
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  const lines = [["2019-03-08", 11.11], ["2019-03-09", 22.22], ["2019-03-09", 33.33], ["2019-03-10", 44.44], ["2019-03-10", 55.55]]
    .map(([d, a], k) => ({ date: d, description: "TIENDA " + k, amount: -a, currency: "PEN" }));
  const c = plan(rt, [stmt(-266.65, lines)]).balance_checks[0];
  assert.equal(c.unexplained, -166.65);
  assert.deepEqual(c.startFix.items.map((i) => i.id).sort(), ids.slice().sort());
});

test("a set balance whose correction was not taken keeps the likely entries in its difference note", () => {
  const { rt, card, add, stmt } = setup();
  add("2019-03-10", 42.50, "Tienda Dos");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10" }] });
  const s = stmt(-142.50, []);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  save(rt, [s], p.actions.concat([{ type: "set_balance", stmt: 0, currency: "PEN", gap: c.unexplained, app_balance: c.appAtEnd, likely: "Mar 10 · Tienda Dos −PEN 42.50" }]));
  const gaps = run(rt, "listStatementGaps()").gaps;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].likely, "Mar 10 · Tienda Dos −PEN 42.50");
});

// ---- the opposite correction (owner, 2026-11-11): counted after the balance, but the bank had already posted it ----
test("an entry counted after the balance that the bank had already posted: the number gives it back", () => {
  const { rt, card, add, stmt } = setup();
  const x = add("2019-03-09", 30, "Tienda Cuatro");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10", not_yet: [x] }] });
  // the typed −100 already had it: the bank says −100 at the end
  const s = stmt(-100, [{ date: "2019-03-09", description: "TIENDA CUATRO", amount: -30, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.unexplained, 30);
  assert.deepEqual(c.startFix.items.map((i) => [i.id, i.side, i.weight]), [[x, "out", 30]]);
  const res = save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: [x] }]));
  assert.equal(opening(rt, card.id).amount, -70);
  assert.equal(rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances[0].amount, -100, "now the app agrees with the bank");
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.equal(opening(rt, card.id).amount, -100);
});

test("a payment in process that the bank cancelled (never on a statement) is never offered", () => {
  const { rt, card, add, stmt } = setup();
  const x = add("2019-03-09", 30, "Tienda Cuatro");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10", not_yet: [x] }] });
  const c = plan(rt, [stmt(-100, [])]).balance_checks[0];
  assert.equal(c.unexplained, 30);
  assert.equal(c.startFix, undefined, "it stays in 'in the app, not on this statement', the real fix being to remove it");
});

test("a duplicate (the bank posted only its twin) is never offered", () => {
  const { rt, card, add, stmt } = setup();
  const a = add("2019-03-09", 30, "Tienda Cuatro");
  const b = add("2019-03-09", 30, "Tienda Cuatro copia");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10", not_yet: [a, b] }] });
  // the bank posted it once, after the balance
  const p = plan(rt, [stmt(-130, [{ date: "2019-03-11", description: "TIENDA CUATRO", amount: -30, currency: "PEN" }])]);
  const c = p.balance_checks[0];
  assert.equal(c.unexplained, 30);
  assert.equal(c.startFix, undefined);
});

test("both directions at once: one taken inside but not posted, one counted after but posted", () => {
  const { rt, card, add, stmt } = setup();
  const y = add("2019-03-10", 20, "Tienda Cinco");   // inside the balance, not posted when it was typed
  const x = add("2019-03-09", 30, "Tienda Seis");    // marked Not yet, but already posted
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-10", not_yet: [x] }] });
  const s = stmt(-120, [{ date: "2019-03-09", description: "TIENDA SEIS", amount: -30, currency: "PEN" },
    { date: "2019-03-10", description: "TIENDA CINCO", amount: -20, currency: "PEN" }]);
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.unexplained, 10);
  assert.deepEqual(c.startFix.items.map((i) => [i.id, i.side]).sort(), [[x, "out"], [y, "in"]].sort());
  save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: [x, y] }]));
  assert.equal(opening(rt, card.id).amount, -90);
  assert.equal(rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances[0].amount, -120);
});

// ---- a statement closing on the starting balance's own day (owner, 2026-11-11) ----
test("same day: the statement checks the balance (correction offered) and may replace it", () => {
  const { rt, card, add, stmt } = setup();
  const t = add("2019-03-30", 42.50, "Tienda Dos");
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: "2019-03-31" }] });
  const s = stmt(-142.50, [{ date: "2019-03-30", description: "TIENDA DOS", amount: -42.50, currency: "PEN" }]);   // closes 2019-03-31
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.sameDay, true);
  assert.equal(c.direction, "forward");
  assert.equal(c.canSet, true);
  assert.equal(c.unexplained, -42.5);
  assert.deepEqual(c.startFix.items.map((i) => i.id), [t]);
  // replacing the typed balance with the statement's closing is allowed on the same day
  save(rt, [s], p.actions.concat([{ type: "set_balance", stmt: 0, currency: "PEN", gap: 0, app_balance: c.appAtEnd }]));
  assert.equal(opening(rt, card.id).amount, -142.5);
  assert.equal(opening(rt, card.id).date, "2019-03-31");
});

// ---- a late bank e-mail the starting balance already held (owner, 2026-11-11: the same-day statement corrected it twice) ----
const limaDay = (k) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date(Date.now() - k * 86400000));
function lateMailSetup(id, description) {
  const { rt, card, stmt } = setup();
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "PEN", amount: -100, date: limaDay(0) }] });   // typed with the purchase in it
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "expense", date: limaDay(1), amount: 64.90, currency: "PEN", category_id: "",
    description, payment_method_id: card.id, paid_by: "me", status: "confirmed", source: "email", created_at: "2099-01-01T00:00:00" })});`);
  const bal = () => rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances[0].amount;
  return { rt, card, stmt, bal };
}

test("same day, late bank e-mail already in the balance: the save itself puts it inside, so no correction is offered or applied", () => {
  const { rt, card, stmt, bal } = lateMailSetup("mail-late-1", "Tienda Siete");
  assert.equal(bal(), -164.9, "counted after the balance (option C): the double count");
  const s = Object.assign(stmt(-100, [{ date: limaDay(1), description: "TIENDA SIETE", amount: -64.90, currency: "PEN" }]),
    { period: { start: limaDay(10), end: limaDay(0) } });
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.sameDay, true);
  assert.equal(c.diff, 0, "judged as it will be after the save: the statement covers it, so it is inside");
  assert.equal(c.startFix, undefined);
  assert.equal(bal(), -164.9, "the check itself changes nothing");
  // an older phone that still sends the correction: the save does not count it twice
  save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: ["mail-late-1"] }]));
  assert.equal(opening(rt, card.id).amount, -100);
  assert.equal(bal(), -100);
});

test("a later statement, late bank e-mail already in the balance: the correction is offered and lands on the statement", () => {
  const { rt, card, stmt, bal } = lateMailSetup("mail-late-2", "Tienda Ocho");
  const s = Object.assign(stmt(-100, [{ date: limaDay(1), description: "TIENDA OCHO", amount: -64.90, currency: "PEN" }]),
    { period: { start: limaDay(10), end: limaDay(-5) } });
  const p = plan(rt, [s]);
  const c = p.balance_checks[0];
  assert.equal(c.unexplained, 64.9);
  assert.deepEqual(c.startFix.items.map((i) => [i.id, i.side]), [["mail-late-2", "out"]]);
  save(rt, [s], p.actions.concat([{ type: "start_not_yet", stmt: 0, currency: "PEN", ids: ["mail-late-2"] }]));
  assert.equal(opening(rt, card.id).amount, -35.1);
  assert.equal(bal(), -100);
});

test("a same-day statement and a later one in the same upload: the later one already counts the late e-mail inside, so it matches", () => {
  const { rt, card, stmt, bal } = lateMailSetup("mail-late-3", "Tienda Nueve");
  const line = { date: limaDay(1), description: "TIENDA NUEVE", amount: -64.90, currency: "PEN" };
  const same = Object.assign(stmt(-100, [line]), { period: { start: limaDay(10), end: limaDay(0) } });
  const later = Object.assign(stmt(-100, [line]), { period: { start: limaDay(10), end: limaDay(-5) } });
  // alone, the later statement still sees the double count (the test above)
  assert.equal(plan(rt, [later]).balance_checks[0].unexplained, 64.9);
  const p = plan(rt, [same, later]);
  const cl = p.balance_checks.find((c) => c.stmt === 1);
  assert.equal(cl.diff, 0, "the same-day statement in the upload puts the e-mail inside the balance");
  assert.equal(cl.unexplained, 0);
  assert.equal(cl.startFix, undefined);
  assert.equal(bal(), -164.9, "the check itself changes nothing");
  save(rt, [same, later], p.actions.concat([{ type: "set_balance", stmt: 1, currency: "PEN", gap: cl.unexplained, app_balance: cl.appAtEnd }]));
  assert.equal(bal(), -100);
});

test("consecutive statements in one upload (the next one starts after the balance's day): the next one counts the late e-mail inside", () => {
  const { rt, card, stmt, bal } = lateMailSetup("mail-late-4", "Tienda Diez");
  const same = Object.assign(stmt(-100, [{ date: limaDay(1), description: "TIENDA DIEZ", amount: -64.90, currency: "PEN" }]),
    { period: { start: limaDay(10), end: limaDay(0) } });
  const next = Object.assign(stmt(-100, []), { period: { start: limaDay(-1), end: limaDay(-5) } });
  assert.equal(plan(rt, [next]).balance_checks[0].unexplained, 64.9, "alone, it sees the double count");
  for (const order of [[same, next], [next, same]]) {
    const p = plan(rt, order);
    const cn = p.balance_checks.find((c) => order[c.stmt] === next);
    assert.equal(cn.diff, 0);
    assert.equal(cn.startFix, undefined);
  }
  const p = plan(rt, [same, next]);
  save(rt, [same, next], p.actions.concat([{ type: "set_balance", stmt: 1, currency: "PEN", gap: 0, app_balance: -100 }]));
  assert.equal(bal(), -100);
});
