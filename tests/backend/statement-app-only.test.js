// "In the app but not on this statement" (2026-11-10): when a statement's closing balance leaves something unexplained, the check also
// lists what the app counts on that account in the statement's period that no line explains, and what is still left after that.
// Made-up accounts and amounts only (the owner's case: a currency exchange's USD 1,000 recorded on the wrong account).
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const run = (rt, js) => JSON.parse(rt.run(`JSON.stringify(${js})`));

function check(rt, extra) {
  const pm = { id: "pm-a", nickname: "Savings A" };
  const e = (id, date, type, amount, from, to, description) => ({ id, date, type, amount, currency: "USD", payment_method_id: from || "", to_payment_method_id: to || "", description: description || id, status: "confirmed" });
  const confirmed = [
    e("salary", "2019-03-02", "income", 500, "pm-a"),
    e("rent", "2019-03-05", "expense", 300, "pm-a"),
    e("exchange", "2019-03-06", "transfer", 1000, "", "pm-a", "Currency exchange — USD received"),   // the bank never had it here
    e("repay", "2019-03-08", "transfer", 266.66, "pm-a", ""), e("extra", "2019-03-08", "income", 0.34, "pm-a"),
    e("before", "2019-02-20", "expense", 50, "pm-a"),   // before the period: not this statement's business
    e("other", "2019-03-07", "expense", 70, "pm-b")    // another account
  ].concat(extra || []);
  const repayOut = run(rt, "signedEffectOnPaymentMethod_(" + JSON.stringify(confirmed[3]) + ", 'pm-a', {'repay': true})");
  assert.equal(repayOut, 266.66, "a repayment's money arrives on the account");
  const lines = [
    { date: "2019-03-02", description: "ABONO", amount: 500, currency: "USD", status: "matched", entry: { id: "salary" } },
    { date: "2019-03-05", description: "ALQUILER", amount: -300, currency: "USD", status: "matched", entry: { id: "rent" } },
    { date: "2019-03-08", description: "TRANSF ANA", amount: 267, currency: "USD", status: "matched", entry: { id: "repay" }, gapEntryId: "extra" },
    { date: "2019-03-20", description: "PAGO TOT TC", amount: -94.73, currency: "USD", status: "unregistered" }
  ];
  const args = { pm, currency: "USD", closing: 100 + 500 - 300 + 267 - 94.73, start: "2019-03-01", end: "2019-03-31", lines,
    openings: [{ currency: "USD", amount: 100, date: "2019-02-28" }], confirmed, inboundIds: { repay: true }, entryById: Object.fromEntries(confirmed.map((x) => [x.id, x])) };
  return run(rt, "stmtBalanceCheck_(" + JSON.stringify(args) + ")");
}

test("an unexplained difference lists the app's entries that no statement line explains", () => {
  const { rt } = freshApp({ small: true });
  const c = check(rt);
  assert.equal(c.direction, "forward");
  assert.equal(c.notInApp.net, -94.73);
  assert.equal(c.unexplained, -1000);
  assert.deepEqual(c.appOnly.items.map((i) => [i.id, i.amount]), [["exchange", 1000]], "the repayment's extra, other accounts and earlier days are not listed");
  assert.equal(c.appOnly.net, 1000);
  assert.equal(Math.round((c.unexplained + c.appOnly.net) * 100) / 100, 0, "nothing is left unexplained after it");
});

test("nothing is listed when the difference is fully explained", () => {
  const { rt } = freshApp({ small: true });
  const c = check(rt, [{ id: "x", date: "2019-03-06", type: "transfer", amount: 1000, currency: "USD", payment_method_id: "pm-a", to_payment_method_id: "", description: "undo", status: "confirmed" }]);
  assert.equal(c.unexplained, 0);
  assert.equal(c.appOnly, undefined);
});
