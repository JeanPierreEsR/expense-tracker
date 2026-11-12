// Overview's summary blocks open the list behind them (listPeriodFlows, 2026-11-11). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
const all = (rt, filter) => {
  let items = [], offset = 0, page;
  do { page = rt.api("listPeriodFlows", { ...range, filter, offset, limit: 40 }); items = items.concat(page.items); offset += 40; } while (page.more);
  return items;
};
const ownPen = (e) => (e.own_share_pen != null ? e.own_share_pen : e.amount_pen);

test("each type's list holds exactly the entries its block adds up", () => {
  const { rt } = freshApp({ entries: 400 });
  const t = rt.api("getPeriodSummary", range).totals;
  for (const type of ["income", "expense", "investment"]) {
    const items = all(rt, type);
    assert.ok(items.every((x) => x.entry && x.entry.type === type), type + ": only its own entries");
    const sum = items.reduce((s, x) => s + ownPen(x.entry), 0);
    assert.ok(Math.abs(sum - t[type]) < 0.05, `${type}: list ${sum} = block ${t[type]}`);
  }
});

test("the loan movements add up to the Loans block, signed by the money in the owner's pocket", () => {
  const { rt } = freshApp({ entries: 5 });
  const ana = rt.api("addFriend", { name: "Ana" });
  rt.api("addLoan", { friend_id: ana.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-10-05" });
  rt.api("recordRepayment", { friend_id: ana.id, direction: "they_owe_me", amount: 50, currency: "PEN", date: "2026-10-06" });
  const moves = all(rt, "loans").map((x) => x.loan);
  assert.deepEqual(moves.map((m) => [m.kind, m.signed, m.date, m.friend_name]),
    [["receivedBack", 50, "2026-10-06", "Ana"], ["lent", -200, "2026-10-05", "Ana"]], "newest first");
  assert.equal(moves.reduce((s, m) => s + m.signed, 0), rt.api("getPeriodSummary", range).totals.loans);
});

test("'all' mixes entries and loan movements newest first and pages without losing or repeating any", () => {
  const { rt } = freshApp({ entries: 300 });
  const bo = rt.api("addFriend", { name: "Bo" });
  rt.api("addLoan", { friend_id: bo.id, direction: "i_owe_them", amount: 70, currency: "PEN", date: "2026-10-15" });
  const items = all(rt, "all");
  const dates = items.map((x) => String((x.entry || x.loan).date).substring(0, 10));
  assert.deepEqual(dates, [...dates].sort().reverse(), "newest first");
  const n = ["income", "expense", "investment"].reduce((s, f) => s + all(rt, f).length, 0) + all(rt, "loans").length;
  assert.equal(items.length, n, "every entry and movement once");
  assert.equal(new Set(items.filter((x) => x.entry).map((x) => x.entry.id)).size, items.filter((x) => x.entry).length, "no repeats");
  assert.ok(items.some((x) => x.loan && x.loan.kind === "borrowed" && x.loan.signed === 70));
  assert.ok(!items.some((x) => x.entry && x.entry.type === "transfer"), "transfers are never in it");
});
