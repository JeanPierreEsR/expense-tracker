// Move an account's history to another account (backend/AccountMove.gs; owner, 2026-11-23: a credit card upgrade). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const rows = (rt, sheet) => run(rt, `getAllRows('${sheet}')`);

function setup() {
  const { rt } = freshApp({ entries: 60 });
  const bank = rt.api("addBank", { name: "Interbank" });
  const oldCard = rt.api("savePaymentMethod", { nickname: "Old made-up card", type: "credit", bank_id: bank.id, last_4: "1111" });
  const newCard = rt.api("savePaymentMethod", { nickname: "New made-up card", type: "credit", bank_id: bank.id, last_4: "2222" });
  // Five existing expenses go on the old card, one on the new one.
  const ex = rows(rt, "Entries").filter((e) => e.type === "expense").slice(0, 6);
  ex.slice(0, 5).forEach((e) => rt.run(`setEntryField_(${JSON.stringify(e.id)}, 'payment_method_id', ${JSON.stringify(oldCard.id)})`));
  rt.run(`setEntryField_(${JSON.stringify(ex[5].id)}, 'payment_method_id', ${JSON.stringify(newCard.id)})`);
  // A transfer between the two cards, a transfer INTO the old card from another account, and starting balances.
  const other = rows(rt, "Payment Methods").find((p) => p.type === "debit");
  rt.run(`ensureEntriesToPaymentMethodColumn_(); appendRowObject('Entries', { id: 'self-1', type: 'transfer', date: '2026-01-10', amount: 50, currency: 'PEN', payment_method_id: ${JSON.stringify(oldCard.id)}, to_payment_method_id: ${JSON.stringify(newCard.id)}, status: 'confirmed', source: 'manual', description: 'Made-up balance move' })`);
  rt.run(`appendRowObject('Entries', { id: 'into-old', type: 'transfer', date: '2026-01-11', amount: 80, currency: 'PEN', payment_method_id: ${JSON.stringify(other.id)}, to_payment_method_id: ${JSON.stringify(oldCard.id)}, status: 'confirmed', source: 'manual', description: 'Made-up card payment' })`);
  rt.run(`ensureAccountOpeningBalancesSheet_();
    appendRowObject('Account Opening Balances', { id: 'ob-old-pen', payment_method_id: ${JSON.stringify(oldCard.id)}, currency: 'PEN', amount: -100, date: '2025-12-31' });
    appendRowObject('Account Opening Balances', { id: 'ob-old-usd', payment_method_id: ${JSON.stringify(oldCard.id)}, currency: 'USD', amount: -10, date: '2025-12-31' });
    appendRowObject('Account Opening Balances', { id: 'ob-new-pen', payment_method_id: ${JSON.stringify(newCard.id)}, currency: 'PEN', amount: -5, date: '2026-01-01' });
    setSetting_('yape_pen', ${JSON.stringify(oldCard.id)});`);
  return { rt, oldCard, newCard, ex, other };
}

test("the preview counts what would move, without changing anything", () => {
  const { rt, oldCard, newCard } = setup();
  const p = rt.api("previewAccountMove", { from: oldCard.id, to: newCard.id });
  assert.equal(p.counts.entries, 6, "five expenses + the transfer into the old card");
  assert.equal(p.counts.selfTransfers, 1);
  assert.equal(p.selfTransfers[0].id, "self-1");
  assert.equal(p.counts.balances, 1, "USD moves");
  assert.equal(p.counts.balancesDropped, 1, "PEN: the new card keeps its own");
  assert.equal(p.counts.links, 1);
  assert.equal(rows(rt, "Entries").filter((e) => e.payment_method_id === oldCard.id).length, 6);
});

test("the move repoints everything, deletes the card-to-card transfer and the old account, and the new one keeps the old digits", () => {
  const { rt, oldCard, newCard, ex } = setup();
  const res = rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  assert.equal(res.counts.entries, 6);
  const entries = rows(rt, "Entries");
  assert.equal(entries.filter((e) => e.payment_method_id === oldCard.id || e.to_payment_method_id === oldCard.id).length, 0);
  ex.slice(0, 5).forEach((e) => assert.equal(entries.find((x) => x.id === e.id).payment_method_id, newCard.id));
  assert.equal(entries.find((x) => x.id === "into-old").to_payment_method_id, newCard.id);
  assert.equal(entries.some((x) => x.id === "self-1"), false, "the card-to-card transfer is gone");
  assert.equal(run(rt, "listDeletedEntries()").batches.length >= 1, true, "…with a safety copy");
  const pms = rows(rt, "Payment Methods");
  assert.equal(pms.some((p) => p.id === oldCard.id), false);
  assert.equal(String(pms.find((p) => p.id === newCard.id).old_last_4), "1111");
  const ob = rows(rt, "Account Opening Balances");
  assert.deepEqual(ob.filter((r) => r.payment_method_id === newCard.id).map((r) => r.id).sort(), ["ob-new-pen", "ob-old-usd"]);
  assert.equal(run(rt, "getSettingsMap()").yape_pen, newCard.id);
});

test("Undo puts everything back as it was", () => {
  const { rt, oldCard, newCard, ex } = setup();
  const before = rows(rt, "Entries").filter((e) => e.payment_method_id === oldCard.id || e.to_payment_method_id === oldCard.id).map((e) => e.id).sort();
  const res = rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  rt.api("undoAccountMove", { undo: res.undo });
  const after = rows(rt, "Entries").filter((e) => e.payment_method_id === oldCard.id || e.to_payment_method_id === oldCard.id).map((e) => e.id).sort();
  assert.deepEqual(after, before);
  assert.equal(rows(rt, "Entries").find((e) => e.id === ex[5].id).payment_method_id, newCard.id, "the new card's own entry stays");
  const pm = rows(rt, "Payment Methods").find((p) => p.id === oldCard.id);
  assert.equal(String(pm.last_4), "1111");
  assert.equal(pm.nickname, "Old made-up card");
  assert.equal(String(rows(rt, "Payment Methods").find((p) => p.id === newCard.id).old_last_4 || ""), "");
  assert.deepEqual(rows(rt, "Account Opening Balances").filter((r) => r.payment_method_id === oldCard.id).map((r) => r.id).sort(), ["ob-old-pen", "ob-old-usd"]);
  assert.equal(run(rt, "getSettingsMap()").yape_pen, oldCard.id);
});

test("a statement or e-mail with the old digits finds the new account", () => {
  const { rt, oldCard, newCard } = setup();
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  const pms = rows(rt, "Payment Methods");
  assert.equal(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111').map(function (p) { return p.id; })`)[0], newCard.id);
  assert.equal(run(rt, `stmtPmForKey_(getAllRows('Payment Methods'), '1111').id`), newCard.id);
  const p = rt.api("planStatementHistory", { statements: [{ key: "1111", kind: "visa", bank: "Interbank", holder: "", verified: true, file_name: "s.pdf",
    balances: { PEN: { closing: 10 } }, period: { start: "2019-03-01", end: "2019-03-31" },
    lines: [{ date: "2019-03-05", description: "COMPRA MADE UP SHOP", amount: -12.34, currency: "PEN" }] }] });
  assert.deepEqual(p.summary.newAccounts, [], "not offered as a new account");
  assert.equal(p.summary.counts.expenses, 1);
  assert.ok(pms.length);
});

test("refused: the same account, the built-in Cash, an unknown one", () => {
  const { rt, oldCard } = setup();
  assert.throws(() => rt.api("moveAccountHistory", { from: oldCard.id, to: oldCard.id }));
  rt.api("getMeta", {});
  const cash = run(rt, "getSettingsMap()").cash_account_id;
  assert.ok(cash);
  assert.throws(() => rt.api("moveAccountHistory", { from: cash, to: oldCard.id }));
  assert.throws(() => rt.api("moveAccountHistory", { from: "nope", to: oldCard.id }));
});
