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
  rt.run(`appendRowObject('Recurring Expenses', { id: 'rec-sal', description: 'Salary', category_id: 'cat-sal', amount: 9800, currency: 'PEN', frequency: 'monthly', day: 3, active: 'true', start_date: '${month}-01' });`);
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
  assert.equal(save(rt, { date: `${month}-10` }).plan_ask, undefined, "this month paid, and next month's 3rd is more than 15 days away");
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
  for (const id of ["pb-1", "pb-2"]) rt.run(`appendRowObject('Entries', { id: '${id}', type: 'income', date: '${month}-1${id.slice(-1)}', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay ${id}', paid_by: 'me', status: 'pending', source: 'email' });`);
  const out = rt.api("confirmEntries", { items: [{ id: "pb-1", link_recurring_id: "rec-sal" }, { id: "pb-2", link_recurring_id: "rec-sal" }] });
  assert.deepEqual(out.confirmed, ["pb-1", "pb-2"]);
  assert.deepEqual(out.linked.map((x) => x.id), ["pb-1"]);
  assert.deepEqual(out.link_skipped.map((x) => x.id), ["pb-2"]);
  const linked = (id) => JSON.parse(rt.run(`JSON.stringify(getEntryById_('${id}'))`)).recurring_expense_id;
  assert.equal(linked("pb-1"), "rec-sal");
  assert.ok(!linked("pb-2"));
});

// ---- the month rule (owner, 2026-11-18): own month first; next month only when this one is paid and within 15 days ----
const nextMonth = (() => { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); })();
const lastDay = (() => { const [y, m] = month.split("-").map(Number); return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0"); })();

test("1.1: a late payment with this month unpaid is this month's", () => {
  const rt = setup();
  assert.equal(save(rt, { date: `${month}-${lastDay}` }).plan_ask.month, month);
});

test("1.2 / 1.5: this month already paid, next month's date within 15 days: next month's; the link remembers it and Projections counts that month paid", () => {
  const rt = setup();
  const first = save(rt, { date: `${month}-03` });   // matched by itself (on its day)
  const out = save(rt, { date: `${month}-${lastDay}` });
  assert.equal(out.plan_ask.month, nextMonth);
  rt.api("linkEntryToRecurring", { entryId: out.id, recurringExpenseId: "rec-sal", month: out.plan_ask.month });
  const e = JSON.parse(rt.run(`JSON.stringify(getEntryById_('${out.id}'))`));
  assert.equal(e.recurring_month, nextMonth);
  // next month's occurrence is now handled by that link
  const occ = JSON.parse(rt.run(`JSON.stringify(recurringExpenseOccurrencesInRange_(getAllRows('Recurring Expenses')[0], '${nextMonth}-01', '${nextMonth}-28'))`));
  assert.ok(rt.run(`entryMatchesRecurringOccurrence_(getEntryById_('${out.id}'), getAllRows('Recurring Expenses')[0], ${JSON.stringify(occ)})`));
  assert.ok(first.id);
});

test("1.3 / 1.4: this month paid and next month's date too far, or both months paid: no ask", () => {
  let rt = setup();
  save(rt, { date: `${month}-03` });
  assert.equal(save(rt, { date: `${month}-10` }).plan_ask, undefined);
  rt = setup();
  save(rt, { date: `${month}-03` });
  const early = save(rt, { date: `${month}-${lastDay}` });
  rt.api("linkEntryToRecurring", { entryId: early.id, recurringExpenseId: "rec-sal", month: nextMonth });
  assert.equal(save(rt, { date: `${month}-${String(Number(lastDay) - 1).padStart(2, "0")}` }).plan_ask, undefined);
});

test("1.15: a shared plan is matched by the person's share too", () => {
  const rt = setup();
  rt.run(`appendRowObject('Recurring Expense Splits', { id: 'rs-1', recurring_expense_id: 'rec-sal', friend_id: 'f-x', amount: 4900 });`);
  assert.equal(save(rt, { amount: 4900 }).plan_ask.recurring_id, "rec-sal");
});

test("linking for the payment's own month stores no month; unlinking clears it", () => {
  const rt = setup();
  const out = save(rt, {});
  rt.api("linkEntryToRecurring", { entryId: out.id, recurringExpenseId: "rec-sal", month });
  assert.ok(!JSON.parse(rt.run(`JSON.stringify(getEntryById_('${out.id}'))`)).recurring_month);
  rt.api("linkEntryToRecurring", { entryId: out.id, recurringExpenseId: "rec-sal", month: nextMonth });
  rt.api("linkEntryToRecurring", { entryId: out.id, recurringExpenseId: "" });
  assert.ok(!JSON.parse(rt.run(`JSON.stringify(getEntryById_('${out.id}'))`)).recurring_month);
});

test("1.18 / 1.19: a few days' move keeps the paid month; a move of 2 months drops it quietly", () => {
  const rt = setup();
  save(rt, { date: `${month}-03` });
  const out = save(rt, { date: `${month}-${lastDay}` });
  rt.api("linkEntryToRecurring", { entryId: out.id, recurringExpenseId: "rec-sal", month: nextMonth });
  const get = () => JSON.parse(rt.run(`JSON.stringify(getEntryById_('${out.id}'))`));
  rt.run(`updateEntryFields('${out.id}', { date: '${month}-${String(Number(lastDay) - 2).padStart(2, "0")}' })`);
  assert.equal(get().recurring_month, nextMonth, "a few days earlier: still next month's");
  const [y, m] = month.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 10);   // a month before this one = 2 months from next month
  rt.run(`updateEntryFields('${out.id}', { date: '${back}' })`);
  assert.ok(!get().recurring_month, "moved 2 months away: dropped");
  assert.equal(get().recurring_expense_id, "rec-sal", "the link itself stays");
});

test("Telegram and confirm-many keep the paid month too", () => {
  const rt = setup();
  save(rt, { date: `${month}-03` });
  rt.run(`appendRowObject('Entries', { id: 'pb-late', type: 'income', date: '${month}-${lastDay}', amount: 9800, currency: 'PEN', category_id: 'cat-sal', description: 'Pay late', paid_by: 'me', status: 'pending', source: 'email' });`);
  const out = rt.api("confirmEntries", { items: [{ id: "pb-late", link_recurring_id: "rec-sal" }] });
  assert.deepEqual(out.linked.map((x) => x.id), ["pb-late"]);
  assert.equal(JSON.parse(rt.run(`JSON.stringify(getEntryById_('pb-late'))`)).recurring_month, nextMonth);
});

test("1.25: a payment linked by hand in the item's 'match past entries' list follows the same month rule", () => {
  const rt = setup();
  save(rt, { date: `${month}-03` });   // this month paid by itself
  const late = save(rt, { date: `${month}-${lastDay}`, amount: 9790 });
  rt.api("linkEntriesToRecurring", { recurringExpenseId: "rec-sal", entryIds: [late.id] });
  const e = JSON.parse(rt.run(`JSON.stringify(getEntryById_('${late.id}'))`));
  assert.equal(e.recurring_expense_id, "rec-sal");
  assert.equal(e.recurring_month, nextMonth);
});

// The original bug (Andrés, journeys run): planned for the 3rd, salary typed later in the month (here: today), counted twice in Projections.
test("the forecast counts a typed salary twice before the link, and once after it", () => {
  const { today } = require("./helpers");
  const day = Number(today().slice(8, 10));
  if (day <= 3) return;   // (the plan's day must already have passed this month; true on all but the first 3 days)
  const rt = setup();
  const income = () => rt.api("getProjections", { displayPeriodType: "month", anchorDate: today() }).income;
  const before = income();
  const typed = save(rt, { date: today() });
  assert.equal(typed.plan_ask.month, month);
  const doubled = income();
  assert.ok(doubled >= before + 9800 - 0.01, "before the link it adds on top of the plan: " + before + " → " + doubled);
  rt.api("linkEntryToRecurring", { entryId: typed.id, recurringExpenseId: "rec-sal", month: typed.plan_ask.month });
  assert.equal(Math.round(income()), Math.round(doubled - 9800), "linked: counted once");
});
