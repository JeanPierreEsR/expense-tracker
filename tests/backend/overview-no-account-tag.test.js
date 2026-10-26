// Overview pies cover the whole total: entries with no tag / no account get their own slice,
// and investments are broken down by platform. Made-up data only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshApp, today } = require("./helpers");

test("by-account and by-tag pies add up to the total (No account / Untagged slices)", () => {
  const { rt } = freshApp({ small: true });
  const range = { startDate: today(), endDate: today() };
  const pie = (t, key) => rt.api("getPeriodSummary", range).breakdowns[t][key];
  const sum = (l) => l.reduce((a, i) => a + i.amount_pen, 0);
  const meta = rt.api("getMeta");
  const cat = meta.categories.find((c) => c.type === "expense");
  const pm = meta.paymentMethods.find((p) => p.type !== "investment");
  const mk = (o) => rt.api("createEntry", Object.assign({ type: "expense", date: today(), category_id: cat.id, status: "confirmed", paid_by: "me", amount: 10, currency: "PEN", description: "x" }, o));
  mk({ payment_method_id: pm.id });
  mk({});                       // no account
  mk({ paid_by: "friend" });    // a friend paid: not one of my accounts
  const total = rt.api("getPeriodSummary", range).totals.expense;
  assert.ok(total >= 30);
  assert.equal(Math.round(sum(pie("expense", "byPaymentMethod")) * 100), Math.round(total * 100));
  assert.equal(Math.round(sum(pie("expense", "byTag")) * 100), Math.round(total * 100), "no tags used: all of it is Untagged");
  const none = pie("expense", "byPaymentMethod").find((i) => i.id === "");
  assert.equal(none.name, "No account");
  assert.ok(none.amount_pen >= 20);
  // the drill-down lists exactly those entries
  const listed = rt.api("listEntries", Object.assign({ type: "expense", noAccount: true }, range));
  assert.ok(listed.every((e) => !(e.paid_by === "me" && e.payment_method_id)));
  const untagged = rt.api("listEntries", Object.assign({ type: "expense", noTag: true }, range));
  assert.ok(untagged.length >= 3);
});
