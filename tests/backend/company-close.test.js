// Business 2, piece 8: the change log (ChangeLog.gs) and closing a month (MonthClose.gs), company copies only. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

function companyCopy() {
  const { rt } = freshApp({ small: true });
  rt.svc.props.set("FEATURES", "base,gmail");
  rt.sheet("Categories").rows.length = 1;
  rt.run("ROWS_MEMO_ = null; seedCategories();");
  rt.run("setSetting_('company_copy', 'yes')");
  rt.api("saveCompanySetup", { sector: "construction", name: "Constructora Andina", projects: ["Obra Norte"] });
  return rt;
}
// A month that has ended: two months back.
const ym = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 2); return d.toISOString().slice(0, 7); })();
const day = (n) => `${ym}-${String(n).padStart(2, "0")}`;
const expCat = (rt) => rt.rows("Categories").find((c) => c.type === "expense").id;
const pm = (rt) => rt.rows("Payment Methods")[0].id;
const spend = (rt, amount, d = day(10), description = "Cemento") =>
  rt.api("createEntry", { type: "expense", date: d, amount, currency: "PEN", category_id: expCat(rt), description, payment_method_id: pm(rt), paid_by: "me" });

test("every kind of change leaves its line: created, changed (before and after), deleted, with the source", () => {
  const rt = companyCopy();
  const e = spend(rt, 100);
  rt.api("updateEntry", { id: e.id, fields: { amount: 120, description: "Cemento gris" } });
  const log = rt.api("listChangeLog", { entry_id: e.id }).lines;
  assert.ok(log.some((l) => l.action === "create" && l.table === "Entries" && l.source === "app" && l.month === ym));
  const amount = log.find((l) => l.action === "update" && l.field === "amount");
  assert.equal(amount.before, "100");
  assert.equal(amount.after, "120");
  assert.ok(log.some((l) => l.field === "description" && l.before === "Cemento" && l.after === "Cemento gris"));
  assert.ok(!log.some((l) => l.field === "updated_at"));
  rt.api("deleteEntries", { ids: [e.id] });
  const after = rt.api("listChangeLog", { month: ym }).lines;
  const del = after.find((l) => l.action === "delete" && l.row_id === e.id);
  assert.ok(del);
  assert.match(del.before, /Cemento gris/);
  // a loan and a partner's contribution are logged too
  const friend = rt.api("addFriend", { name: "Socio Prueba", role: "partner" });
  rt.api("addLoan", { friend_id: friend.id, direction: "i_owe_them", amount: 500, currency: "PEN", date: day(12), payment_method_id: pm(rt) });
  assert.ok(rt.api("listChangeLog", { month: ym }).lines.some((l) => l.table === "Loans" && l.action === "create"));
});

test("closing a month keeps its figures and the bank check; a later change in it is detected and listed", () => {
  const rt = companyCopy();
  rt.api("setPaymentMethodOpeningBalance", { id: pm(rt), balances: [{ currency: "PEN", amount: 1000, date: day(1) }] });
  const e = spend(rt, 200);
  const open = rt.api("getMonthClose", { month: ym });
  assert.equal(open.ended, true);
  assert.equal(open.closed, false);
  const acct = open.accounts.find((a) => a.payment_method_id === pm(rt) && a.currency === "PEN");
  assert.ok(acct, "the account with a starting balance is offered for the bank check");
  const closed = rt.api("closeMonth", { month: ym, bank: [{ payment_method_id: acct.payment_method_id, currency: "PEN", bank_amount: acct.amount - 5 }] });
  assert.equal(closed.closed, true);
  assert.equal(closed.changed, false);
  assert.equal(closed.close.bank_check[0].difference, -5);
  assert.ok(closed.close.figures.byCategory.some((c) => c.amount === 200 && c.currency === "PEN"));
  assert.ok(rt.api("getMeta", {}).closedMonths.includes(ym));
  // a change through the app: detected, with its line
  rt.api("updateEntry", { id: e.id, fields: { amount: 250 } });
  const changed = rt.api("getMonthClose", { month: ym });
  assert.equal(changed.changed, true);
  assert.equal(changed.hand_edited, false);
  assert.ok(changed.changes.some((l) => l.field === "amount" && l.after === "250"));
  // reopening is allowed and logged
  const reopened = rt.api("reopenMonth", { month: ym });
  assert.equal(reopened.closed, false);
  assert.ok(rt.api("listChangeLog", { month: ym }).lines.some((l) => l.action === "reopen"));
  assert.ok(!rt.api("getMeta", {}).closedMonths.includes(ym));
});

test("an edit by hand in the Sheet after the close is detected (no line in the log)", () => {
  const rt = companyCopy();
  const e = spend(rt, 300);
  rt.api("closeMonth", { month: ym, bank: [] });
  // by hand: straight into the fake sheet, no server code involved
  const sheet = rt.sheet("Entries");
  const h = sheet.rows[0];
  const row = sheet.rows.find((r) => r[h.indexOf("id")] === e.id);
  row[h.indexOf("amount")] = 333;
  rt.run("ROWS_MEMO_ = null;");
  const s = rt.api("getMonthClose", { month: ym });
  assert.equal(s.changed, true);
  assert.equal(s.hand_edited, true);
});

test("the current month cannot be closed; the Overview of a whole month carries its close state", () => {
  const rt = companyCopy();
  const now = new Date().toISOString().slice(0, 7);
  assert.throws(() => rt.api("closeMonth", { month: now, bank: [] }));
  const last = (() => { const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)); return d.toISOString().slice(0, 10); })();
  const sum = rt.api("getPeriodSummary", { startDate: `${ym}-01`, endDate: last });
  assert.equal(sum.company.close.month, ym);
  assert.equal(rt.api("getPeriodSummary", { startDate: `${ym}-02`, endDate: last }).company.close, null);
});

test("not a company copy: no log is written, nothing can be closed", () => {
  const { rt } = freshApp({ small: true });
  const cat = rt.rows("Categories").find((c) => c.type === "expense").id;
  rt.api("createEntry", { type: "expense", date: day(5), amount: 10, currency: "PEN", category_id: cat, description: "x", paid_by: "me" });
  assert.equal(rt.run("SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Change Log') ? 1 : 0"), 0);
  assert.throws(() => rt.api("closeMonth", { month: ym, bank: [] }));
  assert.deepEqual(rt.api("getMeta", {}).closedMonths, []);
});
