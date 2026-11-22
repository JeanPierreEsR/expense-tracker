// Inbox statements count as read ONLY once saved through the last step (owner, 2026-11-11), never guessed from other saved statements,
// and Undo puts them back as waiting. Made-up bank, accounts and dates only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function setup() {
  const { rt } = freshApp({ small: true });
  rt.api("savePaymentMethod", { nickname: "Ahorro Prueba", type: "debit", currencies: ["PEN"], last_4: "1357" });
  rt.run("ensureStatementInboxSheet_(); 1");
  const add = (id, received) => rt.run(`appendRowObject('Statement Inbox', ${JSON.stringify({ id, message_id: "m-" + id, attachment_name: "estado.pdf",
    sender_key: "self", bank_label: "Banco Prueba", bank_keyword: "prueba", received, status: "new", size_kb: 50, notified: "", created_at: received })}); 1`);
  add("oct", "2026-11-03");
  add("sep", "2026-10-03");
  const stmt = (end) => ({ key: "1357", kind: "savings", verified: true, period: { start: end.slice(0, 8) + "01", end }, balances: {}, file_name: "estado.pdf",
    lines: [{ date: end, description: "COMPRA PRUEBA", amount: -10, currency: "PEN" }] });
  const save = (s, inboxIds) => run(rt, `applyStatementDecisions(${JSON.stringify({ dryRun: false, filename: "h", statements: [s], inboxIds,
    actions: [{ type: "add_history_expense", stmt: 0, line: 0 }] })})`);
  const status = () => Object.fromEntries(rt.api("listStatementInbox", {}).items.map((i) => [i.id, [i.status, i.probably_processed]]));
  return { rt, stmt, save, status };
}

test("saving September's statement does not make October's look read", () => {
  const { stmt, save, status } = setup();
  save(stmt("2026-09-30"), ["sep"]);
  const s = status();
  assert.deepEqual(s.sep, ["processed", false]);
  assert.deepEqual(s.oct, ["new", false], "no guessing from other statements");
});

test("opening is not reading: only the save marks it, and Undo puts it back as waiting", () => {
  const { rt, stmt, save, status } = setup();
  assert.deepEqual(status().oct, ["new", false]);
  const res = save(stmt("2026-10-31"), ["oct"]);
  assert.deepEqual(status().oct, ["processed", false]);
  run(rt, `undoStatementBatch({ batchId: ${JSON.stringify(res.batchId)} })`);
  assert.deepEqual(status().oct, ["new", false], "waiting again after Undo");
});
