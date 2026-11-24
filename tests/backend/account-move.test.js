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
  assert.equal(p.counts.links, 0, "Yape cannot ride on an Interbank card: dropped, not moved");
  assert.deepEqual(p.droppedLinks, ["Yape"]);
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
  const old = String(pms.find((p) => p.id === newCard.id).old_last_4).split("|");
  assert.equal(old[0], "1111");
  assert.equal(old[1], oldCard.bank_id, "remembered with the old card's bank");
  assert.match(old[2], /^\d{4}-\d{2}-\d{2}$/, "and the day of the move");
  const ob = rows(rt, "Account Opening Balances");
  assert.deepEqual(ob.filter((r) => r.payment_method_id === newCard.id).map((r) => r.id).sort(), ["ob-new-pen", "ob-old-usd"]);
  assert.equal(run(rt, "getSettingsMap()").yape_pen, "");
});

test("Undo puts everything back as it was", () => {
  const { rt, oldCard, newCard, ex } = setup();
  const before = rows(rt, "Entries").filter((e) => e.payment_method_id === oldCard.id || e.to_payment_method_id === oldCard.id).map((e) => e.id).sort();
  const res = rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  rt.api("undoAccountMove", { move_id: res.move_id });
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
  const debit = rows(rt, "Payment Methods").find((p) => p.type === "debit");
  assert.throws(() => rt.api("moveAccountHistory", { from: oldCard.id, to: debit.id }), /same kind/, "a card's history never goes to a bank account");
  assert.throws(() => rt.api("moveAccountHistory", { from: "nope", to: oldCard.id }));
});

const stmtFor = (bank) => ({ key: "1111", kind: "visa", bank, holder: "", verified: true, file_name: "s.pdf",
  balances: { PEN: { closing: 10 } }, period: { start: "2019-03-01", end: "2019-03-31" },
  lines: [{ date: "2019-03-05", description: "COMPRA MADE UP SHOP", amount: -12.34, currency: "PEN" }] });

test("old digits never count for another bank: that statement is offered as a new account instead", () => {
  const { rt, oldCard, newCard } = setup();
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  const p = rt.api("planStatementHistory", { statements: [stmtFor("BBVA")] });
  assert.equal(p.summary.newAccounts.length, 1, "a BBVA statement ending in 1111 is not the moved Interbank card");
  assert.equal(p.summary.counts.expenses, 0);
  assert.equal(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111', { bankName: 'BBVA' }).length`), 0);
  assert.equal(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111', { bankName: 'Interbank' }).length`), 1);
  assert.equal(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111', {}).length`), 1, "a source with no bank (Apple Pay) still finds it");
});

test("old digits stop counting 6 months after the move; current digits of another account always win", () => {
  const { rt, oldCard, newCard } = setup();
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  const value = run(rt, `getAllRows('Payment Methods').filter(function (p) { return p.id === ${JSON.stringify(newCard.id)}; })[0].old_last_4`);
  const stale = String(value).replace(/\|\d{4}-\d{2}-\d{2}$/, "|2020-01-01");
  rt.run(`setPmOldLast4_(${JSON.stringify(newCard.id)}, ${JSON.stringify(stale)})`);
  const p = rt.api("planStatementHistory", { statements: [stmtFor("Interbank")] });
  assert.equal(p.summary.newAccounts.length, 1, "too old: offered as a new account");
  assert.equal(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111', {}).length`), 0);
  assert.equal(run(rt, `stmtPmForKey_(getAllRows('Payment Methods'), '1111').id`), newCard.id, "a record already saved still shows its account");
  // Fresh again, but another account now has 1111 as its own digits: that one wins.
  rt.run(`setPmOldLast4_(${JSON.stringify(newCard.id)}, ${JSON.stringify(String(value))})`);
  const bank = rt.api("addBank", { name: "Interbank" });
  const other = rt.api("savePaymentMethod", { nickname: "Another made-up card", type: "credit", bank_id: bank.id, last_4: "1111" });
  assert.deepEqual(run(rt, `pmsWithLast4_(getAllRows('Payment Methods'), '1111', { bankName: 'Interbank' }).map(function (p) { return p.id; })`), [other.id]);
});

test("a BCP e-mail with the old card's digits lands on the account that took its history, even at another bank", () => {
  const { rt } = freshApp({ small: true });
  const { bcpEmail } = require("./helpers");
  const pms = rows(rt, "Payment Methods");
  const main = pms.find((p) => p.nickname === "Main debit"), daily = pms.find((p) => p.nickname === "Daily debit");
  rt.api("savePaymentMethod", { id: main.id, nickname: main.nickname, type: main.type, bank_id: main.bank_id, last_4: "1234" });
  rt.api("moveAccountHistory", { from: main.id, to: daily.id });
  bcpEmail(rt, { op: "MOVE-OLD-1" });
  rt.run("processEmails()");
  const e = rows(rt, "Entries").find((x) => String(x.external_id || "").indexOf("MOVE-OLD-1") !== -1);
  assert.ok(e, "the e-mail was read");
  assert.equal(e.payment_method_id, daily.id);
});

test("Yape / Plin move only where the new account can carry them; otherwise dropped and named", () => {
  const { rt, oldCard, newCard } = setup();   // yape_pen points at the old Interbank card (made-up; the app would not allow it)
  const p = rt.api("previewAccountMove", { from: oldCard.id, to: newCard.id });
  assert.deepEqual(p.droppedLinks, ["Yape"], "Yape needs a BCP account");
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  assert.equal(run(rt, "getSettingsMap()").yape_pen, "");
  // Plin on an Interbank card follows it to another Interbank card
  const { rt: rt2, oldCard: o2, newCard: n2 } = setup();
  rt2.run(`setSetting_('yape_pen', ''); setSetting_('plin_pen', ${JSON.stringify(o2.id)})`);
  assert.deepEqual(rt2.api("previewAccountMove", { from: o2.id, to: n2.id }).droppedLinks, []);
  rt2.api("moveAccountHistory", { from: o2.id, to: n2.id });
  assert.equal(run(rt2, "getSettingsMap()").plin_pen, n2.id);
});

test("an old account with no bank: its digits are remembered only when a bank is picked", () => {
  const { rt } = freshApp({ entries: 20 });
  const bank = rt.api("addBank", { name: "Interbank" });
  const a = rt.api("savePaymentMethod", { nickname: "Card with no bank", type: "credit", bank_id: "", last_4: "3333" });
  const b = rt.api("savePaymentMethod", { nickname: "Its new card", type: "credit", bank_id: bank.id, last_4: "4444" });
  assert.equal(rt.api("previewAccountMove", { from: a.id, to: b.id }).needsBank, true);
  rt.api("moveAccountHistory", { from: a.id, to: b.id });
  assert.equal(String(rows(rt, "Payment Methods").find((p) => p.id === b.id).old_last_4 || ""), "", "no bank: not remembered");
  const c = rt.api("savePaymentMethod", { nickname: "Another card with no bank", type: "credit", bank_id: "", last_4: "5555" });
  rt.api("moveAccountHistory", { from: c.id, to: b.id, old_bank_id: bank.id });
  assert.match(String(rows(rt, "Payment Methods").find((p) => p.id === b.id).old_last_4), new RegExp("^5555\\|" + bank.id + "\\|"));
});

test("a save that still carries the deleted account's id lands on the new account", () => {
  const { rt, oldCard, newCard } = setup();
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  const cat = rows(rt, "Categories").find((c) => c.type === "expense").id;
  const e = rt.api("createEntry", { type: "expense", date: "2026-02-02", amount: 9.99, currency: "PEN", category_id: cat, description: "Made-up late save", payment_method_id: oldCard.id, paid_by: "me" });
  assert.equal(rows(rt, "Entries").find((x) => x.id === e.id).payment_method_id, newCard.id);
  const other = rows(rt, "Entries").find((x) => x.type === "expense" && x.payment_method_id !== newCard.id);
  rt.api("updateEntry", { id: other.id, fields: { payment_method_id: oldCard.id } });
  assert.equal(rows(rt, "Entries").find((x) => x.id === other.id).payment_method_id, newCard.id, "an edit from a stale phone too");
  // Restored: no more forwarding
  const res2 = rt.api("listAccountMoves", {}).moves[0];
  rt.api("restoreAccountMove", { move_id: res2.id });
  const e2 = rt.api("createEntry", { type: "expense", date: "2026-02-03", amount: 1.11, currency: "PEN", category_id: cat, description: "Made-up after restore", payment_method_id: oldCard.id, paid_by: "me" });
  assert.equal(rows(rt, "Entries").find((x) => x.id === e2.id).payment_method_id, oldCard.id);
});

test("each move waits in Recently deleted; Restore later brings it back, leaving what changed since", () => {
  const { rt, oldCard, newCard, ex } = setup();
  rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  const list = rt.api("listAccountMoves", {});
  assert.equal(list.days, 30);
  assert.equal(list.moves.length, 1);
  assert.equal(list.moves[0].from_name, "Old made-up card");
  assert.equal(list.moves[0].counts.entries, 6);
  // After the move: one moved entry edited onto another account, one new entry on the new card.
  const third = rows(rt, "Payment Methods").find((p) => p.type === "credit" && p.id !== newCard.id);
  rt.api("updateEntry", { id: ex[0].id, fields: { payment_method_id: third.id } });
  rt.run(`appendRowObject('Entries', { id: 'later-1', type: 'expense', date: '2026-03-01', amount: 5, currency: 'PEN', payment_method_id: ${JSON.stringify(newCard.id)}, status: 'confirmed', source: 'manual' })`);
  rt.api("restoreAccountMove", { move_id: list.moves[0].id });
  const entries = rows(rt, "Entries");
  assert.equal(entries.find((x) => x.id === ex[0].id).payment_method_id, third.id, "changed since: left as it is");
  assert.equal(entries.find((x) => x.id === ex[1].id).payment_method_id, oldCard.id);
  assert.equal(entries.find((x) => x.id === "later-1").payment_method_id, newCard.id, "new since: stays");
  assert.equal(rt.api("listAccountMoves", {}).moves.length, 0, "the record leaves Recently deleted");
  assert.throws(() => rt.api("restoreAccountMove", { move_id: list.moves[0].id }), /no longer/);
});

test("a big move's Undo is stored in several parts and still restores", () => {
  const { rt, oldCard, newCard } = setup();
  const many = Array.from({ length: 1500 }, (_, i) => `{ id: 'bulk-${i}-made-up-id-padding-padding', type: 'expense', date: '2026-01-15', amount: 1, currency: 'PEN', payment_method_id: ${JSON.stringify(oldCard.id)}, status: 'confirmed', source: 'manual' }`);
  rt.run(`appendObjectsBatch_('Entries', [${many.join(",")}])`);
  const res = rt.api("moveAccountHistory", { from: oldCard.id, to: newCard.id });
  assert.ok(rows(rt, "Account Moves").length > 1, "split over several rows");
  rt.api("undoAccountMove", { move_id: res.move_id });
  assert.equal(rows(rt, "Entries").filter((e) => e.payment_method_id === oldCard.id).length, 1506, "1,500 + the 5 expenses + the restored card-to-card transfer");
});

// Company copies (Business 2): a move never changes a closed month, and every row it moves is in the change log.
test("company copy: a closed month stops the move; reopened, the move is logged row by row and the close stays honest", () => {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Made-up Co", projects: ["Made-up project"] });
  const ym = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 7); })();
  const bank = rt.api("addBank", { name: "Interbank" });
  const a = rt.api("savePaymentMethod", { nickname: "Old company card", type: "credit", bank_id: bank.id, last_4: "6666" });
  const b = rt.api("savePaymentMethod", { nickname: "New company card", type: "credit", bank_id: bank.id, last_4: "7777" });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  const e = rt.api("createEntry", { type: "expense", date: `${ym}-10`, amount: 50, currency: "PEN", category_id: cat, description: "Made-up cement", payment_method_id: a.id, paid_by: "me" });
  rt.api("closeMonth", { month: ym, bank: [] });
  assert.deepEqual(rt.api("previewAccountMove", { from: a.id, to: b.id }).closedMonths, [ym]);
  assert.throws(() => rt.api("moveAccountHistory", { from: a.id, to: b.id }), new RegExp(ym));
  assert.equal(rt.rows("Entries").find((x) => x.id === e.id).payment_method_id, a.id, "nothing moved");
  rt.api("reopenMonth", { month: ym });
  rt.api("moveAccountHistory", { from: a.id, to: b.id });
  const line = rt.api("listChangeLog", { entry_id: e.id }).lines.find((l) => l.field === "payment_method_id");
  assert.ok(line, "the move is in the change log");
  assert.equal(line.before, a.id);
  assert.equal(line.after, b.id);
  rt.api("closeMonth", { month: ym, bank: [] });
  assert.equal(rt.api("getMonthClose", { month: ym }).changed, false);
});

// Owner's test, 2026-11-23: both cards had their own starting balance; the old card's debt on the new card's start date vanished.
function balanceCase() {
  const { rt } = freshApp({ entries: 20 });
  const bank = rt.api("addBank", { name: "Interbank" });
  const a = rt.api("savePaymentMethod", { nickname: "Made-up Classic", type: "credit", bank_id: bank.id, last_4: "1111" });
  const b = rt.api("savePaymentMethod", { nickname: "Made-up Platinum", type: "credit", bank_id: bank.id, last_4: "2222" });
  const debit = rows(rt, "Payment Methods").find((p) => p.type === "debit");
  const cat = rows(rt, "Categories").find((c) => c.type === "expense").id;
  const d = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return t.toISOString().slice(0, 10); };
  const spend = (pm, n, amount) => rt.api("createEntry", { type: "expense", date: d(n), amount, currency: "PEN", category_id: cat, description: "Made-up", payment_method_id: pm, paid_by: "me", status: "confirmed" });
  const move = (from, to, n, amount) => rt.api("createEntry", { type: "transfer", date: d(n), amount, currency: "PEN", payment_method_id: from, to_payment_method_id: to, description: "Made-up", paid_by: "me", status: "confirmed" });
  rt.api("setPaymentMethodOpeningBalance", { id: a.id, balances: [{ currency: "PEN", amount: -350, date: d(90) }] });
  rt.api("setPaymentMethodOpeningBalance", { id: b.id, balances: [{ currency: "PEN", amount: -80, date: d(20) }] });
  spend(a.id, 60, 400); move(debit.id, a.id, 50, 300); spend(a.id, 10, 50);   // old card: −350 −400 +300 −50
  spend(b.id, 5, 100); move(a.id, b.id, 15, 120);                              // new card: −80 −100 +120; old −120
  const bal = (id) => (rt.api("listPaymentMethodBalances", {}).find((r) => r.id === id) || { balances: [] }).balances.find((x) => x.currency === "PEN").amount;
  return { rt, a, b, bal };
}

test("both starting balances: the window offers both results; by default the two balances are added together", () => {
  const { rt, a, b, bal } = balanceCase();
  const before = bal(a.id) + bal(b.id);
  assert.equal(Math.round(before * 100) / 100, -620 + -60);
  const ch = rt.api("previewAccountMove", { from: a.id, to: b.id }).balanceChoices;
  assert.equal(ch.length, 1);
  assert.equal(ch[0].currency, "PEN");
  assert.equal(ch[0].old_owed, -450, "what the old card held on the new card's start date (−350 −400 +300)");
  assert.equal(ch[0].keep, -230, "−80 −100 −50 (the old card's later purchase); the transfer between them is removed");
  assert.equal(ch[0].add, -680);
  const res = rt.api("moveAccountHistory", { from: a.id, to: b.id });
  assert.equal(bal(b.id), -680, "nothing disappears: the same as the two balances before");
  rt.api("undoAccountMove", { move_id: res.move_id });
  assert.equal(bal(a.id), -620);
  assert.equal(bal(b.id), -60, "the new card's starting balance is back to what it was");
});

test("\"already included\": the new card keeps its starting balance as it is", () => {
  const { rt, a, b, bal } = balanceCase();
  rt.api("moveAccountHistory", { from: a.id, to: b.id, keep_balances: ["PEN"] });
  assert.equal(bal(b.id), -230);
});
