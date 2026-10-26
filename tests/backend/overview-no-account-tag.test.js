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

test("investment flows are per platform and per currency, never converted", () => {
  const { rt } = freshApp({ small: true });
  const range = { startDate: today(), endDate: today() };
  const before = rt.api("getPeriodSummary", range).investmentsByPlatform;
  const meta = rt.api("getMeta");
  const cat = meta.categories.find((c) => c.type === "investment");
  const from = meta.paymentMethods.find((p) => p.type !== "investment");
  const plat = meta.paymentMethods.find((p) => p.type === "investment");
  const mk = (amount, currency) => rt.api("createEntry", { type: "investment", date: today(), category_id: cat.id, status: "confirmed", paid_by: "me", amount, currency, description: "dep", payment_method_id: from.id, to_payment_method_id: plat.id });
  mk(100, "PEN"); mk(-30, "PEN"); mk(50, "USD");
  const row = rt.api("getPeriodSummary", range).investmentsByPlatform.find((r) => r.id === plat.id);
  const base = (before.find((r) => r.id === plat.id) || { lines: [] }).lines;
  const get = (lines, c) => (lines.find((l) => l.currency === c) || { amount: 0 }).amount;
  assert.equal(get(row.lines, "PEN") - get(base, "PEN"), 70);
  assert.equal(get(row.lines, "USD") - get(base, "USD"), 50);
});
