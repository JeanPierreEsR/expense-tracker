// Income not received yet (2026-11-09): it counts on its date, the person owes it, and only the repayment moves an account. Made-up data.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, linkTelegram } = require("./helpers");

const post = (rt, action, payload = {}) => rt.rawPost(JSON.stringify({ accessCode: rt.ACCESS_CODE, action, payload }));
function setup() {
  const { rt } = freshApp({ entries: 10 });
  post(rt, "getMeta");
  const person = post(rt, "addPayor", { name: "Client Test" }).data;
  rt.run(`appendRowObject('Payment Methods', { id: 'w-pm', nickname: 'Wallet test', type: 'wallet', bank_id: '', last_4: '' });`);
  post(rt, "setPaymentMethodOpeningBalance", { id: "w-pm", balances: [{ currency: "PEN", amount: 500, date: "2026-09-01" }] });
  return { rt, person, pm: { id: "w-pm" } };
}
const waiting = (rt, person, extra = {}) => post(rt, "createEntry", Object.assign({ type: "income", date: "2026-10-05", amount: 100, currency: "PEN", category_id: "", description: "Design job", paid_by: person.id, payment_method_id: "ignored", income_waiting: true }, extra));
const loanOf = (rt, id) => rt.rows("Loans").find((l) => l.entry_id === id);
const entryOf = (rt, id) => rt.rows("Entries").find((e) => e.id === id);
const repay = (rt, person, pm, amount, extra = {}) => post(rt, "recordRepayment", Object.assign({ friend_id: person.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-10-20", payment_method_id: pm.id }, extra));
const balance = (rt, pm) => post(rt, "listPaymentMethodBalances", {}).data.find((r) => r.id === pm.id).balances[0].amount;

test("saved as confirmed income on its date, with no account, and the person owes it", () => {
  const { rt, person, pm } = setup();
  const before = balance(rt, pm);
  const e = waiting(rt, person, { due_date: "2026-11-01" }).data;
  const row = entryOf(rt, e.id);
  assert.equal(row.status, "confirmed");
  assert.equal(row.type, "income");
  assert.equal(row.payment_method_id, "");
  assert.equal(row.income_waiting, "1");
  const loan = loanOf(rt, e.id);
  assert.equal(loan.direction, "they_owe_me");
  assert.equal(Number(loan.amount), 100);
  assert.equal(loan.due_date, "2026-11-01");
  assert.equal(balance(rt, pm), before);
});

test("needs a person; refused for a company", () => {
  const { rt } = setup();
  assert.equal(post(rt, "createEntry", { type: "income", date: "2026-10-05", amount: 10, currency: "PEN", category_id: "", paid_by: "", income_waiting: true }).ok, false);
  assert.equal(rt.rows("Entries").filter((e) => e.income_waiting === "1").length, 0);
});

test("a general repayment covers it: the balance rises then, income is not counted twice, a part leaves the rest owed", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  const before = balance(rt, pm);
  const incomes = () => rt.rows("Entries").filter((x) => x.type === "income" && x.paid_by === person.id).length;
  repay(rt, person, pm, 40);
  assert.equal(balance(rt, pm), before + 40);
  assert.equal(entryOf(rt, e.id).income_waiting, "1");
  assert.equal(post(rt, "listExpectedRecurringItems").data.waitingIncome[0].remaining, 60);
  repay(rt, person, pm, 60);
  assert.equal(balance(rt, pm), before + 100);
  assert.equal(entryOf(rt, e.id).income_waiting, "paid");
  assert.equal(incomes(), 1);
  assert.equal(entryOf(rt, e.id).date, "2026-10-05");
  assert.deepEqual(post(rt, "listExpectedRecurringItems").data.waitingIncome, []);
});

test("the extra of a repayment does not change who paid income most recently", () => {
  const { rt, person, pm } = setup();
  waiting(rt, person);
  repay(rt, person, pm, 100, { date: "2026-11-05" });
  assert.equal(post(rt, "getMeta").data.payors.find((p) => p.id === person.id).last_income, "2026-10-05");
});

test("editing follows the debt; what is already paid is protected", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { amount: 150 } });
  assert.equal(Number(loanOf(rt, e.id).amount), 150);
  repay(rt, person, pm, 50);
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { amount: 20 } }).ok, false);
  assert.equal(Number(entryOf(rt, e.id).amount), 150);
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: false } }).ok, false);
});

test("an ordinary income can start waiting and a waiting one can stop", () => {
  const { rt, person } = setup();
  const e = post(rt, "createEntry", { type: "income", date: "2026-10-05", amount: 30, currency: "PEN", category_id: "", paid_by: person.id, payment_method_id: "x" }).data;
  assert.equal(loanOf(rt, e.id), undefined);
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: true } });
  assert.equal(entryOf(rt, e.id).income_waiting, "1");
  assert.equal(entryOf(rt, e.id).payment_method_id, "");
  assert.equal(Number(loanOf(rt, e.id).amount), 30);
  post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { income_waiting: false, payment_method_id: "x" } });
  assert.equal(loanOf(rt, e.id), undefined);
  assert.equal(entryOf(rt, e.id).income_waiting, "");
});

test("forgiving lowers the income instead of booking an expense; all of it removes the income", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  const expenses = () => rt.rows("Entries").filter((x) => x.type === "expense").length;
  const before = expenses();
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30 });
  assert.equal(Number(entryOf(rt, e.id).amount), 70);
  assert.equal(Number(loanOf(rt, e.id).amount), 70);
  assert.equal(expenses(), before);
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id });
  assert.equal(entryOf(rt, e.id), undefined);
  assert.equal(loanOf(rt, e.id), undefined);
  assert.equal(expenses(), before);
});

test("a repeat of a partial forgiving from the phone's queue is not taken twice", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  const id = "11111111-1111-4111-8111-111111111111";
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30, client_id: id });
  post(rt, "forgiveLoan", { id: loanOf(rt, e.id).id, amount: 30, client_id: id });
  assert.equal(Number(entryOf(rt, e.id).amount), 70);
});

test("money waiting in Needs review with the same amount asks; yes records a repayment, not a second income", () => {
  const { rt, person, pm } = setup();
  const e = waiting(rt, person).data;
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "mail-1", type: "income", date: "2026-10-21", amount: 100, currency: "PEN", category_id: "", description: "Transfer received", payment_method_id: pm.id, paid_by: "", status: "pending", source: "email" })}); bumpVersion_('ENTRIES_VERSION');`);
  const item = post(rt, "listPendingEntries").data.find((x) => x.id === "mail-1");
  assert.equal(item.waiting_match.loan_id, loanOf(rt, e.id).id);
  const before = balance(rt, pm);
  const out = post(rt, "convertEntryToRepayment", { entry_id: "mail-1", friend_id: person.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-21", payment_method_id: pm.id, description: "Transfer received", require_owed: true, overpay_pending_ok: true, allocations: [{ loan_id: loanOf(rt, e.id).id, amount: 100 }] });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(entryOf(rt, e.id).income_waiting, "paid");
  assert.equal(rt.rows("Entries").filter((x) => x.type === "income" && x.paid_by === person.id).length, 1);
  assert.equal(balance(rt, pm), before + 100);
});

test("a different amount does not ask", () => {
  const { rt, person, pm } = setup();
  waiting(rt, person);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "mail-2", type: "income", date: "2026-10-21", amount: 99, currency: "PEN", category_id: "", description: "Other", payment_method_id: pm.id, paid_by: "", status: "pending", source: "email" })}); bumpVersion_('ENTRIES_VERSION');`);
  assert.equal(post(rt, "listPendingEntries").data.find((x) => x.id === "mail-2").waiting_match, undefined);
});

test("its type cannot be changed while linked to the debt", () => {
  const { rt, person } = setup();
  const e = waiting(rt, person).data;
  assert.equal(post(rt, "saveEntryAll", { kind: "update", id: e.id, fields: { type: "expense" } }).ok, false);
});

// ---- Telegram ----
function telegramSetup(lang) {
  const base = setup();
  const chat = linkTelegram(base.rt);
  if (lang) post(base.rt, "saveOnboarding", { language: lang, dateOrder: "dmy", currencies: [] });
  const e = waiting(base.rt, base.person).data;
  base.rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "tg-1", type: "income", date: "2026-10-21", amount: 100, currency: "PEN", category_id: "", description: "Transfer received", payment_method_id: "w-pm", paid_by: "", status: "pending", source: "email" })}); bumpVersion_('ENTRIES_VERSION');`);
  const card = () => { base.rt.svc.fetchLog.length = 0; base.rt.run(`sendTelegramEntryNotification_(getEntryById_('tg-1'), '', '');`); return JSON.parse(base.rt.svc.fetchLog.find((x) => /sendMessage/.test(x.url)).options.payload); };
  const tap = (data, n) => { base.rt.svc.fetchLog.length = 0; base.rt.rawPost(JSON.stringify({ update_id: 9300 + n, callback_query: { id: "cb" + n, data, message: { chat: { id: chat }, message_id: 90 + n } } })); return base.rt.svc.fetchLog.filter((x) => /sendMessage/.test(x.url)).map((x) => JSON.parse(x.options.payload).text).join("\n"); };
  return Object.assign(base, { e, card, tap });
}

test("Telegram asks on a card that matches, with its own button above Confirm and Discard", () => {
  const { card } = telegramSetup();
  const c = card();
  assert.match(c.text, /Is this the payment you were waiting for from Client Test \(PEN 100/);
  assert.equal(c.reply_markup.inline_keyboard[0][0].callback_data, "waitpay:tg-1");
  assert.ok(Buffer.byteLength(c.reply_markup.inline_keyboard[0][0].callback_data) <= 64);
  assert.equal(c.reply_markup.inline_keyboard[1][0].callback_data, "confirm:tg-1");
});

test("Telegram: yes records a repayment, not a second income, and the balance rises once", () => {
  const { rt, person, pm, e, tap } = telegramSetup();
  const before = balance(rt, pm);
  assert.match(tap("waitpay:tg-1", 1), /Recorded as Client Test's payment/);
  assert.equal(entryOf(rt, e.id).income_waiting, "paid");
  assert.equal(rt.rows("Entries").filter((x) => x.type === "income" && x.status === "confirmed" && x.paid_by === person.id).length, 1);
  assert.notEqual(entryOf(rt, "tg-1") && entryOf(rt, "tg-1").type, "income");
  assert.equal(balance(rt, pm), before + 100);
});

test("Telegram: a second tap, or an old card whose debt was paid meanwhile, changes nothing", () => {
  const { rt, person, pm, tap } = telegramSetup();
  repay(rt, person, pm, 100);
  const before = balance(rt, pm);
  assert.match(tap("waitpay:tg-1", 2), /no longer waiting/);
  assert.equal(entryOf(rt, "tg-1").status, "pending");
  assert.equal(balance(rt, pm), before);
});

test("Telegram: a different amount, or no account yet, does not ask; choosing Confirm stays possible", () => {
  const { rt, card } = telegramSetup();
  rt.run(`updateEntryFields('tg-1', { payment_method_id: '' });`);
  let c = card();
  assert.doesNotMatch(c.text, /waiting for from/);
  assert.equal(c.reply_markup.inline_keyboard[0][0].callback_data, "confirm:tg-1");
  rt.run(`updateEntryFields('tg-1', { payment_method_id: 'w-pm', amount: 99 });`);
  c = card();
  assert.doesNotMatch(c.text, /waiting for from/);
});

test("Telegram speaks the copy's language", () => {
  const { rt, card, tap } = telegramSetup("es");
  const c = card();
  assert.match(c.text, /¿Es este el pago que esperabas de Client Test/);
  assert.equal(c.reply_markup.inline_keyboard[0][0].text, "⏳ Sí, ese pago");
  assert.match(tap("waitpay:tg-1", 3), /Registrado como el pago de Client Test/);
  assert.equal(rt.rows("Entries").filter((x) => x.id === "tg-1" && x.type === "income" && x.status === "confirmed").length, 0);
});
