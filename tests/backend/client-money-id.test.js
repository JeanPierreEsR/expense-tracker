// Money saves the phone sends from its background queue carry their own id (client_id): sending one again — a lost
// reply, the app closed mid-save — never makes a second loan, exchange, overpayment entry or forgiving.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const ID = "aaaaaaaa-2222-4333-8444-555555555551";

function friendOf(rt) {
  return rt.rows("Friends")[0];
}

test("addLoan keeps the phone's id and answers a repeat with the same loan", () => {
  const { rt } = freshApp({ entries: 20 });
  const payload = { friend_id: friendOf(rt).id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-20", client_id: ID };
  const before = rt.rows("Loans").length;
  const first = rt.api("addLoan", payload);
  assert.equal(first.id, ID);
  const again = rt.api("addLoan", payload);
  assert.equal(again.id, ID);
  assert.equal(rt.rows("Loans").length, before + 1, "one loan, not two");
});

test("addLoan without a usable client_id behaves as before", () => {
  const { rt } = freshApp({ entries: 20 });
  const base = { friend_id: friendOf(rt).id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-20" };
  const a = rt.api("addLoan", { ...base, client_id: "nope" });
  const b = rt.api("addLoan", base);
  assert.notEqual(a.id, "nope");
  assert.notEqual(a.id, b.id);
});

test("recordCurrencyExchange with a client_id makes two legs once, however often it is sent", () => {
  const { rt } = freshApp({ entries: 20 });
  const accounts = rt.rows("Payment Methods");
  const payload = {
    date: "2026-10-20", client_id: ID,
    out: { payment_method_id: accounts[0].id, amount: 370, currency: "PEN" },
    in: { payment_method_id: accounts[1].id, amount: 100, currency: "USD" }
  };
  const before = rt.rows("Entries").length;
  const first = rt.api("recordCurrencyExchange", payload);
  assert.equal(first.out.id, ID);
  assert.notEqual(first.in.id, ID);
  const again = rt.api("recordCurrencyExchange", payload);
  assert.equal(again.out.id, first.out.id);
  assert.equal(again.in.id, first.in.id);
  assert.equal(rt.rows("Entries").length, before + 2, "two legs, not four");
});

test("forgiveLoan with a client_id forgives once: a partial forgiving sent twice takes only one part", () => {
  const { rt } = freshApp({ entries: 20 });
  const loan = rt.api("addLoan", { friend_id: friendOf(rt).id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-20" });
  const category = rt.rows("Categories").find((c) => c.type === "expense").id;
  const payload = { id: loan.id, amount: 30, category_id: category, date: "2026-10-21", client_id: ID };
  const first = rt.api("forgiveLoan", payload);
  assert.equal(first.partial, true);
  assert.equal(first.entry.id, ID);
  const again = rt.api("forgiveLoan", payload);
  assert.equal(again.repeat, true);
  assert.equal(rt.rows("Entries").filter((e) => e.id === ID).length, 1, "one forgiving entry");
  const stored = rt.rows("Loans").find((l) => l.id === loan.id);
  assert.equal(JSON.parse(stored.forgiven_parts).length, 1, "one forgiven part, not two");
});

test("the overpayment entry takes the phone's id and a repeat answers with it", () => {
  const { rt } = freshApp({ entries: 20 });
  const category = rt.rows("Categories").find((c) => c.type === "income").id;
  const payload = { friend_id: friendOf(rt).id, amount: 12, currency: "PEN", date: "2026-10-20", category_id: category, client_id: ID };
  const first = rt.api("recordOverpaymentIncome", payload);
  assert.equal(first.id, ID);
  const again = rt.api("recordOverpaymentIncome", payload);
  assert.equal(again.id, ID);
  assert.equal(rt.rows("Entries").filter((e) => e.id === ID).length, 1);
});

test("recordRepayment with a client_id applies once: sent twice, one transfer and one set of settlements", () => {
  const { rt } = freshApp({ entries: 20 });
  const loan = rt.api("addLoan", { friend_id: friendOf(rt).id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-20" });
  const payload = { friend_id: loan.friend_id, direction: "they_owe_me", amount: 40, currency: "PEN", date: "2026-10-21", client_id: ID };
  const entries = rt.rows("Entries").length;
  const settlements = rt.rows("Settlements").length;
  const first = rt.api("recordRepayment", payload);
  assert.equal(first.overpaid, 0);
  assert.equal(rt.rows("Entries").length, entries + 1);
  const again = rt.api("recordRepayment", payload);
  assert.equal(again.repeat, true);
  assert.equal(rt.rows("Entries").length, entries + 1, "no second transfer");
  assert.equal(rt.rows("Settlements").length, settlements + 1, "no second settlement");
});

test("recordRepayment with a client_id, paying more than owed: the extra is made once", () => {
  const { rt } = freshApp({ entries: 20 });
  const loan = rt.api("addLoan", { friend_id: friendOf(rt).id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-10-20" });
  const payload = { friend_id: loan.friend_id, direction: "they_owe_me", amount: 130, currency: "PEN", date: "2026-10-21", client_id: ID };
  const entries = rt.rows("Entries").length;
  const first = rt.api("recordRepayment", payload);
  assert.ok(first.overpaid > 29.9 && first.overpaid < 30.1);
  const after = rt.rows("Entries").length;
  assert.equal(after, entries + 2, "the payment and the extra");
  rt.api("recordRepayment", payload);
  assert.equal(rt.rows("Entries").length, after);
});

test("the backend says it can take a client id for money saves", () => {
  const { rt } = freshApp({ entries: 20 });
  assert.equal(rt.api("getMeta", {}).capabilities.clientMoneyId, true);
});
