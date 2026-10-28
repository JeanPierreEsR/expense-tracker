// Edits typed straight into the Entries tab of the Sheet keep loans and repayments in step (EditSync.gs). A real installable edit
// trigger is fired by Google only for manual edits; here the cell is written the way a person would and the trigger's handler is
// called with the event Google would send. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const tag = Math.random().toString(36).slice(2, 6);
  const ana = rt.api("addFriend", { name: "Sheet Ana " + tag });
  const pm = data.pms[3].id;
  const income = data.cats.find((c) => c.type === "income");
  const entryRow = (id) => rt.rows("Entries").find((e) => e.id === id);
  const loanRow = (id) => rt.rows("Loans").find((l) => l.id === id);
  // Types `value` into one cell of an Entries row, then hands Google's edit event to the handler.
  const manualEdit = (entryId, column, value, { multi = false } = {}) => rt.run(`(function () {
    var sheet = getSheet('Entries'); var headers = getHeaders(sheet);
    var rowIndex = findRowIndexById(sheet, headers, ${JSON.stringify(entryId)});
    var col = headers.indexOf(${JSON.stringify(column)}) + 1;
    var old = sheet.getRange(rowIndex, col).getValue();
    sheet.getRange(rowIndex, col).setValue(${JSON.stringify(value)});
    var range = ${multi} ? sheet.getRange(rowIndex, col, 1, 2) : sheet.getRange(rowIndex, col);
    onEntriesSheetEdit_({ range: range, oldValue: old === '' ? undefined : String(old) });
    return true;
  })()`);
  const toasts = () => rt.svc.toastLog.map((t) => t.message);
  return { rt, data, ana, pm, income, entryRow, loanRow, manualEdit, toasts };
}

function repaymentWithExtra(s) {
  s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm });
  s.rt.api("recordRepayment", { friend_id: s.ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-02-10", payment_method_id: s.pm, overpay_category_id: s.income.id });
  const row = s.rt.rows("Settlements").find((r) => r.gap_entry_id);
  return { row, movementId: row.transfer_entry_id, extraId: row.gap_entry_id };
}

// ---- the trigger is installed once, by the app opening ----

test("opening the app installs the edit trigger once per copy", () => {
  const { rt } = setup();
  const handlers = () => JSON.parse(rt.run("JSON.stringify(ScriptApp.getProjectTriggers().map(function (t) { return [t.getHandlerFunction(), String(t.getEventType())]; }))"));
  assert.deepEqual(handlers().filter((h) => h[0] === "onEntriesSheetEdit_"), []);
  rt.api("getMeta", {});
  assert.deepEqual(handlers().filter((h) => h[0] === "onEntriesSheetEdit_"), [["onEntriesSheetEdit_", "ON_EDIT"]]);
  rt.api("getMeta", {});
  assert.equal(handlers().filter((h) => h[0] === "onEntriesSheetEdit_").length, 1, "never a second one");
});

test("a copy that already has the trigger (flag lost) does not get a duplicate", () => {
  const { rt } = setup();
  rt.api("getMeta", {});
  rt.run("PropertiesService.getScriptProperties().deleteProperty('ENTRIES_EDIT_TRIGGER')");
  rt.api("getMeta", {});
  assert.equal(JSON.parse(rt.run("JSON.stringify(ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'onEntriesSheetEdit_'; }).length)")), 1);
});

// ---- a loan's money entry ----

test("typing a new amount, date or description on a loan's entry updates the LOAN", () => {
  const s = setup();
  const l = s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm, description: "Dinner" });
  s.manualEdit(l.transfer_entry_id, "amount", 130);
  assert.equal(Number(s.loanRow(l.id).amount), 130);
  s.manualEdit(l.transfer_entry_id, "date", "2026-03-09");
  assert.equal(s.loanRow(l.id).date, "2026-03-09");
  s.manualEdit(l.transfer_entry_id, "description", "Rent share");
  assert.equal(s.loanRow(l.id).description, "Rent share");
  assert.deepEqual(s.toasts(), [], "nothing to report");
});

test("an amount the loan refuses is put back FROM THE LOAN, and a notice says why", () => {
  const s = setup();
  const l = s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm });
  s.rt.api("recordRepayment", { friend_id: s.ana.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: s.pm });
  s.manualEdit(l.transfer_entry_id, "amount", 50);
  assert.equal(Number(s.entryRow(l.transfer_entry_id).amount), 100, "the cell is back to what the loan says");
  assert.equal(Number(s.loanRow(l.id).amount), 100);
  assert.equal(s.toasts().length, 1);
  assert.match(s.toasts()[0], /does not accept the change/);
  assert.match(s.toasts()[0], /repaid or forgiven/, "with the loan's own reason");
});

test("a cleared amount cell is refused too", () => {
  const s = setup();
  const l = s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm });
  s.manualEdit(l.transfer_entry_id, "amount", "");
  assert.equal(Number(s.entryRow(l.transfer_entry_id).amount), 100);
  assert.equal(s.toasts().length, 1);
});

// ---- a repayment's two entries ----

test("a new date typed on a repayment's money movement carries over to its extra entry and its rows", () => {
  const s = setup();
  const { movementId, extraId } = repaymentWithExtra(s);
  s.manualEdit(movementId, "date", "2026-03-20");
  assert.equal(s.entryRow(extraId).date, "2026-03-20");
  assert.ok(s.rt.rows("Settlements").filter((r) => r.transfer_entry_id === movementId).every((r) => r.date === "2026-03-20"));
  assert.deepEqual(s.toasts(), []);
});

test("a new amount typed on a repayment's entry is put back, pointing to the app", () => {
  const s = setup();
  const { movementId, extraId } = repaymentWithExtra(s);
  s.manualEdit(movementId, "amount", 99);
  assert.equal(Number(s.entryRow(movementId).amount), 30);
  s.manualEdit(extraId, "amount", 77);
  assert.equal(Number(s.entryRow(extraId).amount), 20);
  assert.equal(s.toasts().length, 2);
  assert.match(s.toasts()[0], /Repayment history/);
});

test("several cells changed at once on a repayment: the amount cannot be put back by value, and the notice says to check it", () => {
  const s = setup();
  const { movementId } = repaymentWithExtra(s);
  s.manualEdit(movementId, "amount", 99, { multi: true });
  assert.match(s.toasts().join(" "), /Several cells changed at once/);
});

// ---- what is left alone ----

test("anything else is untouched: other columns, other tabs, the header row, ordinary entries", () => {
  const s = setup();
  const l = s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm });
  const before = JSON.stringify(s.loanRow(l.id));
  s.manualEdit(l.transfer_entry_id, "category_id", "something");
  assert.equal(JSON.stringify(s.loanRow(l.id)), before);
  // header row and another tab
  s.rt.run("onEntriesSheetEdit_({ range: getSheet('Entries').getRange(1, 1), oldValue: 'id' })");
  s.rt.run("onEntriesSheetEdit_({ range: getSheet('Loans').getRange(2, 1), oldValue: 'x' })");
  // an ordinary expense
  const e = s.rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: s.data.cats.find((c) => c.type === "expense").id, description: "x", payment_method_id: s.pm, paid_by: "me" });
  s.manualEdit(e.id, "amount", 55);
  assert.equal(Number(s.entryRow(e.id).amount), 55);
  assert.deepEqual(s.toasts(), []);
});

test("a failure inside the handler never throws into the person's edit", () => {
  const { rt } = setup();
  assert.doesNotThrow(() => rt.run("onEntriesSheetEdit_({ range: null })"));
  assert.doesNotThrow(() => rt.run("onEntriesSheetEdit_(undefined)"));
});
