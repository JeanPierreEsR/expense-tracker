// "Already read" in the statements Inbox shows the latest statement of EACH account (owner, 2026-11-18; it used to be the 8 newest of
// any account). The account is recorded when the statement is saved. Made-up bank, accounts and dates only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  rt.api("savePaymentMethod", { nickname: "Ahorro Uno", type: "debit", currencies: ["PEN"], last_4: "1357" });
  rt.api("savePaymentMethod", { nickname: "Ahorro Dos", type: "debit", currencies: ["PEN"], last_4: "0246" });
  rt.run("ensureStatementInboxSheet_(); 1");
  const add = (id, received, extra) => rt.run(`appendRowObject('Statement Inbox', ${JSON.stringify(Object.assign({ id, message_id: "m-" + id,
    attachment_name: "estado.pdf", sender_key: "self", bank_label: "Banco Prueba", bank_keyword: "prueba", received, status: "new", size_kb: 50,
    notified: "", created_at: received }, extra || {}))}); 1`);
  const stmt = (key, end) => ({ key, kind: "savings", verified: true, period: { start: end.slice(0, 8) + "01", end }, balances: {}, file_name: "estado.pdf",
    lines: [{ date: end, description: "COMPRA PRUEBA " + key + end, amount: -10, currency: "PEN" }] });
  const save = (s, id) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "h", statements: [s], inboxIds: [id],
    inboxKeys: { [id]: s.key }, actions: [{ type: "add_history_expense", stmt: 0, line: 0 }] })})`);
  const read = () => rt.api("listStatementInbox", {}).items.filter((i) => i.status === "processed");
  return { rt, add, stmt, save, read };
}

test("two accounts of one bank each keep their latest read statement, named by account", () => {
  const { add, stmt, save, read } = setup();
  add("uno-sep", "2026-10-03"); add("uno-oct", "2026-11-03"); add("dos-oct", "2026-11-04");
  save(stmt("1357", "2026-09-30"), "uno-sep");
  save(stmt("1357", "2026-10-31"), "uno-oct");
  save(stmt("0246", "2026-10-31"), "dos-oct");
  const r = read();
  assert.deepEqual(r.map((i) => i.id), ["dos-oct", "uno-oct"], "newest first, one per account; September's is hidden");
  assert.deepEqual(r.map((i) => i.account), ["Ahorro Dos …0246", "Ahorro Uno …1357"], "a leading zero is kept");
});

test("more than 8 accounts are all shown", () => {
  const { rt, add, read } = setup();
  for (let n = 1; n <= 10; n++) add("a" + n, `2026-11-${String(n).padStart(2, "0")}`, { status: "processed", account_key: String(1000 + n) });
  assert.equal(read().length, 10);
  assert.equal(read()[0].account, "", "an account the app does not track keeps the bank's name in the title");
  assert.ok(rt);
});

test("rows read before the account was recorded count as one per bank", () => {
  const { add, read } = setup();
  add("old1", "2026-09-03", { status: "processed" });
  add("old2", "2026-10-03", { status: "processed" });
  add("other", "2026-10-05", { status: "processed", sender_key: "otro", bank_label: "Otro Banco" });
  assert.deepEqual(read().map((i) => i.id), ["other", "old2"]);
});

test("an account-less row drops out once that bank has a newer statement read with its account", () => {
  const { add, read } = setup();
  add("old", "2026-10-03", { status: "processed" });
  add("new", "2026-11-03", { status: "processed", account_key: "1357" });
  add("older-other-bank", "2026-09-03", { status: "processed", sender_key: "otro", bank_label: "Otro Banco" });
  assert.deepEqual(read().map((i) => i.id), ["new", "older-other-bank"]);
});

test("a copy whose Inbox tab predates the account column gets it on the first save", () => {
  const { rt } = freshApp({ small: true });
  rt.api("savePaymentMethod", { nickname: "Ahorro Uno", type: "debit", currencies: ["PEN"], last_4: "1357" });
  rt.run("ensureStatementSheet_('Statement Inbox', STATEMENT_INBOX_COLUMNS_.filter(function (c) { return c !== 'account_key'; }), []); 1");
  rt.run(`appendRowObject('Statement Inbox', ${JSON.stringify({ id: "x", message_id: "m-x", attachment_name: "estado.pdf", sender_key: "self",
    bank_label: "Banco Prueba", bank_keyword: "prueba", received: "2026-11-03", status: "new", size_kb: 50, notified: "", created_at: "2026-11-03" })}); 1`);
  const s = { key: "1357", kind: "savings", verified: true, period: { start: "2026-10-01", end: "2026-10-31" }, balances: {}, file_name: "estado.pdf",
    lines: [{ date: "2026-10-31", description: "COMPRA PRUEBA", amount: -10, currency: "PEN" }] };
  run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "h", statements: [s], inboxIds: ["x"], inboxKeys: { x: "1357" },
    actions: [{ type: "add_history_expense", stmt: 0, line: 0 }] })})`);
  const row = rt.rows("Statement Inbox").find((r) => r.id === "x");
  assert.equal(row.status, "processed");
  assert.equal(String(row.account_key), "1357");
  assert.equal(rt.api("listStatementInbox", {}).items[0].account, "Ahorro Uno …1357");
});

test("waiting statements are all listed, as before", () => {
  const { add, rt } = setup();
  for (let n = 1; n <= 12; n++) add("w" + n, `2026-11-${String(n).padStart(2, "0")}`);
  assert.equal(rt.api("listStatementInbox", {}).items.filter((i) => i.status === "new").length, 12);
});
