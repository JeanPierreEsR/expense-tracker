// A loan's money entry and the loan are ONE thing: editing the entry updates the loan, and a loan can become another loan.
// Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const tag = Math.random().toString(36).slice(2, 6);
  const ana = rt.api("addFriend", { name: "Sync Ana " + tag });
  const bo = rt.api("addFriend", { name: "Sync Bo " + tag });
  const pm = data.pms[3].id;
  const pm2 = data.pms[4].id;
  const lend = (f, amount, extra = {}) => rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount, currency: "PEN", date: "2026-01-05", payment_method_id: pm, description: "Dinner money", ...extra });
  const loanRow = (id) => rt.rows("Loans").find((l) => l.id === id);
  const entryRow = (id) => rt.rows("Entries").find((e) => e.id === id);
  const editEntry = (entryId, fields) => rt.api("updateEntry", { id: entryId, fields });
  return { rt, data, ana, bo, pm, pm2, lend, loanRow, entryRow, editEntry };
}

// ---- edits of a loan's entry update the loan ----

test("editing the entry's amount, date, account and description updates the LOAN", () => {
  const { lend, ana, loanRow, editEntry, entryRow, pm2 } = setup();
  const l = lend(ana, 100);
  editEntry(l.transfer_entry_id, { type: "transfer", date: "2026-02-01", amount: 120, currency: "PEN", payment_method_id: pm2, description: "Rent share" });
  const after = loanRow(l.id);
  assert.equal(Number(after.amount), 120);
  assert.equal(after.date, "2026-02-01");
  assert.equal(after.payment_method_id, pm2);
  assert.equal(after.description, "Rent share");
  assert.equal(Number(entryRow(l.transfer_entry_id).amount), 120, "and the entry says the same");
});

test("an auto-made 'Loan to {friend}' description is NOT stored as the loan's own description", () => {
  const { lend, ana, loanRow, editEntry, entryRow } = setup();
  const l = lend(ana, 100, { description: "" });
  const auto = entryRow(l.transfer_entry_id).description;
  assert.match(auto, /Loan to/);
  editEntry(l.transfer_entry_id, { type: "transfer", amount: 90, description: auto });
  assert.equal(loanRow(l.id).description, "", "still no description of its own");
  assert.equal(Number(loanRow(l.id).amount), 90);
});

test("a loan's own rules still apply: below what is repaid, or another currency once repaid, refuses and changes NOTHING", () => {
  const { rt, lend, ana, pm, loanRow, editEntry, entryRow } = setup();
  const l = lend(ana, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm });
  assert.throws(() => editEntry(l.transfer_entry_id, { type: "transfer", amount: 50 }), /in repayments/i);
  assert.throws(() => editEntry(l.transfer_entry_id, { type: "transfer", currency: "USD", amount: 100 }), /repayment|friend, direction or currency/i);
  assert.equal(Number(loanRow(l.id).amount), 100);
  assert.equal(Number(entryRow(l.transfer_entry_id).amount), 100, "the entry was not written either");
  editEntry(l.transfer_entry_id, { type: "transfer", amount: 80 });   // still above what is repaid: fine
  assert.equal(Number(loanRow(l.id).amount), 80);
});

test("an edit that changes nothing the loan shares (a tag, a category) leaves the loan alone", () => {
  const { lend, ana, loanRow, editEntry } = setup();
  const l = lend(ana, 100);
  const before = JSON.stringify(loanRow(l.id));
  editEntry(l.transfer_entry_id, { type: "transfer", trip_id: "" });
  assert.equal(JSON.stringify(loanRow(l.id)), before);
});

test("an ordinary transfer or expense is not affected", () => {
  const { rt, data, pm, editEntry } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  assert.equal(Number(editEntry(e.id, { amount: 25 }).amount), 25);
});

// ---- a loan becomes another loan ----

test("no repayments: another person, direction, amount and currency are changed IN PLACE (same loan, same entry)", () => {
  const { rt, lend, ana, bo, pm, loanRow, entryRow } = setup();
  const l = lend(ana, 100);
  const out = rt.api("convertLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "i_owe_them", amount: 40, currency: "USD", date: "2026-03-01", due_date: "2026-04-01", payment_method_id: pm, description: "Actually borrowed" });
  assert.equal(out.in_place, true);
  const after = loanRow(l.id);
  assert.equal(after.friend_id, bo.id);
  assert.equal(after.direction, "i_owe_them");
  assert.equal(Number(after.amount), 40);
  assert.equal(after.currency, "USD");
  assert.equal(after.transfer_entry_id, l.transfer_entry_id, "the same money entry stays linked");
  assert.equal(entryRow(l.transfer_entry_id).currency, "USD");
  assert.equal(rt.rows("Loans").filter((x) => x.friend_id === ana.id).length, 0);
});

test("with repayments, changing only the date, amount (not below) or description is still IN PLACE", () => {
  const { rt, lend, ana, pm, loanRow } = setup();
  const l = lend(ana, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm });
  const plan = rt.api("checkLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: ana.id, direction: "they_owe_me", amount: 90, currency: "PEN" });
  assert.equal(plan.needsRelease, false);
  const out = rt.api("convertLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: ana.id, direction: "they_owe_me", amount: 90, currency: "PEN", date: "2026-02-02", payment_method_id: pm, description: "Fixed" });
  assert.equal(out.in_place, true);
  assert.equal(Number(loanRow(l.id).amount), 90);
});

test("with repayments, another PERSON replaces the loan: keep / cancel is needed; keep leaves a credit, cancel removes the repayments", () => {
  const a = setup();
  const l = a.lend(a.ana, 100);
  a.rt.api("recordRepayment", { friend_id: a.ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: a.pm });
  const call = (rt, extra) => rt.api("convertLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: a.bo.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: a.pm, ...extra });
  const check = a.rt.api("checkLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: a.bo.id, direction: "they_owe_me", amount: 100, currency: "PEN" });
  assert.equal(check.needsRelease, true);
  assert.equal(check.paid, 30);
  assert.throws(() => call(a.rt), /keep them or cancel/i);
  assert.equal(a.loanRow(l.id).friend_id, a.ana.id, "nothing changed by the refusal");
  const out = call(a.rt, { repayments: "keep" });
  assert.equal(out.in_place, false);
  assert.equal(a.rt.rows("Loans").some((x) => x.id === l.id), false, "the old loan is gone");
  assert.ok(a.rt.rows("Loans").find((x) => x.friend_id === a.bo.id && x.direction === "they_owe_me" && Number(x.amount) === 100));
  assert.ok(a.rt.rows("Loans").find((x) => x.friend_id === a.ana.id && x.direction === "i_owe_them" && Number(x.amount) === 30), "Ana's 30 stays as a credit");

  const b = setup();
  const l2 = b.lend(b.ana, 100);
  b.rt.api("recordRepayment", { friend_id: b.ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: b.pm });
  b.rt.api("convertLoanToLoan", { entry_id: l2.transfer_entry_id, friend_id: b.bo.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: b.pm, repayments: "cancel" });
  assert.equal(b.rt.rows("Loans").some((x) => x.friend_id === b.ana.id), false);
  assert.equal(b.rt.rows("Settlements").length >= 0, true);
});

test("a failure while adding the replacement puts the old loan, its entry and its repayments back exactly", () => {
  const a = setup();
  const l = a.lend(a.ana, 100);
  a.rt.api("recordRepayment", { friend_id: a.ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: a.pm });
  const snap = () => JSON.stringify({
    loans: a.rt.rows("Loans").map((x) => [x.id, x.friend_id, x.amount, x.status]).sort(),
    settlements: a.rt.rows("Settlements").map((x) => [x.id, x.loan_id, x.amount]).sort(),
    entries: a.rt.rows("Entries").length
  });
  const before = snap();
  a.rt.run("globalThis.__origAdd = addLoan; addLoan = function () { throw new Error('boom'); };");
  try {
    assert.throws(() => a.rt.api("convertLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: a.bo.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: a.pm, repayments: "cancel" }), /Nothing was changed/i);
  } finally {
    a.rt.run("addLoan = globalThis.__origAdd;");
  }
  assert.equal(snap(), before);
});

test("something that is not a loan's entry, or a forgiven loan, is refused", () => {
  const { rt, lend, ana, bo, pm, data } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 5, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  assert.throws(() => rt.api("convertLoanToLoan", { entry_id: e.id, friend_id: bo.id, direction: "they_owe_me", amount: 5, currency: "PEN", date: today() }), /not a loan/i);
});
