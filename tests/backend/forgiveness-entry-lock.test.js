// The entry a forgiveness booked (whole or partial) keeps the amount and currency that were forgiven: the app, Telegram and the
// Sheet all refuse to change them; everything else about it stays editable (entry-type conversions plan, step 8). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const pm = data.pms[3].id;
  const friend = rt.api("addFriend", { name: "Lock Friend " + Math.random().toString(36).slice(2, 6) });
  const loan = rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-01-01", payment_method_id: pm });
  const expenseCat = data.cats.find((c) => c.type === "expense");
  const other = data.cats.filter((c) => c.type === "expense")[1] || expenseCat;
  const forgive = (amount) => rt.api("forgiveLoan", { id: loan.id, amount, category_id: expenseCat.id, date: today() });
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  const manualEdit = (entryId, column, value) => rt.run(`(function () {
    var sheet = getSheet('Entries'); var headers = getHeaders(sheet);
    var rowIndex = findRowIndexById(sheet, headers, ${JSON.stringify(entryId)});
    var col = headers.indexOf(${JSON.stringify(column)}) + 1;
    var old = sheet.getRange(rowIndex, col).getValue();
    sheet.getRange(rowIndex, col).setValue(${JSON.stringify(value)});
    onEntriesSheetEdit_({ range: sheet.getRange(rowIndex, col), oldValue: old === '' ? undefined : String(old) });
    return true;
  })()`);
  const telegramEdit = (entryId, text) => JSON.parse(rt.run(`JSON.stringify(applyEditCommand_(${JSON.stringify(entryId)}, ${JSON.stringify(text)}))`));
  return { rt, pm, loan, other, forgive, row, manualEdit, telegramEdit };
}

for (const kind of ["whole", "partial"]) {
  test(`app: a ${kind} forgiveness entry's amount and currency are locked, the rest is editable`, () => {
    const { rt, other, forgive, row } = setup();
    const res = forgive(kind === "whole" ? 200 : 60);
    const amount = Number(res.entry.amount);
    assert.throws(() => rt.api("updateEntry", { id: res.entry.id, fields: { amount: amount + 10 } }), /forgiven debt, so its amount and currency/i);
    assert.throws(() => rt.api("updateEntry", { id: res.entry.id, fields: { currency: "USD" } }), /forgiven debt/i);
    assert.equal(Number(row(res.entry.id).amount), amount);
    // The same amount again, a new category / description / date are fine.
    const ok = rt.api("updateEntry", { id: res.entry.id, fields: { amount, category_id: other.id, description: "Gift to a friend", date: "2026-05-05" } });
    assert.equal(ok.description, "Gift to a friend");
    assert.equal(ok.date, "2026-05-05");
  });

  test(`telegram: a ${kind} forgiveness entry's amount is put back with the reason`, () => {
    const { forgive, row, telegramEdit } = setup();
    const res = forgive(kind === "whole" ? 200 : 60);
    const amount = Number(res.entry.amount);
    const out = telegramEdit(res.entry.id, "amount 999");
    assert.match(out.message, /forgiven debt, so its amount/i);
    assert.equal(Number(row(res.entry.id).amount), amount);
    telegramEdit(res.entry.id, "description Kind gesture");
    assert.equal(row(res.entry.id).description, "Kind gesture");
  });

  test(`sheet: typing a new amount on a ${kind} forgiveness entry puts it back and says why`, () => {
    const { rt, forgive, row, manualEdit } = setup();
    const res = forgive(kind === "whole" ? 200 : 60);
    const amount = Number(res.entry.amount);
    manualEdit(res.entry.id, "amount", 777);
    assert.equal(Number(row(res.entry.id).amount), amount);
    assert.match(rt.svc.toastLog.map((t) => t.message).join(" "), /forgiven debt can't be changed/i);
  });
}

test("an ordinary entry is not affected", () => {
  const { rt, pm, other } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: other.id, description: "Plain", payment_method_id: pm, paid_by: "me" });
  assert.equal(Number(rt.api("updateEntry", { id: e.id, fields: { amount: 35 } }).amount), 35);
});
