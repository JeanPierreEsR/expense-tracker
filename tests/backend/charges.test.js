// What the card really charged (owner, 2026-11-06): the charge is the entry's amount, what was paid is optional, a friend's debt stays in what was paid.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const setup = () => {
  const { rt } = freshApp({ small: true });
  const card = rt.api("savePaymentMethod", { nickname: "Tarjeta X", type: "credit", currencies: ["USD"] });
  globalThis.__chargesRt = rt;
  return { rt, card };
};
const daysAgo = (n) => globalThis.__chargesRt.run(`formatCalendarDate_(new Date(Date.now() - ${n} * 86400000))`);
const addPending = (rt, card, extra = {}) => rt.api("saveEntryAll", { kind: "create", fields: Object.assign({
  type: "expense", date: daysAgo(3), amount: 30000, currency: "ARS", description: "Hotel", paid_by: "me", payment_method_id: card.id, charge_pending: "1" }, extra), splits: extra.splits });
const row = (rt, id) => rt.rows("Entries").find((e) => e.id === id);

test("a purchase with no charge yet is an ordinary entry in what was paid, marked as pending, listed and counted on Home", () => {
  const { rt, card } = setup();
  const e = addPending(rt, card);
  assert.equal(row(rt, e.id).charge_pending, "1");
  assert.equal(row(rt, e.id).currency, "ARS");
  const list = rt.api("listPendingCharges", {});
  assert.equal(list.length, 1);
  assert.equal(list[0].account, "Tarjeta X");
  assert.equal(list[0].old, false);
  assert.deepEqual(rt.api("getHomeGlance", {}).charges, { count: 1, old: 0 });
});

test("filling it in: the charge becomes the amount, what was paid moves aside", () => {
  const { rt, card } = setup();
  const e = addPending(rt, card);
  rt.api("fillEntryCharge", { id: e.id, amount: 21, currency: "USD" });
  const after = row(rt, e.id);
  assert.equal(Number(after.amount), 21);
  assert.equal(after.currency, "USD");
  assert.equal(Number(after.paid_amount), 30000);
  assert.equal(after.paid_currency, "ARS");
  assert.ok(!after.charge_pending);
  assert.equal(rt.api("listPendingCharges", {}).length, 0);
  // a repeat changes nothing
  rt.api("fillEntryCharge", { id: e.id, amount: 22, currency: "USD" });
  assert.equal(Number(row(rt, e.id).amount), 21);
});

test("a shared expense: the split follows the charge, the friend's debt stays in ARS, to the cent, whatever the charge is", () => {
  for (const charge of [21, 21.37, 19.99]) {
    const { rt, card } = setup();
    const friend = rt.api("addFriend", { name: "Ana Lo" });
    const e = addPending(rt, card, { splits: [{ friend_id: friend.id, amount: 10000 }] });
    const before = rt.rows("Loans").filter((l) => l.entry_id === e.id);
    assert.equal(before.length, 1);
    assert.equal(before[0].currency, "ARS");
    rt.api("fillEntryCharge", { id: e.id, amount: charge, currency: "USD" });
    const loans = rt.rows("Loans").filter((l) => l.entry_id === e.id);
    assert.equal(loans.length, 1);
    assert.equal(loans[0].currency, "ARS");
    assert.equal(Number(loans[0].amount), 10000);
    const split = rt.rows("Entry Splits").find((s) => s.entry_id === e.id);
    assert.ok(Math.abs(Number(split.amount) - charge / 3) < 0.00001);
    // saving the entry's split again (an edit) leaves the debt where it is
    rt.api("saveEntrySplits", { entryId: e.id, splits: [{ friend_id: friend.id, amount: Number(split.amount) }] });
    assert.equal(Number(rt.rows("Loans").filter((l) => l.entry_id === e.id)[0].amount), 10000);
  }
});

test("money already repaid keeps counting after the charge is filled in, and a balance marks what is waiting", () => {
  const { rt, card } = setup();
  const friend = rt.api("addFriend", { name: "Ana Lo" });
  const cash = rt.rows("Payment Methods").find((p) => p.id !== card.id);
  const e = addPending(rt, card, { splits: [{ friend_id: friend.id, amount: 10000 }] });
  rt.api("setPaymentMethodOpeningBalance", { id: card.id, balances: [{ currency: "USD", amount: 0, date: "2020-01-01" }] });
  const waiting = rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances.find((b) => b.currency === "ARS");
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.amount, -30000);
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 4000, currency: "ARS", date: daysAgo(1), payment_method_id: cash.id });
  rt.api("fillEntryCharge", { id: e.id, amount: 21, currency: "USD" });
  const owed = rt.api("listLoanBalances", {});
  assert.match(JSON.stringify(owed), /6000/, "ARS 6,000 still owed");
  const lines = rt.api("listPaymentMethodBalances", {}).find((b) => b.id === card.id).balances;
  assert.equal(lines.find((b) => b.currency === "USD").amount, -21);
  assert.ok(!lines.some((b) => b.waiting));
});

test("Keep in ARS stops asking; the entry stays as it is", () => {
  const { rt, card } = setup();
  const e = addPending(rt, card);
  rt.api("keepEntryCharge", { id: e.id });
  assert.equal(rt.api("listPendingCharges", {}).length, 0);
  assert.equal(Number(row(rt, e.id).amount), 30000);
  assert.equal(row(rt, e.id).currency, "ARS");
});

test("45 days: Home's card says so, and Telegram tells once per card, never again", () => {
  const { rt, card } = setup();
  const sent = rt.run(`(function () { var out = []; sendTelegramText_ = function (t) { out.push(t); return true; }; globalThis.__sent = out; return out.length; })()`);
  assert.equal(sent, 0);
  addPending(rt, card, { date: daysAgo(44) });
  assert.equal(rt.run("notifyOldPendingCharges_()"), 0);
  addPending(rt, card, { date: daysAgo(45), description: "Cena" });
  addPending(rt, card, { date: daysAgo(60), description: "Taxi" });
  assert.deepEqual(rt.api("getHomeGlance", {}).charges, { count: 3, old: 2 });
  assert.equal(rt.run("notifyOldPendingCharges_()"), 1);
  assert.equal(rt.run("globalThis.__sent.length"), 1);
  assert.match(rt.run("globalThis.__sent[0]"), /Tarjeta X/);
  assert.equal(rt.run("notifyOldPendingCharges_()"), 0, "never repeated");
});

test("a trip in what was paid uses what was paid", () => {
  const { rt } = setup();
  const row = rt.run(`tripAmountIn_('ARS', { currency: 'USD', own: 14, paidCurrency: 'ARS', paidOwn: 20000 })`);
  assert.equal(row, 20000);
});
