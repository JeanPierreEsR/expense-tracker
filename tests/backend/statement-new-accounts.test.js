// New accounts from bank statements (backend/StatementAccounts.gs): a statement for an account the app does not have is proposed with
// defaults, created with one call, and then read normally. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const pmRows = (rt) => run(rt, "getAllRows('Payment Methods')");

function stmt(over = {}) {
  return { key: "7777", kind: "visa", bank: "Interbank", holder: "", verified: true, file_name: "s.pdf", balances: { PEN: { closing: 100 } },
    period: { start: "2019-03-01", end: "2019-03-31" },
    lines: [{ date: "2019-03-05", description: "COMPRA BODEGA LA ESQUINA", amount: -23.47, currency: "PEN" }, { date: "2019-03-12", description: "COMPRA FARMACIA SUR", amount: -40.1, currency: "PEN" }], ...over };
}
const plan = (rt, statements) => run(rt, `planStatementHistory(${JSON.stringify({ statements })})`);

test("a statement for an unknown account is proposed with defaults, and its lines wait", () => {
  const { rt } = freshApp({ entries: 20 });
  const p = plan(rt, [stmt()]);
  assert.equal(p.summary.newAccounts.length, 1);
  const a = p.summary.newAccounts[0];
  assert.equal(a.last4, "7777");
  assert.equal(a.bank, "Interbank");
  assert.equal(a.type, "credit");
  assert.equal(a.kind, "credit");
  assert.match(a.nickname, /Interbank credit \(7777\)/);
  assert.equal(p.summary.counts.expenses, 0, "nothing is planned until the account exists");
  assert.equal(p.summary.leftOut.noAccount, 2);
  assert.equal(pmRows(rt).some((r) => String(r.last_4) === "7777"), false, "proposing creates nothing");
});

test("creating it makes an automatic-name account, reuses or adds the bank, and the statement is then read normally", () => {
  const { rt } = freshApp({ entries: 20 });
  const a = plan(rt, [stmt()]).summary.newAccounts[0];
  const res = rt.api("createStatementAccounts", { accounts: [{ last4: a.last4, bank: a.bank, kind: a.kind }] });
  assert.equal(res.created.length, 1);
  const pm = pmRows(rt).find((r) => r.id === res.created[0].id);
  assert.equal(pm.type, "credit");
  assert.equal(String(pm.last_4), "7777", "the digits are stored as text");
  assert.equal(pm.alias_auto, "yes");
  assert.equal(pm.alias_show_last4, "yes");
  const banks = run(rt, "getAllRows('Banks')").filter((b) => b.name === "Interbank");
  assert.equal(banks.length, 1, "no duplicate bank");
  const p2 = plan(rt, [stmt()]);
  assert.deepEqual(p2.summary.newAccounts, []);
  assert.equal(p2.summary.counts.expenses, 2);
});

test("a second call never duplicates the account", () => {
  const { rt } = freshApp({ entries: 20 });
  const body = { accounts: [{ last4: "7777", bank: "Interbank", kind: "credit" }] };
  rt.api("createStatementAccounts", body);
  const again = rt.api("createStatementAccounts", body);
  assert.equal(again.created.length, 0);
  assert.equal(again.existing.length, 1);
  assert.equal(pmRows(rt).filter((r) => String(r.last_4) === "7777").length, 1);
});

test("a bank the app does not have yet is added; two accounts of one bank get different names", () => {
  const { rt } = freshApp({ entries: 20 });
  const res = rt.api("createStatementAccounts", { accounts: [{ last4: "1111", bank: "Banco Nuevo Test", kind: "debit_pen" }, { last4: "2222", bank: "Banco Nuevo Test", kind: "debit_pen" }] });
  assert.equal(res.created.length, 2);
  assert.notEqual(res.created[0].nickname, res.created[1].nickname);
  assert.equal(run(rt, "getAllRows('Banks')").filter((b) => b.name === "Banco Nuevo Test").length, 1);
});

test("an account statement is a debit account, in dollars when the statement is in dollars; AhorraMás keys by currency and uses the digits it read", () => {
  const { rt } = freshApp({ entries: 20 });
  const s1 = stmt({ key: "4444", kind: "savings", bank: "Interbank", balances: { USD: { closing: 5 } }, lines: [{ date: "2019-03-05", description: "ABONO", amount: 50, currency: "USD" }] });
  const s2 = stmt({ key: "AHORRA-PEN", kind: "ahorramas", bank: "AhorraMás", accountLast4: "9090", balances: { PEN: { closing: 5 } }, lines: [{ date: "2019-03-05", description: "ABONO", amount: 50, currency: "PEN" }] });
  const props = plan(rt, [s1, s2]).summary.newAccounts;
  const d = props.find((x) => x.last4 === "4444");
  assert.equal(d.type, "debit"); assert.equal(d.kind, "debit_usd"); assert.match(d.nickname, /dollars/);
  const h = props.find((x) => x.last4 === "9090");
  assert.ok(h, "AhorraMás is proposed from the account digits the reader found");
  assert.equal(h.kind, "debit_pen");
});

test("a known account, a spreadsheet's chosen account and an import without one are never proposed", () => {
  const { rt, data } = freshApp({ entries: 20 });
  const known = data.pms.find((p) => p.last_4);
  const props = plan(rt, [stmt({ key: String(known.last_4).padStart(4, "0") }), stmt({ key: "NOACCOUNT", kind: "csv", bank: "" })]).summary.newAccounts;
  assert.deepEqual(props, []);
});

test("bad input is refused: no digits, no bank, an unknown kind", () => {
  const { rt } = freshApp({ entries: 20 });
  assert.throws(() => rt.api("createStatementAccounts", { accounts: [{ last4: "", bank: "X", kind: "credit" }] }));
  assert.throws(() => rt.api("createStatementAccounts", { accounts: [{ last4: "1234", bank: "", kind: "credit" }] }));
  assert.throws(() => rt.api("createStatementAccounts", { accounts: [{ last4: "1234", bank: "X", kind: "bogus" }] }));
  assert.equal(pmRows(rt).some((r) => String(r.last_4) === "1234"), false);
});
