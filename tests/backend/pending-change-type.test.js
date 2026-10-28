// Every kind of WAITING (Needs review) entry changed into every other type, then confirmed — what the card's Change type
// button does (updateEntry with the new type, then confirmEntry) — and the same waiting entries turned into a loan or
// repayment (what the card's Mark as repayment / Convert to loan windows do). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

function setup() {
  const { rt, data } = freshApp();
  const pm = data.pms[3].id, other = data.pms[4].id;
  const broker = rt.api("addPaymentMethod", { nickname: "Pending Broker " + Math.random().toString(36).slice(2, 6), type: "investment" });
  const cat = (type) => data.cats.find((c) => c.type === type);
  const waiting = (fields) => {
    const e = Object.assign({ id: "w-" + Math.random().toString(36).slice(2, 10), type: "expense", date: today(), amount: 100, currency: "PEN", category_id: "",
      description: "Waiting", paid_by: "me", status: "pending", source: "email", created_at: new Date().toISOString() }, fields);
    rt.run(`appendRowObject('Entries', ${JSON.stringify(e)});`);
    return e;
  };
  const row = (id) => rt.rows("Entries").find((e) => e.id === id);
  return { rt, pm, other, broker, cat, waiting, row };
}

// What the form sends for each target type (the same field set as the confirm form).
function fieldsFor(target, { pm, other, broker, cat }, wasArrival) {
  if (target === "expense") return { type: "expense", category_id: cat("expense").id, payment_method_id: pm, to_payment_method_id: "" };
  if (target === "income") return { type: "income", category_id: cat("income").id, payment_method_id: pm, to_payment_method_id: "" };
  if (target === "transfer") return { type: "transfer", category_id: cat("transfer").id, payment_method_id: pm, to_payment_method_id: other };
  return { type: "investment", amount: wasArrival ? -100 : 100, payment_method_id: pm, to_payment_method_id: broker.id };
}

const KINDS = {
  "expense": (s) => s.waiting({ type: "expense", payment_method_id: s.pm }),
  "income": (s) => s.waiting({ type: "income", payment_method_id: s.pm }),
  "transfer, only a From": (s) => s.waiting({ type: "transfer", category_id: s.cat("transfer").id, payment_method_id: s.pm }),
  "transfer, only a To": (s) => s.waiting({ type: "transfer", category_id: s.cat("transfer").id, to_payment_method_id: s.pm }),
  "transfer, both": (s) => s.waiting({ type: "transfer", category_id: s.cat("transfer").id, payment_method_id: s.pm, to_payment_method_id: s.other }),
  "investment deposit": (s) => s.waiting({ type: "investment", amount: 100, payment_method_id: s.pm, to_payment_method_id: s.broker.id }),
  "investment withdrawal": (s) => s.waiting({ type: "investment", amount: -100, payment_method_id: s.pm, to_payment_method_id: s.broker.id }),
  "exchange side (out)": (s) => s.waiting({ type: "transfer", category_id: s.cat("transfer").id, payment_method_id: s.pm, exchange: "1" }),
  "exchange side (in)": (s) => s.waiting({ type: "transfer", category_id: s.cat("transfer").id, to_payment_method_id: s.pm, exchange: "1" }),
};

for (const [kind, make] of Object.entries(KINDS)) {
  for (const target of ["expense", "income", "investment", "transfer"]) {
    const sameType = /^(expense|income)$/.test(kind) ? kind === target : kind.startsWith(target);
    if (sameType) continue;
    test(`a waiting ${kind} changed to ${target} and confirmed`, () => {
      const s = setup();
      rt_ensureExchangeColumn(s.rt);
      const e = make(s);
      const arrival = /withdrawal|only a To|\(in\)|^income$/.test(kind);
      rt_update(s, e, fieldsFor(target, s, arrival));
      const done = s.row(e.id);
      assert.equal(done.status, "confirmed");
      assert.equal(done.type, target);
      if (target === "investment") assert.equal(Number(done.amount) < 0, arrival);
      if (target !== "transfer") assert.ok(!done.exchange, "the exchange marker is gone");
      if (target === "income" || target === "expense") assert.equal(done.payment_method_id, s.pm);
    });
  }
}

function rt_ensureExchangeColumn(rt) { rt.run("ensureEntriesExchangeColumn_();"); }
function rt_update(s, e, fields) {
  s.rt.api("updateEntry", { id: e.id, fields });
  s.rt.api("confirmEntry", { id: e.id });
}

test("a waiting entry becomes a loan or repayment atomically, whatever its type, following the money direction", () => {
  const s = setup();
  const friend = s.rt.api("addFriend", { name: "Pending Friend " + Math.random().toString(36).slice(2, 6) });
  const base = (e, extra) => ({ entry_id: e.id, friend_id: friend.id, amount: Math.abs(e.amount), currency: "PEN", date: today(), payment_method_id: s.pm, ...extra });
  const cases = [
    ["expense", (e) => s.rt.api("convertEntryToLoan", base(e, { direction: "they_owe_me" })), "they_owe_me"],
    ["income", (e) => s.rt.api("convertEntryToLoan", base(e, { direction: "i_owe_them" })), "i_owe_them"],
    ["investment", (e) => s.rt.api("convertEntryToLoan", base(e, { direction: "they_owe_me" })), "they_owe_me"],
  ];
  for (const [type, run, direction] of cases) {
    const e = s.waiting({ type, amount: 100, payment_method_id: s.pm, to_payment_method_id: type === "investment" ? s.broker.id : "" });
    const res = run(e);
    assert.equal(res.loan.direction, direction);
    assert.equal(s.row(e.id), undefined, `${type}: the waiting entry is gone`);
    assert.equal(s.row(res.loan.transfer_entry_id).payment_method_id, s.pm, `${type}: the account is kept`);
  }
});

test("a refused swap leaves the waiting entry exactly as it was", () => {
  const s = setup();
  const friend = s.rt.api("addFriend", { name: "Pending Friend " + Math.random().toString(36).slice(2, 6) });
  const e = s.waiting({ type: "income", amount: 70, payment_method_id: s.pm });
  assert.throws(() => s.rt.api("convertEntryToRepayment", { entry_id: e.id, friend_id: friend.id, direction: "they_owe_me", amount: 70, currency: "PEN", date: today(), payment_method_id: s.pm, require_owed: true, overpay_pending_ok: true }));
  assert.equal(s.row(e.id).status, "pending");
  assert.equal(s.row(e.id).type, "income");
});
