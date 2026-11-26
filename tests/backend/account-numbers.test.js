// One account, several account numbers (backend/AccountNumbers.gs; owner, 2026-11-26: a BCP account called "Yape" with a number in soles
// and one in dollars), joining two accounts into one, and AhorraMás statements by currency. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, bcpEmail } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));
const rows = (rt, sheet) => run(rt, `getAllRows('${sheet}')`);
const pmById = (rt, id) => rows(rt, "Payment Methods").find((p) => p.id === id);

function bcp(rt) {
  return rows(rt, "Banks").find((b) => b.name === "BCP") || rt.api("addBank", { name: "BCP" });
}
function yapeAccount(rt, more = [{ currency: "USD", digits: "0567" }]) {
  return rt.api("savePaymentMethod", { nickname: "My Yape", type: "debit", bank_id: bcp(rt).id, last_4: "1234", currencies: ["PEN", "USD"], last_4_more: more });
}

test("a bank account in soles and dollars keeps both numbers; the dollars one keeps its leading zero", () => {
  const { rt } = freshApp({ small: true });
  const pm = yapeAccount(rt);
  assert.equal(pm.last_4, "1234");
  assert.equal(pm.last_4_more, "USD:0567");
  assert.equal(String(pmById(rt, pm.id).last_4_more), "USD:0567");
  assert.deepEqual(run(rt, `pmLast4List_(getAllRows('Payment Methods').find(function (p) { return p.id === ${JSON.stringify(pm.id)}; }))`), ["1234", "0567"]);
  // Both numbers find the account, for statements and for the e-mail / Apple Pay lookup.
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), '0567').id"), pm.id);
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), '1234').id"), pm.id);
  assert.equal(run(rt, "pmsWithLast4_(getAllRows('Payment Methods'), '567').length"), 1);
});

test("what the phone sends is cleaned: no main currency twice, no currency the account lacks, bad digits refused", () => {
  const { rt } = freshApp({ small: true });
  const pm = yapeAccount(rt, [{ currency: "PEN", digits: "9999" }, { currency: "EUR", digits: "8888" }, { currency: "USD", digits: "1234" }]);
  assert.equal(pm.last_4_more, "", "PEN is the main number, EUR is not on the account, 1234 is the main digits");
  const before = rows(rt, "Payment Methods").length;
  assert.throws(() => rt.api("savePaymentMethod", { nickname: "Other made-up", type: "debit", bank_id: bcp(rt).id, currencies: ["PEN", "USD"], last_4_more: [{ currency: "USD", digits: "12" }] }), /4/);
  assert.equal(rows(rt, "Payment Methods").length, before, "nothing was saved");
});

test("a card keeps one number whatever its currencies; one currency only clears the other number", () => {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Made-up card", type: "credit", bank_id: bcp(rt).id, last_4: "4321", currencies: ["PEN", "USD"], last_4_more: [{ currency: "USD", digits: "5555" }] });
  assert.equal(card.last_4_more, "");
  const pm = yapeAccount(rt);
  const back = rt.api("savePaymentMethod", { id: pm.id, nickname: "My Yape", type: "debit", bank_id: pm.bank_id, last_4: "1234", currencies: ["PEN"], last_4_more: [] });
  assert.equal(back.last_4_more, "");
  assert.equal(String(pmById(rt, pm.id).last_4_more || ""), "");
});

test("an older phone that sends no last_4_more leaves the other number as it is", () => {
  const { rt } = freshApp({ small: true });
  const pm = yapeAccount(rt);
  const saved = rt.api("savePaymentMethod", { id: pm.id, nickname: "Yape BCP", type: "debit", bank_id: pm.bank_id, last_4: "1234" });
  assert.equal(saved.last_4_more, "USD:0567");
  assert.equal(String(pmById(rt, pm.id).last_4_more), "USD:0567");
});

test("statements: each number has its own coverage row, and a statement with the dollars number is not a new account", () => {
  const { rt } = freshApp({ small: true });
  const pm = yapeAccount(rt);
  const keys = run(rt, "listStatementCoverage()").accounts.map((a) => a.key);
  assert.ok(keys.includes("1234") && keys.includes("0567"));
  const p = rt.api("planStatementHistory", { statements: [{ key: "0567", kind: "bcp", bank: "BCP", holder: "", verified: true, file_name: "s.pdf",
    balances: { USD: { closing: 10 } }, period: { start: "2019-03-01", end: "2019-03-31" },
    lines: [{ date: "2019-03-05", description: "COMPRA MADE UP SHOP", amount: -12.34, currency: "USD" }] }] });
  assert.deepEqual(p.summary.newAccounts, []);
  assert.ok(pm.id);
});

test("a BCP e-mail naming the other number lands on the same account", () => {
  const { rt } = freshApp({ small: true });
  const pms = rows(rt, "Payment Methods");
  const main = pms.find((p) => p.nickname === "Main debit");
  // The made-up BCP e-mail names card ****1234: here it is the account's SECOND number.
  rt.api("savePaymentMethod", { id: main.id, nickname: "My Yape", type: "debit", bank_id: main.bank_id, last_4: "7777", currencies: ["USD", "PEN"], last_4_more: [{ currency: "USD", digits: "1234" }] });
  bcpEmail(rt, { op: "TWO-NUM-1" });
  rt.run("processEmails()");
  const e = rows(rt, "Entries").find((x) => String(x.external_id || "").indexOf("TWO-NUM-1") !== -1);
  assert.ok(e, "the e-mail was read");
  assert.equal(e.payment_method_id, main.id);
});

function twoBcpAccounts(rt) {
  const b = bcp(rt);
  const soles = rt.api("savePaymentMethod", { nickname: "BCP made-up soles", type: "debit", bank_id: b.id, last_4: "1111", currencies: ["PEN"] });
  const dolares = rt.api("savePaymentMethod", { nickname: "BCP made-up dolares", type: "debit", bank_id: b.id, last_4: "2222", currencies: ["USD"] });
  const ex = rows(rt, "Entries").filter((e) => e.type === "expense").slice(0, 3);
  rt.run(`setEntryField_(${JSON.stringify(ex[0].id)}, 'payment_method_id', ${JSON.stringify(dolares.id)})`);
  rt.run(`setSetting_('yape_usd', ${JSON.stringify(dolares.id)}); setSetting_('yape_pen', ${JSON.stringify(soles.id)});`);
  return { soles, dolares, ex };
}

test("join: offered for two accounts of the same bank in different currencies, not for two cards or two banks", () => {
  const { rt } = freshApp({ small: true });
  const { soles, dolares } = twoBcpAccounts(rt);
  const p = rt.api("previewAccountMove", { from: dolares.id, to: soles.id });
  assert.deepEqual(p.merge.currencies, ["PEN", "USD"]);
  assert.deepEqual(p.merge.numbers, [{ currency: "PEN", digits: "1111" }, { currency: "USD", digits: "2222" }]);
  const other = rt.api("addBank", { name: "Interbank" });
  const ibk = rt.api("savePaymentMethod", { nickname: "IBK made-up dolares", type: "debit", bank_id: other.id, last_4: "3333", currencies: ["USD"] });
  assert.equal(rt.api("previewAccountMove", { from: ibk.id, to: soles.id }).merge, null, "another bank");
  const sameCur = rt.api("savePaymentMethod", { nickname: "BCP made-up soles 2", type: "debit", bank_id: bcp(rt).id, last_4: "4444", currencies: ["PEN"] });
  assert.equal(rt.api("previewAccountMove", { from: sameCur.id, to: soles.id }).merge, null, "same currency: a plain move");
  assert.throws(() => rt.api("moveAccountHistory", { from: sameCur.id, to: soles.id, merge: true }), /joined|juntar/);
});

test("join: one account with both currencies, both numbers for good, both Yape links, and a new name", () => {
  const { rt } = freshApp({ small: true });
  const { soles, dolares, ex } = twoBcpAccounts(rt);
  const res = rt.api("moveAccountHistory", { from: dolares.id, to: soles.id, merge: true, merge_name: "My Yape" });
  assert.equal(res.merged, true);
  assert.equal(res.to.nickname, "My Yape");
  const pm = pmById(rt, soles.id);
  assert.equal(pm.nickname, "My Yape");
  assert.equal(String(pm.currencies), "PEN,USD");
  assert.equal(String(pm.last_4), "1111");
  assert.equal(String(pm.last_4_more), "USD:2222");
  assert.equal(String(pm.old_last_4 || ""), "", "own numbers, not a replaced card's old digits");
  assert.equal(pmById(rt, dolares.id), undefined);
  assert.equal(rows(rt, "Entries").find((e) => e.id === ex[0].id).payment_method_id, soles.id);
  const s = run(rt, "getSettingsMap()");
  assert.equal(s.yape_usd, soles.id);
  assert.equal(s.yape_pen, soles.id);
  // Six months later, another bank's statement: still the account's own number.
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), '2222').id"), soles.id);
  assert.equal(run(rt, "pmsWithLast4_(getAllRows('Payment Methods'), '2222', { bankName: 'Interbank' }).length"), 1);
});

test("join can take the old account's own name (it is deleted first); Undo brings both accounts back as they were", () => {
  const { rt } = freshApp({ small: true });
  const { soles, dolares, ex } = twoBcpAccounts(rt);
  const res = rt.api("moveAccountHistory", { from: dolares.id, to: soles.id, merge: true, merge_name: "BCP made-up dolares" });
  assert.equal(pmById(rt, soles.id).nickname, "BCP made-up dolares");
  rt.api("undoAccountMove", { move_id: res.move_id });
  const a = pmById(rt, soles.id), b = pmById(rt, dolares.id);
  assert.equal(a.nickname, "BCP made-up soles");
  assert.equal(String(a.currencies), "PEN");
  assert.equal(String(a.last_4_more || ""), "");
  assert.equal(b.nickname, "BCP made-up dolares");
  assert.equal(String(b.last_4), "2222");
  assert.equal(rows(rt, "Entries").find((e) => e.id === ex[0].id).payment_method_id, dolares.id);
  assert.equal(run(rt, "getSettingsMap()").yape_usd, dolares.id);
});

test("join where the person's main currency is on the OLD account: its number becomes the main one", () => {
  const { rt } = freshApp({ small: true });
  const { soles, dolares } = twoBcpAccounts(rt);
  rt.api("moveAccountHistory", { from: soles.id, to: dolares.id, merge: true });
  const pm = pmById(rt, dolares.id);
  assert.equal(String(pm.last_4), "1111", "PEN, the main currency");
  assert.equal(String(pm.last_4_more), "USD:2222");
  assert.equal(String(pm.currencies), "USD,PEN");
});

test("a plain move (no join) still remembers every number of the old account as old digits", () => {
  const { rt } = freshApp({ small: true });
  const pm = yapeAccount(rt);
  const other = rt.api("savePaymentMethod", { nickname: "BCP made-up new", type: "debit", bank_id: bcp(rt).id, last_4: "9090", currencies: ["PEN", "USD"] });
  rt.api("moveAccountHistory", { from: pm.id, to: other.id });
  const old = String(pmById(rt, other.id).old_last_4).split(",").map((x) => x.split("|")[0]);
  assert.deepEqual(old.sort(), ["0567", "1234"]);
});

test("AhorraMás: a dollars statement goes to the dollars account, not the first one named Ahorra", () => {
  const { rt } = freshApp({ small: true });
  const sip = rt.api("addBank", { name: "SIP" });
  const pen = rt.api("savePaymentMethod", { nickname: "Ahorramas Soles", type: "debit", bank_id: sip.id, last_4: "1010" });
  const usd = rt.api("savePaymentMethod", { nickname: "Ahorramas Dolares", type: "debit", bank_id: sip.id, last_4: "2020" });
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), 'AHORRA-USD').id"), usd.id);
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), 'AHORRA-PEN').id"), pen.id);
  // Their currencies on record decide first; one account in both currencies takes both.
  rt.api("savePaymentMethod", { id: usd.id, nickname: "Ahorramas Dolares", type: "debit", bank_id: sip.id, last_4: "2020", currencies: ["USD"] });
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), 'AHORRA-USD').id"), usd.id);
});

test("AhorraMás: one account called AhorraMás takes both currencies", () => {
  const { rt } = freshApp({ small: true });
  const sip = rt.api("addBank", { name: "SIP" });
  const one = rt.api("savePaymentMethod", { nickname: "AhorraMás", type: "debit", bank_id: sip.id, last_4: "1010", currencies: ["PEN", "USD"], last_4_more: [{ currency: "USD", digits: "2020" }] });
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), 'AHORRA-USD').id"), one.id);
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), 'AHORRA-PEN').id"), one.id);
});

// ---- Separating one account into two (the reverse of a join) ----
function oneYapeWithHistory(rt) {
  const pm = yapeAccount(rt);   // PEN 1234 + USD 0567
  const ex = rows(rt, "Entries").filter((e) => e.type === "expense").slice(0, 4);
  rt.run(`ensureColumn_('Entries', 'currency');
    setEntryField_(${JSON.stringify(ex[0].id)}, 'payment_method_id', ${JSON.stringify(pm.id)}); setEntryField_(${JSON.stringify(ex[0].id)}, 'currency', 'USD');
    setEntryField_(${JSON.stringify(ex[1].id)}, 'payment_method_id', ${JSON.stringify(pm.id)}); setEntryField_(${JSON.stringify(ex[1].id)}, 'currency', 'USD');
    setEntryField_(${JSON.stringify(ex[2].id)}, 'payment_method_id', ${JSON.stringify(pm.id)}); setEntryField_(${JSON.stringify(ex[2].id)}, 'currency', 'PEN');
    ensureEntriesToPaymentMethodColumn_();
    appendRowObject('Entries', { id: 'xch-in', type: 'transfer', date: '2026-01-11', amount: 30, currency: 'USD', payment_method_id: '', to_payment_method_id: ${JSON.stringify(pm.id)}, status: 'confirmed', source: 'manual', description: 'Made-up exchange leg' });
    ensureAccountOpeningBalancesSheet_();
    appendRowObject('Account Opening Balances', { id: 'ob-pen', payment_method_id: ${JSON.stringify(pm.id)}, currency: 'PEN', amount: 100, date: '2025-12-31' });
    appendRowObject('Account Opening Balances', { id: 'ob-usd', payment_method_id: ${JSON.stringify(pm.id)}, currency: 'USD', amount: 10, date: '2025-12-31' });
    setSetting_('yape_pen', ${JSON.stringify(pm.id)}); setSetting_('yape_usd', ${JSON.stringify(pm.id)});`);
  return { pm, ex };
}

test("separate: the preview counts what leaves with the currency, without changing anything", () => {
  const { rt } = freshApp({ small: true });
  const { pm } = oneYapeWithHistory(rt);
  const p = rt.api("previewAccountSplit", { id: pm.id, currency: "USD" });
  assert.equal(p.counts.entries, 3, "two dollar expenses + the dollar exchange leg");
  assert.equal(p.counts.balances, 1);
  assert.deepEqual(p.links, ["Yape"]);
  assert.equal(p.digits, "0567");
  assert.deepEqual(p.rest, ["PEN"]);
  assert.equal(String(pmById(rt, pm.id).last_4_more), "USD:0567", "nothing changed yet");
});

test("separate: a new account takes the currency, its number, its history, its starting balance and Yape in dollars", () => {
  const { rt } = freshApp({ small: true });
  const { pm, ex } = oneYapeWithHistory(rt);
  const res = rt.api("splitAccount", { id: pm.id, currency: "USD", name: "My Yape dollars" });
  const nu = pmById(rt, res.to.id);
  assert.equal(nu.nickname, "My Yape dollars");
  assert.equal(nu.bank_id, pm.bank_id);
  assert.equal(String(nu.last_4), "0567");
  assert.equal(String(nu.currencies), "USD");
  const old = pmById(rt, pm.id);
  assert.equal(String(old.currencies), "PEN");
  assert.equal(String(old.last_4), "1234");
  assert.equal(String(old.last_4_more || ""), "");
  const entries = rows(rt, "Entries");
  assert.equal(entries.find((e) => e.id === ex[0].id).payment_method_id, nu.id);
  assert.equal(entries.find((e) => e.id === ex[1].id).payment_method_id, nu.id);
  assert.equal(entries.find((e) => e.id === ex[2].id).payment_method_id, pm.id, "soles stay");
  assert.equal(entries.find((e) => e.id === "xch-in").to_payment_method_id, nu.id);
  const ob = rows(rt, "Account Opening Balances");
  assert.equal(ob.find((r) => r.id === "ob-usd").payment_method_id, nu.id);
  assert.equal(ob.find((r) => r.id === "ob-pen").payment_method_id, pm.id);
  const s = run(rt, "getSettingsMap()");
  assert.equal(s.yape_usd, nu.id);
  assert.equal(s.yape_pen, pm.id);
  assert.equal(run(rt, "stmtPmForKey_(getAllRows('Payment Methods'), '0567').id"), nu.id);
  assert.equal(run(rt, "listAccountMoves()").moves[0].counts.split, true, "kept in Recently deleted");
});

test("separate: Restore puts everything back on one account and deletes the new one", () => {
  const { rt } = freshApp({ small: true });
  const { pm, ex } = oneYapeWithHistory(rt);
  const res = rt.api("splitAccount", { id: pm.id, currency: "USD", name: "My Yape dollars" });
  rt.api("restoreAccountMove", { move_id: res.move_id });
  assert.equal(pmById(rt, res.to.id), undefined);
  const old = pmById(rt, pm.id);
  assert.equal(String(old.currencies), "PEN,USD");
  assert.equal(String(old.last_4_more), "USD:0567");
  assert.equal(rows(rt, "Entries").find((e) => e.id === ex[0].id).payment_method_id, pm.id);
  assert.equal(run(rt, "getSettingsMap()").yape_usd, pm.id);
  assert.equal(run(rt, "listAccountMoves()").moves.length, 0);
});

test("separate: refused for a one-currency account, a card, a currency it does not have, an empty or taken name", () => {
  const { rt } = freshApp({ small: true });
  const { pm } = oneYapeWithHistory(rt);
  const one = rt.api("savePaymentMethod", { nickname: "One made-up", type: "debit", bank_id: bcp(rt).id, currencies: ["PEN"] });
  assert.throws(() => rt.api("splitAccount", { id: one.id, currency: "PEN", name: "x" }), /separa/);
  assert.throws(() => rt.api("splitAccount", { id: pm.id, currency: "EUR", name: "x" }), /separa/);
  assert.throws(() => rt.api("splitAccount", { id: pm.id, currency: "USD", name: "" }));
  assert.throws(() => rt.api("splitAccount", { id: pm.id, currency: "USD", name: "Main debit" }), /name|nombre/);
  assert.equal(String(pmById(rt, pm.id).last_4_more), "USD:0567", "a refused separation changes nothing");
});

test("separate the MAIN currency: the dollars number becomes the account's main one", () => {
  const { rt } = freshApp({ small: true });
  const { pm } = oneYapeWithHistory(rt);
  const res = rt.api("splitAccount", { id: pm.id, currency: "PEN", name: "My Yape soles" });
  assert.equal(String(pmById(rt, res.to.id).last_4), "1234");
  const old = pmById(rt, pm.id);
  assert.equal(String(old.last_4), "0567");
  assert.equal(String(old.currencies), "USD");
  assert.equal(run(rt, "getSettingsMap()").yape_pen, res.to.id);
});

test("join is offered for older accounts with no currency on record: from their names, else from their entries", () => {
  const { rt } = freshApp({ small: true });
  const b = bcp(rt);
  // Made before currencies were kept: no currencies, no kind (the owner's own "BCP soles" / "BCP dolares").
  const soles = rt.api("savePaymentMethod", { nickname: "BCP made-up soles", type: "debit", bank_id: b.id, last_4: "1111" });
  const old = rt.api("savePaymentMethod", { nickname: "BCP made-up old", type: "debit", bank_id: b.id, last_4: "2222" });
  const ex = rows(rt, "Entries").filter((e) => e.type === "expense" && e.status === "confirmed").slice(0, 6);
  ex.forEach((e) => rt.run(`ensureColumn_('Entries', 'currency'); setEntryField_(${JSON.stringify(e.id)}, 'payment_method_id', ${JSON.stringify(old.id)}); setEntryField_(${JSON.stringify(e.id)}, 'currency', 'USD');`));
  const p = rt.api("previewAccountMove", { from: old.id, to: soles.id });
  assert.ok(p.merge, "offered");
  assert.deepEqual(p.merge.numbers, [{ currency: "PEN", digits: "1111" }, { currency: "USD", digits: "2222" }]);
  rt.api("moveAccountHistory", { from: old.id, to: soles.id, merge: true, merge_name: "BCP made-up soles" });
  const pm = pmById(rt, soles.id);
  assert.equal(String(pm.currencies), "PEN,USD");
  assert.equal(String(pm.last_4), "1111");
  assert.equal(String(pm.last_4_more), "USD:2222", "the old number is kept for good");
});

test("join is not offered when neither the name nor the entries say the currency", () => {
  const { rt } = freshApp({ small: true });
  const b = bcp(rt);
  const a = rt.api("savePaymentMethod", { nickname: "BCP made-up one", type: "debit", bank_id: b.id, last_4: "1111" });
  const c = rt.api("savePaymentMethod", { nickname: "BCP made-up two", type: "debit", bank_id: b.id, last_4: "2222" });
  assert.equal(rt.api("previewAccountMove", { from: c.id, to: a.id }).merge, null);
});

test("the old Plin-in-dollars link can be cleared, never set", () => {
  const { rt } = freshApp({ small: true });
  const pm = rows(rt, "Payment Methods").find((p) => p.nickname === "Daily debit");
  rt.run(`setSetting_('plin_usd', ${JSON.stringify(pm.id)})`);
  const other = rows(rt, "Payment Methods").find((p) => p.nickname === "Backup debit");
  rt.api("saveRailLinks", { plin_usd: other.id });   // never set: an old phone's value is ignored
  assert.equal(run(rt, "getSettingsMap()").plin_usd, pm.id);
  rt.api("saveRailLinks", { plin_usd: "" });
  assert.equal(String(run(rt, "getSettingsMap()").plin_usd || ""), "");
});
