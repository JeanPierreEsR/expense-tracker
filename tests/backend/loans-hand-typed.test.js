// Rows typed by hand in the Loans tab (Ingrid, 2026-11-09): a clear amount is read, an unclear one is not guessed and is named instead of
// silently vanishing; "usd" is USD; a NaN never reaches a total. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const setup = () => {
  const { rt, data } = freshApp({ entries: 5 });
  const friendId = rt.api("addFriend", { name: "Sheet Pal" }).id;
  const add = (id, amount, currency = "PEN") => rt.run(`appendRowObject('Loans', ${JSON.stringify({ id, friend_id: friendId, direction: "they_owe_me", origin: "manual", amount, currency, date: "2026-10-01", status: "open" })})`);
  const list = () => rt.api("listLoanBalances", { withUnreadable: true });
  const mine = () => (list().balances.find((b) => b.friend_id === friendId) || { balances: [] }).balances;
  return { rt, data, friendId, add, list, mine };
};
const net = (lines, cur) => (lines.find((l) => l.currency === cur) || {}).net;

test("a clear text amount is read as its number", () => {
  const { add, mine } = setup();
  add("h1", "1,200.50");
  add("h2", "1.000,25");
  add("h3", "12,50");
  assert.ok(Math.abs(net(mine(), "PEN") - 2213.25) < 0.001);
});

test("an unclear amount is not guessed, not counted, and is named", () => {
  const { add, mine, list } = setup();
  add("ok", 100);
  add("b1", "1,200");
  add("b2", "abc");
  add("b3", -50);
  assert.equal(net(mine(), "PEN"), 100);
  assert.deepEqual(list().unreadable.filter((u) => u.friend_name === "Sheet Pal").map((u) => u.amount).sort(), ["-50", "1,200", "abc"]);
});

test("a lower-case currency is that currency; free text is named, not a new currency", () => {
  const { add, mine, list } = setup();
  add("u1", 200, "usd");
  add("u2", 300, "soles");
  assert.equal(net(mine(), "USD"), 200);
  assert.equal(net(mine(), "SOLES"), undefined);
  assert.equal(list().unreadable.filter((u) => u.currency === "soles").length, 1);
});

test("the person's screen has no unreadable row, and other callers keep the plain list", () => {
  const { rt, add, friendId } = setup();
  add("ok", 100);
  add("b1", "abc");
  const detail = rt.api("getFriendLoanDetail", { friendId });
  const loans = detail.loans || detail;
  assert.equal(loans.length, 1);
  assert.ok(Array.isArray(rt.api("listLoanBalances", {})));
});

test("a hand-typed direction is read when it clearly names one; anything else is named, never guessed as 'You owe' (1.76.1)", () => {
  const { rt, friendId, mine, list } = setup();
  const addDir = (id, direction, amount) => rt.run(`appendRowObject('Loans', ${JSON.stringify({ id, friend_id: friendId, direction, origin: "manual", amount, currency: "PEN", date: "2026-10-01", status: "open" })})`);
  addDir("d1", "They owe me", 50);
  addDir("d2", " I owe them ", 20);
  addDir("d3", "lent", 70);
  assert.equal(net(mine(), "PEN"), 30);
  assert.deepEqual(list().unreadable.filter((u) => u.friend_name === "Sheet Pal").map((u) => u.amount), ["70"]);
});

test("a repayment row whose amount cannot be read is named on Home; a clear one is not (testers, 2026-11-11)", () => {
  const { rt, friendId, add } = setup();
  add("L1", 500);
  const st = (id, amount) => rt.run(`appendRowObject('Settlements', ${JSON.stringify({ id, loan_id: "L1", date: "2026-10-05", amount, payment_method_id: "" })})`);
  st("s-ok", "1,234.50");
  st("s-bad", "1,234");
  const u = rt.api("getHomeGlance", {}).unreadable;
  const mine = (u ? u.rows : []).filter((r) => r.sheet === "Settlements");
  assert.equal(mine.length, 1, JSON.stringify(u));
  assert.equal(mine[0].value, "1,234");
  assert.equal(mine[0].field, "amount");
  assert.equal(mine[0].description, "Sheet Pal");
  assert.match(mine[0].cell, /^[A-Z]+\d+$/);
});
