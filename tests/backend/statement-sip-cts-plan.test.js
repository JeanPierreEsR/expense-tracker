// SIP's CTS statement saved through "Bank statements" (2026-11-20): deposits become income in "Salary", interest in "Savings return",
// and a withdrawal already recorded from SIP's "Retiro CTS" e-mail is matched, never recorded twice. An unknown CTS account is proposed.
// Made-up accounts, amounts and dates.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const stmt = (key, lines) => ({ key, kind: "sipcts", verified: true, bank: "SIP", period: { start: lines[0].date, end: "2026-02-01" },
  balances: { PEN: { opening: 0, closing: lines.reduce((s, l) => Math.round((s + l.amount) * 100) / 100, 0) } }, file_name: "EECC_CTS.pdf", lines });
const plan = (rt, s) => JSON.parse(rt.run(`JSON.stringify(planStatementHistory(${JSON.stringify({ statements: [s] })}))`));
const apply = (rt, s, actions) => JSON.parse(JSON.stringify(rt.run(`applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "EECC_CTS.pdf", statements: [s], actions })})`)));

function setup() {
  const { rt } = freshApp({ entries: 50 });
  rt.run(`appendRowObject('Payment Methods', { id: 'pm-cts', nickname: 'CTS prueba', type: 'debit', bank_id: '', last_4: '5555', currency: 'PEN' });
          appendRowObject('Payment Methods', { id: 'pm-dest', nickname: 'Destino prueba', type: 'debit', bank_id: '', last_4: '6666', currency: 'PEN' });`);
  return rt;
}
const LINES = [
  { date: "2026-01-10", description: "Abono de capital (Semestral)", amount: 1234.57, currency: "PEN", section: "movement", category: "Salary" },
  { date: "2026-01-12", description: "Retiro por libre disponibilidad", amount: -1234.57, currency: "PEN", section: "movement", transfer: true },
  { date: "2026-01-31", description: "Capitalización de intereses", amount: 0.37, currency: "PEN", section: "movement" }
];

test("deposit -> Salary, interest -> Savings return, the e-mail's withdrawal matched (no second transfer)", () => {
  const rt = setup();
  // What SIP's "Retiro CTS" e-mail recorded (EmailParser.gs): a transfer from the CTS account, a day before the statement's date.
  rt.run(`appendRowObject('Entries', { id: 'e-retiro', type: 'transfer', date: '2026-01-11', amount: 1234.57, currency: 'PEN', description: 'Retiro CTS',
          payment_method_id: 'pm-cts', to_payment_method_id: 'pm-dest', status: 'confirmed', source: 'email', paid_by: 'me', created_at: '2026-01-11 10:00:00' });`);
  const s = stmt("5555", LINES);
  const p = plan(rt, s);
  const byLine = (li) => p.actions.filter((a) => a.line === li).map((a) => a.type);
  assert.deepEqual(byLine(0), ["add_history_income"]);
  assert.deepEqual(byLine(2), ["add_history_income"]);
  assert.ok(!byLine(1).some((t) => /^add_/.test(t)), "the withdrawal is already in the app: " + JSON.stringify(byLine(1)));
  apply(rt, s, p.actions);
  const cats = rt.rows("Categories");
  const catName = (id) => (cats.find((c) => c.id === id) || {}).name;
  const made = rt.rows("Entries").filter((e) => String(e.external_id || "").indexOf("stmt-") === 0);
  const dep = made.find((e) => Number(e.amount) === 1234.57);
  const intr = made.find((e) => Number(e.amount) === 0.37);
  assert.equal(dep.type, "income");
  assert.equal(catName(dep.category_id), "Salary");
  assert.equal(dep.payment_method_id, "pm-cts");
  assert.equal(intr.type, "income");
  assert.equal(catName(intr.category_id), "Savings return");
  assert.equal(rt.rows("Entries").filter((e) => e.type === "transfer" && Number(e.amount) === 1234.57).length, 1, "one transfer only");
});

test("a deposit recorded on the day SIP's e-mail came (a week after the statement's date) is matched, not added again", () => {
  const rt = setup();
  rt.run(`appendRowObject('Entries', { id: 'e-dep', type: 'income', date: '2026-01-17', amount: 1234.57, currency: 'PEN', description: 'CTS',
          payment_method_id: 'pm-cts', status: 'confirmed', source: 'manual', paid_by: 'me', created_at: '2026-01-17 10:00:00' });`);
  const p = plan(rt, stmt("5555", [LINES[0]]));
  assert.ok(!p.actions.some((a) => a.line === 0 && /^add_/.test(a.type)), JSON.stringify(p.actions));
});

test("a CTS account the app does not have is proposed as a new SIP account", () => {
  const rt = setup();
  const p = plan(rt, stmt("7777", LINES));
  const prop = (p.summary.newAccounts || []).find((a) => a.last4 === "7777");
  assert.ok(prop, JSON.stringify(p.summary.newAccounts));
  assert.equal(prop.bank, "SIP");
  assert.equal(prop.type, "debit");
});
