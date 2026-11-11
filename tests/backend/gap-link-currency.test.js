// The history's late linking of a repayment's extra entry (linkEarlierGapEntries_) must never pair a repayment with an extra entry in
// ANOTHER currency (pre-promote testers, 2026-11-10: a USD extra was shown under a PEN repayment as "+PEN 150.50"). Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp } = require("./helpers");

test("a USD extra on the same day and account is not linked to a PEN repayment", () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Ana Lo " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 200, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 100, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id });
  // No USD debt: all of it is an extra income in USD, same day, same account.
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 50, date: "2026-03-01", currency: "USD", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  const h = rt.api("getFriendRepaymentHistory", { friendId: friend.id });
  const pen = h.repayments.filter((r) => r.currency === "PEN");
  assert.equal(pen.length, 1);
  assert.ok(!pen[0].gap, "the PEN repayment has no extra: " + JSON.stringify(pen[0].gap));
  assert.ok(!rt.rows("Settlements").some((s) => s.gap_entry_id), "no link written to the Sheet");
});

test("the heal takes back a link made earlier across currencies, and only that one", () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Ben Ro " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  // A same-currency repayment with an extra: linked when saved, and must stay linked.
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  const good = rt.rows("Settlements").find((s) => s.gap_entry_id);
  assert.ok(good, "the PEN extra is linked when saved");
  // A wrong link, as the old late linking could write: a USD entry on a PEN repayment's row.
  const usd = rt.rows("Entries").find((e) => e.currency === "USD") || null;
  assert.ok(usd, "the demo data has a USD entry");
  rt.run("(function () { var sh = getSheet('Settlements'); var h = getHeaders(sh); var st = getAllRows('Settlements').filter(function (s) { return !s.gap_entry_id; })[0];" +
    " setCellByRow_(sh, h, findRowIndexById(sh, h, st.id), 'gap_entry_id', '" + usd.id + "'); return 1; })()");
  assert.equal(rt.rows("Settlements").filter((s) => s.gap_entry_id).length, 2);
  rt.svc.props.set("HEALS_DONE", "link-old-repayment-extras");
  rt.api("getMeta", {});
  const left = rt.rows("Settlements").filter((s) => s.gap_entry_id);
  assert.equal(left.length, 1, "only the cross-currency link is taken back");
  assert.equal(left[0].id, good.id);
});

test("a currency typed by hand in lower case or left blank never takes back a correct link", () => {
  const { rt, data } = freshApp();
  const friend = rt.api("addFriend", { name: "Cy Do " + Math.random().toString(36).slice(2, 7) });
  rt.api("addLoan", { friend_id: friend.id, direction: "they_owe_me", amount: 100, currency: "PEN", date: "2026-01-01", payment_method_id: data.pms[3].id, description: "Cash loan" });
  const cat = rt.rows("Categories").find((c) => c.type === "income").id;
  rt.api("recordRepayment", { friend_id: friend.id, direction: "they_owe_me", amount: 130, date: "2026-03-01", currency: "PEN", payment_method_id: data.pms[3].id, overpay_category_id: cat });
  const st = rt.rows("Settlements").find((s) => s.gap_entry_id);
  rt.run("(function () { var sh = getSheet('Entries'); var h = getHeaders(sh); setCellByRow_(sh, h, findRowIndexById(sh, h, '" + st.gap_entry_id + "'), 'currency', 'pen '); return 1; })()");
  rt.run("unlinkCrossCurrencyGapEntries_()");
  assert.equal(rt.rows("Settlements").find((s) => s.id === st.id).gap_entry_id, st.gap_entry_id, "lower case: kept");
  rt.run("(function () { var sh = getSheet('Entries'); var h = getHeaders(sh); setCellByRow_(sh, h, findRowIndexById(sh, h, '" + st.gap_entry_id + "'), 'currency', ''); return 1; })()");
  rt.run("unlinkCrossCurrencyGapEntries_()");
  assert.equal(rt.rows("Settlements").find((s) => s.id === st.id).gap_entry_id, st.gap_entry_id, "blank: kept");
});
