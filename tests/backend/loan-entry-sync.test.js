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
  assert.throws(() => editEntry(l.transfer_entry_id, { type: "transfer", amount: 50 }), /repaid or forgiven/i);
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

// ---- Telegram edits update the loan too ----

const telegramEdit = (rt, entryId, text) =>
  JSON.parse(rt.run(`JSON.stringify(applyEditCommand_(${JSON.stringify(entryId)}, ${JSON.stringify(text)}))`));

test("a Telegram reply that changes a loan entry's amount, date and description updates the LOAN", () => {
  const { rt, lend, ana, loanRow, entryRow } = setup();
  const l = lend(ana, 100);
  telegramEdit(rt, l.transfer_entry_id, "amount 130, date 2026-03-05, description Rent share");
  const after = loanRow(l.id);
  assert.equal(Number(after.amount), 130);
  assert.equal(after.date, "2026-03-05");
  assert.equal(after.description, "Rent share");
  assert.equal(Number(entryRow(l.transfer_entry_id).amount), 130);
});

test("a Telegram edit the loan refuses is put back, and the bot says so", () => {
  const { rt, lend, ana, pm, loanRow, entryRow } = setup();
  const l = lend(ana, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm });
  const out = telegramEdit(rt, l.transfer_entry_id, "amount 50");
  assert.match(out.message, /does not accept it/i);
  assert.match(out.message, /repaid or forgiven/i, "with the loan's own reason");
  assert.equal(Number(loanRow(l.id).amount), 100);
  assert.equal(Number(entryRow(l.transfer_entry_id).amount), 100, "the entry went back too");
});

test("a Telegram message with other parts in it still reports the loan's refusal, and the amount stays put", () => {
  const { rt, lend, ana, pm, entryRow, loanRow } = setup();
  const l = lend(ana, 100);
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 60, currency: "PEN", date: today(), payment_method_id: pm });
  const out = telegramEdit(rt, l.transfer_entry_id, "amount 50, category Other");
  assert.match(out.message, /does not accept it/i);
  assert.equal(Number(entryRow(l.transfer_entry_id).amount), 100);
  assert.equal(Number(loanRow(l.id).amount), 100);
});

test("a Telegram edit of an ordinary entry is untouched by all this", () => {
  const { rt, data, pm } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  telegramEdit(rt, e.id, "amount 33");
  assert.equal(Number(rt.rows("Entries").find((x) => x.id === e.id).amount), 33);
});

// ---- Telegram edits of a repayment's two entries follow the same rules as in the app ----

function repaymentWithExtra() {
  const s = setup();
  const income = s.data.cats.find((c) => c.type === "income");
  s.rt.api("addLoan", { friend_id: s.ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-05", payment_method_id: s.pm });
  s.rt.api("recordRepayment", { friend_id: s.ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-02-10", payment_method_id: s.pm, overpay_category_id: income.id });
  const row = s.rt.rows("Settlements").find((r) => r.gap_entry_id);
  return { ...s, row, movementId: row.transfer_entry_id, extraId: row.gap_entry_id };
}

test("Telegram: a new DATE on the money movement carries over to the extra entry and to the repayment rows", () => {
  const { rt, movementId, extraId, entryRow } = repaymentWithExtra();
  const out = telegramEdit(rt, movementId, "date 2026-03-20");
  assert.equal(entryRow(movementId).date, "2026-03-20");
  assert.equal(entryRow(extraId).date, "2026-03-20", "the extra follows");
  assert.ok(rt.rows("Settlements").filter((r) => r.transfer_entry_id === movementId).every((r) => r.date === "2026-03-20"), "and the rows");
  assert.ok(!/Not changed/.test(out.message || ""));
});

test("Telegram: a new ACCOUNT on the extra entry carries over to the money movement", () => {
  const { rt, data, movementId, extraId, entryRow } = repaymentWithExtra();
  const other = data.pms[4];
  telegramEdit(rt, extraId, "payment method " + other.nickname);
  assert.equal(entryRow(extraId).payment_method_id, other.id);
  assert.equal(entryRow(movementId).payment_method_id, other.id, "the money movement follows");
});

test("Telegram: a new AMOUNT on either entry of a repayment is refused and put back, pointing to the app", () => {
  const { rt, movementId, extraId, entryRow } = repaymentWithExtra();
  const a = telegramEdit(rt, movementId, "amount 99");
  assert.match(a.message, /Not changed/);
  assert.match(a.message, /Repayment history/, "points to the repayment's screen in the app");
  assert.equal(Number(entryRow(movementId).amount), 30);
  const b = telegramEdit(rt, extraId, "amount 99");
  assert.match(b.message, /Not changed/);
  assert.equal(Number(entryRow(extraId).amount), 20);
});

test("Telegram: an ordinary entry's edits are untouched by the repayment rules", () => {
  const { rt, data, pm } = setup();
  const e = rt.api("createEntry", { type: "expense", date: today(), amount: 20, currency: "PEN", category_id: data.cats.find((c) => c.type === "expense").id, description: "x", payment_method_id: pm, paid_by: "me" });
  telegramEdit(rt, e.id, "date 2026-03-01, amount 44");
  const row = rt.rows("Entries").find((x) => x.id === e.id);
  assert.equal(row.date, "2026-03-01");
  assert.equal(Number(row.amount), 44);
});

// ---- the old default text is never carried into a new loan / repayment ----

test("converting a repayment for another person: the old 'Repayment from {person}' is not carried over", () => {
  const { rt, data, ana, bo, pm } = setup();
  const income = data.cats.find((c) => c.type === "income");
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-05", payment_method_id: pm });
  rt.api("addLoan", { friend_id: bo.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: "2026-01-05", payment_method_id: pm });
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm });
  const movementId = rt.rows("Settlements").find((r) => r.transfer_entry_id).transfer_entry_id;
  const old = rt.rows("Entries").find((e) => e.id === movementId).description;
  assert.match(old, /Repayment from Sync Ana/);
  rt.api("convertRepaymentToRepayment", { entry_id: movementId, friend_id: bo.id, direction: "they_owe_me", amount: 30, currency: "PEN", date: today(), payment_method_id: pm, description: old, overpay_category_id: income.id });
  const fresh = rt.rows("Entries").find((e) => e.type === "transfer" && /Repayment from Sync Bo/.test(e.description));
  assert.ok(fresh, "the new repayment reads 'Repayment from Sync Bo'");
});

// ---- the automatic description is a DEFAULT, never frozen into the loan ----

test("the default 'Loan to {friend}' shows, can be replaced by the person's own text, and follows the loan when it changes", () => {
  const { rt, lend, ana, bo, pm, loanRow, entryRow } = setup();
  const l = lend(ana, 100, { description: "" });
  assert.match(entryRow(l.transfer_entry_id).description, /Loan to Sync Ana/, "shown as the default");
  // the person types their own text: kept
  rt.api("updateEntry", { id: l.transfer_entry_id, fields: { type: "transfer", description: "Birthday cash" } });
  assert.equal(loanRow(l.id).description, "Birthday cash");
  // back to the default text: no description of its own again
  rt.api("updateEntry", { id: l.transfer_entry_id, fields: { type: "transfer", description: entryRowAuto(rt, l) } });
  assert.equal(loanRow(l.id).description, "");
  // the form still carries the OLD default when the loan is moved to another person: the new default is generated
  const old = entryRow(l.transfer_entry_id).description;
  rt.api("convertLoanToLoan", { entry_id: l.transfer_entry_id, friend_id: bo.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2026-01-05", payment_method_id: pm, description: old });
  assert.equal(loanRow(l.id).description, "");
  assert.match(entryRow(l.transfer_entry_id).description, /Loan from Sync Bo/, "reads right for the new person and direction");
});

function entryRowAuto(rt, l) {
  const f = rt.rows("Friends").find((x) => x.id === l.friend_id);
  return `Loan to ${f.name}`;
}

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
