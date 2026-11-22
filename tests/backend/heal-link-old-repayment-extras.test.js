// Heal 'link-old-repayment-extras' (2026-11-10): repayments saved before 2026-10-27 that came in as two entries (the loan part + an
// extra income/expense) had no link between the two, so a bank statement's single line for the total showed as "not in the app".
// The heal links every unambiguous one once, on the first open after the update. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

// A repayment of 130 for a 100 debt (100 on the loan, 30 extra income), then its link removed, as if saved before the link existed.
function oldRepayment(rt, data, name, date) {
  const friend = rt.api("addFriend", { name: name + " " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date, currency: "PEN", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  return friend;
}
const unlinkAll = (rt) => rt.run("(function () { var sh = getSheet('Settlements'); var h = getHeaders(sh);" +
  " getAllRows('Settlements').forEach(function (s) { setCellByRow_(sh, h, findRowIndexById(sh, h, s.id), 'gap_entry_id', ''); }); return 1; })()");
const linked = (rt) => rt.rows("Settlements").filter((s) => s.gap_entry_id).length;
const totals = (rt) => JSON.parse(rt.run("JSON.stringify(buildRepaymentTotalsForMatching_())"));

test("the first open after the update links an old repayment's extra entry, so a statement can match the total", () => {
  const { rt, data } = freshApp();
  oldRepayment(rt, data, "Ana Lo", "2026-03-01");
  unlinkAll(rt);
  rt.svc.props.set("HEALS_DONE", "");
  assert.equal(linked(rt), 0);
  assert.deepEqual(totals(rt), {}, "before: the statement matcher cannot see the 130 total");
  const entriesBefore = JSON.stringify(rt.rows("Entries"));

  rt.api("getMeta", {});

  assert.equal(linked(rt), 1, "linked again");
  const t = Object.values(totals(rt));
  assert.equal(t.length, 1);
  assert.equal(t[0].total, 130, "the bank's single line (130) now matches the two entries");
  assert.equal(JSON.stringify(rt.rows("Entries")), entriesBefore, "no entry changed");
  assert.ok(rt.svc.props.get("HEALS_DONE").split(",").includes("link-old-repayment-extras"));
});

test("an ambiguous case (two repayments from one person on the same day and account) is left alone", () => {
  const { rt, data } = freshApp();
  const friend = oldRepayment(rt, data, "Ben Ro", "2026-03-01");
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-02", payment_method_id: data.pms[3].id, description: "Second loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  unlinkAll(rt);
  rt.svc.props.set("HEALS_DONE", "");
  rt.api("getMeta", {});
  assert.equal(linked(rt), 0, "nothing guessed");
});
