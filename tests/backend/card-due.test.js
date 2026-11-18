// A card statement's pay-by date and what it means today (owner's plan, 2026-11-18). Made-up rows and amounts only; the readers were
// checked on the owner's real statements on his Mac (four banks), never copied here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const P = require("../../docs/statement-parsers.js");
const { freshApp } = require("./helpers");
const rows = (a) => a.map((t) => ({ text: t, cells: [{ str: t, x: 0 }] }));

test("the pay-by date is read only next to its label: same row, or alone at the start of one of the next rows", () => {
  assert.equal(P.dueDateOf(rows(["CICLO DE FACTURACION del 09/08/2026 al 08/09/2026 FECHA LIMITE DE PAGO 05/10/2026"])), "2026-10-05");
  assert.equal(P.dueDateOf(rows(["Al cierre de 26/08/2026", "ULTIMO DIA DE PAGO PAGO DEL MES PAGO MINIMO", "S/ 10.00 S/ 1.00", "21/09/2026"])), "2026-09-21");
  assert.equal(P.dueDateOf(rows(["LIMA Fecha límite de pago", "19/10/26"])), "2026-10-19", "a 2-digit year");
  assert.equal(P.dueDateOf(rows(["Último día de pago 05/11/2026"])), "2026-11-05");
});

test("no label, no date; a label with no date near it gives none; the cycle's dates never count", () => {
  assert.equal(P.dueDateOf(rows(["del 09/09/2026 al 08/10/2026 05/11/2026"])), "");
  assert.equal(P.dueDateOf(rows(["ULTIMO DIA DE PAGO", "S/ 1.00", "S/ 2.00", "S/ 3.00", "21/09/2026"])), "");
  assert.equal(P.dueDateOf(rows(["Fecha límite de pago 31/02/2026"])), "", "an impossible date is not read");
});

test("the server sums payments INTO the card after the close; one before it, and a refund, do not count", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-cd', nickname: 'Visa Prueba', type: 'credit', bank_id: '', last_4: '0009', currency: 'PEN' });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-sv', nickname: 'Savings Prueba', type: 'debit', bank_id: '', last_4: '0010', currency: 'PEN' });`);
  rt.run(`ensureStatementUploadsSheet_();`);
  rt.run(`appendRowObject('Statement Uploads', { id: 'su-cd', account_key: '0009', payment_method_id: 'pm-cd', kind: 'visa', period_end: '2026-10-26', closing_json: ${JSON.stringify(JSON.stringify({ PEN: { opening: 0, closing: -1000 }, _due: "2026-11-21" }))}, source: 'upload' });`);
  const t = (id, date, amount, o) => rt.run(`appendRowObject('Entries', ${JSON.stringify({ id, type: "transfer", date, amount, currency: "PEN", payment_method_id: "pm-sv", to_payment_method_id: "pm-cd", status: "confirmed", description: "Pago Prueba", ...o })});`);
  t("cd-before", "2026-10-20", 300);
  t("cd-after-1", "2026-11-05", 400);
  t("cd-after-2", "2026-11-09", 100);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "cd-refund", type: "income", date: "2026-11-06", amount: 50, currency: "PEN", payment_method_id: "pm-cd", status: "confirmed", description: "Refund Prueba" })});`);
  const row = rt.api("listPaymentMethodBalances", {}).find((r) => r.id === "pm-cd");
  assert.equal(row.due, "2026-11-21");
  assert.deepEqual(row.paid_since, { PEN: 500 });
  assert.equal(row.last_paid, "2026-11-09");
  assert.deepEqual(row.balances, [{ currency: "PEN", amount: -1000 }], "the date is not mistaken for a currency");
});

test("a card WITH a starting balance keeps its live balance and carries its last statement for the pay-by line (owner, 2026-11-18)", () => {
  const { rt } = freshApp({ entries: 10 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-lv', nickname: 'Visa Viva', type: 'credit', bank_id: '', last_4: '0011', currency: 'PEN' });`);
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-sv', nickname: 'Savings Prueba', type: 'debit', bank_id: '', last_4: '0010', currency: 'PEN' });`);
  rt.run(`buildOpeningsByPm_(getAllRows('Payment Methods')); appendRowObject('Account Opening Balances', { id: 'ob-lv', payment_method_id: 'pm-lv', currency: 'PEN', amount: -200, date: '2026-10-01' });`);
  rt.run(`ensureStatementUploadsSheet_();`);
  rt.run(`appendRowObject('Statement Uploads', { id: 'su-lv', account_key: '0011', payment_method_id: 'pm-lv', kind: 'visa', period_end: '2026-10-26', closing_json: ${JSON.stringify(JSON.stringify({ PEN: { opening: 0, closing: -700 }, _due: "2026-11-21" }))}, source: 'upload' });`);
  rt.run(`appendRowObject('Entries', ${JSON.stringify({ id: "lv-pay", type: "transfer", date: "2026-11-05", amount: 300, currency: "PEN", payment_method_id: "pm-sv", to_payment_method_id: "pm-lv", status: "confirmed", description: "Pago Prueba" })});`);
  const row = rt.api("listPaymentMethodBalances", {}).find((r) => r.id === "pm-lv");
  assert.ok(!row.statement_closed, "still a live balance");
  assert.equal(row.balances[0].amount, 100, "starting balance −200 plus the 300 paid in");
  assert.deepEqual(row.card_statement, { statement_closed: "2026-10-26", balances: [{ currency: "PEN", amount: -700 }], due: "2026-11-21", paid_since: { PEN: 300 }, last_paid: "2026-11-05" });
});

test("the card line: paid, part paid, pay by, nothing recorded after the date — never 'overdue'", () => {
  const app = fs.readFileSync(path.join(__dirname, "../../docs/app.js"), "utf8");
  const src = app.match(/function cardDueText_\(r\) \{[\s\S]*?\n\}/)[0] + "\n" + app.match(/function cardDueTextRaw_\(r\) \{[\s\S]*?\n\}/)[0];
  const T = { "cardDue.paid": "Paid ✓ ({date})", "cardDue.paidSince": "{amount} paid since", "cardDue.left": "{amount} left", "cardDue.payBy": "pay by {date}", "cardDue.wasDue": "was due {date}", "cardDue.nothingRecorded": "No payment recorded since this statement (was due {date})" };
  const tr = (k, p) => T[k].replace(/\{(\w+)\}/g, (_, n) => p[n]);
  const f = new Function("tr", "I18n", "formatAmount", "todayLocalISO", src + "\nreturn cardDueText_;")(tr, { fmtDateMedium: (d) => d.toISOString().slice(5, 10) }, (a, c) => c + " " + a.toFixed(2), () => "2026-11-15");
  const r = (o) => Object.assign({ balances: [{ currency: "PEN", amount: -1000 }], paid_since: {}, due: "2026-11-21", last_paid: "" }, o);
  assert.equal(f(r({ paid_since: { PEN: 1000 }, last_paid: "2026-11-09" })), "Paid ✓ (11-09)");
  assert.equal(f(r({ paid_since: { PEN: 500 } })), "PEN 500.00 paid since · PEN 500.00 left · pay by 11-21");
  assert.equal(f(r({})), "Pay by 11-21", "a capital P: it starts its own line (owner, 2026-11-18)");
  assert.equal(f(r({ due: "2026-11-10" })), "No payment recorded since this statement (was due 11-10)");
  assert.equal(f(r({ due: "" })), "", "no pay-by date and nothing paid: nothing to say");
  assert.equal(f(r({ balances: [{ currency: "PEN", amount: 20 }] })), "", "a card in credit owes nothing");
  assert.doesNotMatch(src, /overdue|vencid/i);
});
