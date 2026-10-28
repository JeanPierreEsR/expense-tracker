// A repayment can arrive as two entries: what the loans took (a transfer) and its extra (income/expense). These tests cover
// editing either one from Home and matching the bank's single line against their sum. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const setup = () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  // 130 arrives for a 100 debt: 100 on the loan (transfer entry), 30 extra (income entry)
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  const line = () => rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0];
  return { rt, data, friend, line, cat };
};

test("Home: a new date or account on the extra entry carries over to the repayment and its money movement", () => {
  const { rt, data, line } = setup();
  rt.api("updateEntry", { id: line().gap.entry_id, fields: { date: "2026-03-05", payment_method_id: data.pms[2].id } });
  assert.equal(line().date, "2026-03-05");
  assert.equal(line().payment_method_id, data.pms[2].id);
  const tid = line().transfer_entry_id;
  const te = rt.rows("Entries").find((e) => e.id === tid);
  assert.equal(String(te.date).slice(0, 10), "2026-03-05");
  assert.equal(te.payment_method_id, data.pms[2].id);
});

test("Home: a new date or account on the money movement carries over to the extra entry", () => {
  const { rt, data, line } = setup();
  rt.api("updateEntry", { id: line().transfer_entry_id, fields: { date: "2026-03-09", payment_method_id: data.pms[2].id } });
  const gid = line().gap.entry_id;
  const extra = rt.rows("Entries").find((e) => e.id === gid);
  assert.equal(String(extra.date).slice(0, 10), "2026-03-09");
  assert.equal(extra.payment_method_id, data.pms[2].id);
  assert.equal(line().date, "2026-03-09");
});

test("Home: the amount of the money movement is changed from the repayment history, not here", () => {
  const { rt, line } = setup();
  assert.throws(() => rt.api("updateEntry", { id: line().transfer_entry_id, fields: { amount: 90 } }), /Repayment history/);
  rt.api("updateEntry", { id: line().transfer_entry_id, fields: { amount: 100 } });   // same amount: fine
  // the extra's amount is not edited alone either: it is part of the total, changed from the repayment's editor
  assert.throws(() => rt.api("updateEntry", { id: line().gap.entry_id, fields: { amount: 35 } }), /extra part of a repayment/);
  rt.api("updateEntry", { id: line().gap.entry_id, fields: { amount: 30 } });   // same amount: fine
  // the link map tells the app which income entry is a repayment's extra (it offers to open the editor)
  const links = JSON.parse(rt.run("JSON.stringify(buildTransferLinkMap_())"));
  assert.equal(links[line().gap.entry_id].kind, "repaymentExtra");
  assert.equal(links[line().gap.entry_id].transfer_entry_id, line().transfer_entry_id);
});

test("Home: the extra entry cannot be turned into another type, and it is never deleted on its own (owner's rule, 2026-10-28)", () => {
  const { rt, line } = setup();
  assert.throws(() => rt.api("updateEntry", { id: line().gap.entry_id, fields: { type: "expense" } }), /extra part of a repayment/);
  const links = rt.api("getEntryRepaymentLinks", { id: line().gap.entry_id });
  assert.equal(links.repaymentExtra.amount, 30);
  assert.equal(links.repaymentExtra.direction, "they_owe_me");
  // Before 2026-10-28 deleting the extra took it out of the total; now neither entry is deleted alone (see delete-repayment.test.js).
  assert.throws(() => rt.api("discardEntry", { id: line().gap.entry_id }), /part of a repayment/);
  assert.equal(line().gap.amount, 30, "still part of the total");
  assert.equal(line().amount, 130);
});

test("statement: one bank line for the repayment total matches the money movement, and the extra is explained too", () => {
  const { rt, data, line } = setup();
  const pm = data.pms[3].id;
  const ln = line();
  const entries = JSON.stringify(rt.rows("Entries").filter((e) => e.id === ln.transfer_entry_id || e.id === ln.gap.entry_id));
  const totals = rt.run("JSON.stringify(buildRepaymentTotalsForMatching_())");
  const lines = JSON.stringify([{ date: "2026-03-01", description: "TRANSF RECIBIDA", amount: 130, currency: "PEN" }]);
  const result = JSON.parse(rt.run(`JSON.stringify(matchStatements_([{ key: 's', pmId: ${JSON.stringify(pm)}, kind: 'csv', lines: ${lines} }], ${entries}, { repaymentTotals: ${totals} }))`));
  const r = result.perLine.s[0];
  assert.equal(r.status, "matched");
  assert.equal(r.entryId, ln.transfer_entry_id);
  assert.equal(r.viaRepayment, true);
  // without the totals the same line would not match (130 is neither entry's amount)
  const plain = JSON.parse(rt.run(`JSON.stringify(matchStatements_([{ key: 's', pmId: ${JSON.stringify(pm)}, kind: 'csv', lines: ${lines} }], ${entries}, {}))`));
  assert.equal(plain.perLine.s[0].status, "unregistered");
});

test("statement: the extra entry is not matched a second time by another line of the same amount", () => {
  const { rt, data, line } = setup();
  const pm = data.pms[3].id;
  const ln = line();
  const entries = JSON.stringify(rt.rows("Entries").filter((e) => e.id === ln.transfer_entry_id || e.id === ln.gap.entry_id));
  const totals = rt.run("JSON.stringify(buildRepaymentTotalsForMatching_())");
  const lines = JSON.stringify([
    { date: "2026-03-01", description: "TRANSF RECIBIDA", amount: 130, currency: "PEN" },
    { date: "2026-03-01", description: "OTRO", amount: 30, currency: "PEN" }
  ]);
  const result = JSON.parse(rt.run(`JSON.stringify(matchStatements_([{ key: 's', pmId: ${JSON.stringify(pm)}, kind: 'csv', lines: ${lines} }], ${entries}, { repaymentTotals: ${totals} }))`));
  assert.equal(result.perLine.s[0].status, "matched");
  assert.equal(result.perLine.s[1].status, "unregistered", "the 30 extra already belongs to the 130 line");
});

// The whole statement path (analyzeStatements), not just the matcher: what the owner sees when he uploads the bank's file.
const analyse = (rt, pm, lines) => {
  const stmt = { key: pm.last_4, kind: "savings", verified: true, period: { start: "2026-03-01", end: "2026-03-31" }, balances: { PEN: { closing: 1000 } }, file_name: "x.pdf", lines };
  return JSON.parse(rt.run(`JSON.stringify(analyzeStatements(${JSON.stringify({ statements: [stmt] })}))`)).statements[0].lines;
};

test("statement upload: the bank's single line for what a friend sent matches the repayment, loans + extra", () => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm.id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: pm.id, overpay_category_id: cat });

  const [line] = analyse(rt, pm, [{ date: "2026-03-02", description: "TRANSF RECIBIDA", amount: 130, currency: "PEN" }]);   // the bank posts a day later
  assert.equal(line.status, "matched");
  assert.equal(line.viaRepayment, true);

  // the owner then corrects the extra in Home (30 -> 35): the bank must show 135 to match
  const first = rt.api("getFriendRepaymentHistory", { friendId: friend.id }).repayments[0];
  rt.api("reassignRepayment", { id: first.id, loan_ids: [first.parts[0].loan_id], limit: true, amount: 135 });   // from the editor
  assert.equal(analyse(rt, pm, [{ date: "2026-03-01", description: "TRANSF RECIBIDA", amount: 135, currency: "PEN" }])[0].status, "matched");
  assert.notEqual(analyse(rt, pm, [{ date: "2026-03-01", description: "TRANSF RECIBIDA", amount: 130, currency: "PEN" }])[0].status, "matched");
});

test("statement upload: money the owner paid a friend (loans + extra expense) matches one outgoing bank line", () => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm.id, description: "Borrowed" });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "i_owe_them", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: pm.id, overpay_category_id: cat });

  const [line] = analyse(rt, pm, [{ date: "2026-03-01", description: "TRANSF ENVIADA", amount: -130, currency: "PEN" }]);
  assert.equal(line.status, "matched");
  assert.equal(line.viaRepayment, true);
});

test("statement upload: two bank lines (loans part and extra part) still match one each", () => {
  const { rt, data } = freshApp({ entries: 5 });
  const pm = data.pms[3];
  const friend = rt.api("addFriend", { name: "Test Friend " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: pm.id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: pm.id, overpay_category_id: cat });
  const lines = analyse(rt, pm, [
    { date: "2026-03-01", description: "TRANSF 1", amount: 100, currency: "PEN" },
    { date: "2026-03-01", description: "TRANSF 2", amount: 30, currency: "PEN" }
  ]);
  assert.deepEqual(lines.map((l) => l.status), ["matched", "matched"]);
});
