// Home's "+" → Repayment when nothing is owed that way (owner, 2026-11-12): the server says so first, writing nothing,
// and the person picks: a debt from before the app (saved with the repayment, one request), an expense / income, or back.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const f = rt.api("addFriend", { name: "Owed Friend " + Math.random().toString(36).slice(2, 6) });
  const repay = (direction, amount, extra = {}) =>
    rt.api("recordRepayment", { friend_id: f.id, direction, amount, currency: "PEN", date: today(), payment_method_id: data.pms[3].id, ...extra });
  const loansOf = () => rt.rows("Loans").filter((l) => l.friend_id === f.id);
  const entriesOf = () => rt.rows("Entries").filter((e) => String(e.description || "").includes(f.name));
  return { rt, data, f, repay, loansOf, entriesOf };
}

test("nothing owed: the check answers nothing_owed and writes nothing", () => {
  const { rt, repay, loansOf, entriesOf } = setup();
  const before = rt.rows("Entries").length;
  const res = repay("i_owe_them", 200, { ask_if_nothing_owed: true });
  assert.equal(res.nothing_owed, true);
  assert.equal(rt.rows("Entries").length, before);
  assert.equal(loansOf().length, 0);
  assert.equal(entriesOf().length, 0);
});

test("a debt only the other way still counts as nothing owed this way", () => {
  const { rt, f, repay } = setup();
  rt.api("addLoan", { friend_id: f.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", opening: true });
  assert.equal(repay("i_owe_them", 50, { ask_if_nothing_owed: true }).nothing_owed, true);
});

test("something owed: the check is ignored and the repayment is recorded as usual", () => {
  const { rt, f, repay } = setup();
  rt.api("addLoan", { friend_id: f.id, direction: "i_owe_them", amount: 100, currency: "PEN", date: "2026-01-01", opening: true });
  const res = repay("i_owe_them", 60, { ask_if_nothing_owed: true });
  assert.ok(!res.nothing_owed);
  assert.equal(res.overpaid, 0);
  assert.equal(rt.api("listLoanBalances", {}).find((b) => b.friend_id === f.id).balances[0].net, -40);
});

test("a debt from before the app saved with its repayment: it is paid, nothing extra, one money entry", () => {
  const { rt, f, repay, loansOf, entriesOf } = setup();
  const res = repay("i_owe_them", 200, { opening_loan: { amount: 500, date: "2025-06-01" } });
  assert.equal(res.overpaid, 0);
  const loans = loansOf();
  assert.equal(loans.length, 1);
  assert.equal(String(loans[0].opening), "1");
  assert.equal(loans[0].payment_method_id, "");
  assert.equal(loans[0].direction, "i_owe_them");
  assert.equal(res.opening_loan_id, loans[0].id);
  assert.equal(rt.api("listLoanBalances", {}).find((b) => b.friend_id === f.id).balances[0].net, -300);
  const money = entriesOf();
  assert.equal(money.length, 1);
  assert.equal(money[0].type, "transfer");
  assert.equal(Number(money[0].amount), 200);
});

test("a debt from before dated after the repayment is refused, nothing saved", () => {
  const { repay, loansOf, entriesOf } = setup();
  assert.throws(() => repay("they_owe_me", 50, { opening_loan: { amount: 50, date: "2999-01-01" } }), /before/);
  assert.equal(loansOf().length, 0);
  assert.equal(entriesOf().length, 0);
});

test("a refused repayment takes the new debt from before away again", () => {
  const { repay, loansOf } = setup();
  assert.throws(() => repay("they_owe_me", 50, { opening_loan: { amount: 50, date: "2025-01-01" }, allocations: [{ loan_id: "nope", amount: 5 }] }));
  assert.equal(loansOf().length, 0);
});

test("saved as an expense / income when nothing was owed: it reads as money to / from the person, not an overpayment", () => {
  const { repay, entriesOf, f } = setup();
  repay("i_owe_them", 40, { nothing_owed_entry: true });
  repay("they_owe_me", 30, { nothing_owed_entry: true, description: "Gift back" });
  const rows = entriesOf();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "Money to " + f.name);
  assert.equal(rows[0].type, "expense");
  assert.equal(rows[0].status, "pending");
});

// "From before the app" dates start the day before first use (owner, 2026-11-12): getMeta's firstUseDate.
test("first use: the day the welcome was first answered, kept in Settings", () => {
  const { rt } = setup();
  rt.run("setSetting_('first_use_date', ''); setSetting_('onboarded_at', String(new Date(2026, 8, 15, 12).getTime()));");
  assert.equal(rt.api("getMeta").firstUseDate, "2026-09-15");
  rt.run("setSetting_('onboarded_at', String(new Date(2026, 9, 1, 12).getTime()));");
  assert.equal(rt.api("getMeta").firstUseDate, "2026-09-15", "found once, then kept");
});

test("first use without a welcome answer: the earliest entry recorded through the app, imported history left out", () => {
  const { rt } = setup();
  const earliest = (pred) => rt.rows("Entries").filter(pred).map((e) => String(e.date).slice(0, 10)).sort()[0];
  const want = earliest((e) => e.source !== "import" && e.source !== "practice");
  rt.run("setSetting_('first_use_date', ''); setSetting_('onboarded_at', '');");
  assert.equal(rt.api("getMeta").firstUseDate, want);
});
