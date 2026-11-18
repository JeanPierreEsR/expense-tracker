// "Is this your Salary for August?" (owner's plan, 2026-11-17, after the journeys run: Andrés's salary planned for the 3rd and typed on
// the 28th was counted twice in Projections). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

const month = today().slice(0, 7);
function setup() {
  const { rt } = freshApp({ entries: 20 });
  rt.run(`appendRowObject('Categories', { id: 'cat-sal', name: 'PM salary', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  rt.run(`deleteRowsWhere_('Entries', function () { return true; });`);
  rt.run(`deleteRowsWhere_('Recurring Expenses', function () { return true; });`);
  rt.run(`appendRowObject('Recurring Expenses', { id: 'rec-sal', description: 'Salary', category_id: 'cat-sal', amount: 9800, currency: 'PEN', frequency: 'monthly', day_of_month: 3, active: 'true', start_date: '${month}-01' });`);
  return rt;
}
const save = (rt, f) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({ type: "income", date: `${month}-28`, amount: 9800, currency: "PEN", category_id: "cat-sal", description: "Pay Prueba", paid_by: "me" }, f) });

test("a salary typed on another day than planned is offered as that month's Salary", () => {
  const rt = setup();
  const out = save(rt, {});
  assert.deepEqual(out.plan_ask, { recurring_id: "rec-sal", description: "Salary", month });
});

test("nothing is asked when the amount is far off, the category differs, or the month is already paid", () => {
  let rt = setup();
  assert.equal(save(rt, { amount: 5000 }).plan_ask, undefined);
  rt = setup();
  rt.run(`appendRowObject('Categories', { id: 'cat-other', name: 'PM other', type: 'income', icon: '', color: '#ccc', parent_id: '' });`);
  assert.equal(save(rt, { category_id: "cat-other" }).plan_ask, undefined);
  rt = setup();
  const first = save(rt, {});
  rt.api("linkEntryToRecurring", { entryId: first.id, recurringExpenseId: "rec-sal" });
  assert.equal(save(rt, { date: `${month}-27` }).plan_ask, undefined);
});

test("a waiting item carries the same suggestion, and confirming with it links the payment", () => {
  const rt = setup();
  rt.run(`appendRowObject('Entries', { id: 'pend-1', type: 'income', date: '${month}-28', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay Prueba', paid_by: 'me', status: 'pending', source: 'email' });`);
  const p = rt.api("listPendingEntries", {}).find((e) => e.id === "pend-1");
  assert.equal(p.plan_match.recurring_id, "rec-sal");
  rt.api("saveEntryAll", { kind: "confirm", id: "pend-1", fields: {}, link_recurring_id: "rec-sal" });
  const e = JSON.parse(rt.run(`JSON.stringify(getEntryById_('pend-1'))`));
  assert.equal(e.recurring_expense_id, "rec-sal");
  assert.equal(e.status, "confirmed");
});

test("Telegram: after Confirm on a waiting card, the bot asks 'Is this your Salary…?' and Yes links it", () => {
  const channels = require("../harness/channels");
  const { linkTelegram } = require("./helpers");
  const rt = setup();
  const world = channels.attach(rt);
  linkTelegram(rt, Number(world.TG_CHAT));
  rt.run(`appendRowObject('Entries', { id: 'pend-tg', type: 'income', date: '${month}-28', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay Prueba', paid_by: 'me', status: 'pending', source: 'email' });`);
  world.chat.push({ bot: "telegram", who: "bot", id: 9001, text: "Pay Prueba · PEN 9,800.00", buttons: [{ id: "confirm:pend-tg", title: "Confirm" }] });   // the item's card
  world.telegramSend({ tap: "confirm:pend-tg" });
  const ask = [...world.chat].reverse().find((c) => c.who === "bot" && (c.buttons || []).some((b) => b.id === "plink:pend-tg"));
  assert.ok(ask, "the question was sent: " + JSON.stringify(world.chat.slice(-3)));
  assert.match(ask.text, /Salary/);
  world.telegramSend({ tap: "plink:pend-tg" });
  const e = JSON.parse(rt.run(`JSON.stringify(getEntryById_('pend-tg'))`));
  assert.equal(e.recurring_expense_id, "rec-sal");
});

test("an import line that looks like a planned item is listed in the preview, and the save links it when kept ticked", () => {
  const rt = setup();
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-imp', nickname: 'Imp wallet', type: 'debit', bank_id: '', last_4: '', currency: 'PEN' });`);
  const stmt = { key: "ACCT-pm-imp", kind: "csv", holder: "", verified: false, balances: {}, file_name: "app.csv", period: { start: `${month}-01`, end: `${month}-28` },
    lines: [{ date: `${month}-28`, description: "Pay Prueba", amount: 9800, currency: "PEN", category: "PM salary" }, { date: `${month}-05`, description: "Snack", amount: -5, currency: "PEN" }] };
  const p = JSON.parse(JSON.stringify(rt.api("planStatementHistory", { statements: [stmt] })));
  assert.equal(p.plan_matches.length, 1);
  assert.equal(p.plan_matches[0].recurring_id, "rec-sal");
  const links = p.plan_matches.map((m) => ({ stmt: m.stmt, line: m.line, recurring_id: m.recurring_id }));
  rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "app.csv", statements: [stmt], actions: p.actions, planLinks: links })})`);
  const e = JSON.parse(rt.run(`JSON.stringify(getAllRows('Entries').filter(function (x) { return x.description === 'Pay Prueba'; })[0])`));
  assert.equal(e.recurring_expense_id, "rec-sal");
});

test("confirm-many links the items it was asked to, re-checked: a second item for the same month is confirmed without a link", () => {
  const rt = setup();
  for (const id of ["pb-1", "pb-2"]) rt.run(`appendRowObject('Entries', { id: '${id}', type: 'income', date: '${month}-2${id.slice(-1)}', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay ${id}', paid_by: 'me', status: 'pending', source: 'email' });`);
  const out = rt.api("confirmEntries", { items: [{ id: "pb-1", link_recurring_id: "rec-sal" }, { id: "pb-2", link_recurring_id: "rec-sal" }] });
  assert.deepEqual(out.confirmed, ["pb-1", "pb-2"]);
  assert.deepEqual(out.linked.map((x) => x.id), ["pb-1"]);
  assert.deepEqual(out.link_skipped.map((x) => x.id), ["pb-2"]);
  const linked = (id) => JSON.parse(rt.run(`JSON.stringify(getEntryById_('${id}'))`)).recurring_expense_id;
  assert.equal(linked("pb-1"), "rec-sal");
  assert.ok(!linked("pb-2"));
});
